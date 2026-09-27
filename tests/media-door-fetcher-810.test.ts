// cf#810: the media doors get an in-process Fetcher seam, because the hostname shape #797
// specified cannot exist.
//
// THE PREMISE, so nobody re-derives it. vivijure-core is a LIBRARY running inside the
// `vivijure-studio` Worker. #797 planned to front the container with a ROUTE on that same Worker
// and point VIDEO_FINISH_URL at it. Cloudflare documents same-zone Worker-to-Worker global
// `fetch()` against a route as FAILING. So the door had to stop being a hostname.
//
// WHAT THESE ROWS HAVE TO SEE THAT A HAPPY-PATH TEST CANNOT: that the public path is not merely
// unused but UNREACHED. Several rows therefore replace `globalThis.fetch` with a spy that THROWS,
// so any surviving edge hop fails the test instead of quietly working in dev and failing on a
// same-zone deploy. A test that only asserted "the binding was called" would pass with a stray
// global fetch still in the code.
import { afterEach, describe, expect, it } from "vitest";
import {
  mediaDoorFetch,
  mediaDoorFetcher,
  mediaDoorReachable,
  MediaFinishAuthError,
  videoFinishReachable,
} from "../src/media-finish-auth.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { pollVideoFinishAsync } from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace global fetch with a landmine: touching the public path is the defect, so it throws. */
function forbidGlobalFetch(): { touched: () => boolean } {
  let touched = false;
  globalThis.fetch = (async (u: unknown) => {
    touched = true;
    throw new Error(`global fetch must not be used on the bound path (tried ${String(u)})`);
  }) as unknown as typeof fetch;
  return { touched: () => touched };
}

/** A door binding that records what it was asked for. */
function stubDoor(respond: () => Response = () => new Response("{}", { status: 200 })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetcher: { fetch: async (url: string, init?: RequestInit) => { calls.push({ url, init }); return respond(); } },
  };
}

describe("cf#810: reachability counts the binding, not just the hostname", () => {
  it("a bound door with NO URL is reachable", () => {
    // THE row that decides whether the feature works at all. Every phase gate in the orchestrators
    // calls videoFinishReachable; if the binding does not count, a studio with the container bound
    // and VIDEO_FINISH_URL unset degrades to "tier not installed" with the container sat right
    // there, working.
    const door = stubDoor();
    const env = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door.fetcher } } as unknown as Env;
    expect(videoFinishReachable(env)).toBe(true);
    expect(mediaDoorReachable(env, "VIDEO_FINISH_URL")).toBe(true);
  });

  it("CONTROL: an unbound door with no URL is still NOT reachable", () => {
    // Without this, the row above could pass because the function started returning true always.
    const env = {} as unknown as Env;
    expect(videoFinishReachable(env)).toBe(false);
    expect(mediaDoorReachable(env, "VIDEO_FINISH_URL")).toBe(false);
    expect(mediaDoorFetcher(env, "VIDEO_FINISH_URL")).toBeNull();
  });

  it("binding is per-door: binding video-finish does not make audio-mix reachable", () => {
    const env = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: stubDoor().fetcher } } as unknown as Env;
    expect(mediaDoorReachable(env, "VIDEO_FINISH_URL")).toBe(true);
    expect(mediaDoorReachable(env, "AUDIO_MIX_URL")).toBe(false);
  });
});

describe("cf#810: mediaDoorFetch prefers the binding and never touches the edge", () => {
  it("routes through the binding, with no DNS name and no global fetch", async () => {
    const guard = forbidGlobalFetch();
    const door = stubDoor();
    const env = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door.fetcher } } as unknown as Env;
    const resp = await mediaDoorFetch(env, "VIDEO_FINISH_URL", "/async/finish", { method: "POST" });
    expect(resp?.status).toBe(200);
    expect(door.calls.length).toBe(1);
    expect(door.calls[0].url).toBe("http://video-finish/async/finish");
    expect(guard.touched(), "the public path must not be reached").toBe(false);
  });

  it("the binding WINS when a URL is also set", async () => {
    // A leftover VIDEO_FINISH_URL must not silently send traffic back over the edge during a
    // rollout, which is exactly the window in which both are configured.
    const guard = forbidGlobalFetch();
    const door = stubDoor();
    const env = {
      VIDEO_FINISH_URL: "https://stale.invalid",
      MEDIA_FINISH_TOKEN: "t",
      MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door.fetcher },
    } as unknown as Env;
    await mediaDoorFetch(env, "VIDEO_FINISH_URL", "/inspect", { method: "POST" });
    expect(door.calls[0].url).toBe("http://video-finish/inspect");
    expect(guard.touched()).toBe(false);
  });

  it("a missing bearer does NOT fail closed on the binding path", async () => {
    // The bearer authenticates a request crossing the public internet. This one does not cross it.
    // Failing closed here would make the seam unusable for the case it exists for.
    const door = stubDoor();
    const env = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door.fetcher } } as unknown as Env;
    await expect(mediaDoorFetch(env, "VIDEO_FINISH_URL", "/finish", { method: "POST" })).resolves.toBeTruthy();
  });

  it("CONTROL: the public path is UNCHANGED -- still fails closed on a missing bearer", async () => {
    // The whole point of the seam is that it is additive. If this row ever goes green-by-accident,
    // the change stopped being additive and every self-hosted door lost its fail-closed guarantee.
    const env = { VIDEO_FINISH_URL: "https://door.invalid" } as unknown as Env;
    await expect(mediaDoorFetch(env, "VIDEO_FINISH_URL", "/finish", { method: "POST" })).rejects.toBeInstanceOf(
      MediaFinishAuthError,
    );
  });

  it("CONTROL: with neither binding nor URL the door is still off (returns null)", async () => {
    const env = {} as unknown as Env;
    await expect(mediaDoorFetch(env, "VIDEO_FINISH_URL", "/finish", { method: "POST" })).resolves.toBeNull();
  });
});

describe("cf#810: POLL goes through the binding too, not only SUBMIT", () => {
  it("polls the bound door and never the per-box hostnames", async () => {
    // The half that would have been missed. Submitting into the container and then polling three
    // authoritative NXDOMAINs for the answer would hang every job as `missing` until the
    // not-found streak gave up -- a worse failure than the one being fixed, and harder to read.
    const guard = forbidGlobalFetch();
    const door = stubDoor(() =>
      new Response(JSON.stringify({ status: "completed", result: { ok: true, key: "k" } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const env = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door.fetcher } } as unknown as Env;
    const hit = await pollVideoFinishAsync(env, "job-1");
    expect(hit.kind).toBe("completed");
    expect(door.calls.length, "exactly one poll target, not a fan-out").toBe(1);
    expect(door.calls[0].url).toBe("http://video-finish/async/status/job-1");
    expect(guard.touched(), "no per-box hostname may be polled").toBe(false);
  });
});

describe("cf#810 WIRING: a binding-only studio assembles, with VIDEO_FINISH_URL unset", () => {
  const FILM = "film-810-wiring";
  const CLIPS = "clips-810-wiring";

  function boundEnv(shots: number, door: { fetch: (u: string, i?: RequestInit) => Promise<Response> }) {
    const job: Partial<FilmJob> & { film_id: string } = {
      film_id: FILM, project: "p", bundle_key: "bundles/p.tar.gz",
      scenes: Array.from({ length: shots }, (_u, i) => ({ shot_id: `shot_${i}`, prompt: "a", seconds: 4 })),
      motion_backend: "own-gpu", motion_config: {}, finish_config: {},
      keyframe_binding: null, phase: "clips", clip_job_id: CLIPS, created_at: 0,
    };
    const clipJob = {
      job_id: CLIPS, project: "p",
      shots: Array.from({ length: shots }, (_u, i) => ({
        shot_id: `shot_${i}`, status: "done", clip_key: `renders/${FILM}/shot_${i}.mp4`,
      })),
    };
    const store = new Map<string, string>([
      [filmJobDocKey(FILM), JSON.stringify(job)],
      [`renders/clip-jobs/${CLIPS}.json`, JSON.stringify(clipJob)],
    ]);
    return {
      env: {
        // NOTE: no VIDEO_FINISH_URL and no MEDIA_FINISH_TOKEN. That is the configuration cf#810
        // moves the estate to, and before this change it meant "tier not installed".
        MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door },
        R2_RENDERS: {
          get: async (key: string) => {
            for (const [k, v] of store) if (k === key || (key.includes(CLIPS) && k.includes(CLIPS))) return { text: async () => v };
            return null;
          },
          head: async () => null,
          list: async () => ({ objects: [] }),
          put: async (key: string, val: string) => { store.set(key, val); },
          delete: async () => {},
        },
        PRESIGNER: {
          presignGet: async (k: string, ttl: number) => `https://get.invalid/${k}?e=${ttl}`,
          presignPut: async (k: string, _ct: string, ttl: number) => `https://put.invalid/${k}?e=${ttl}`,
        },
      } as unknown as Env,
      read: () => JSON.parse(store.get(filmJobDocKey(FILM)) as string) as FilmJob,
    };
  }

  it("submits an assemble through the binding, and does not degrade to clips-only", async () => {
    const guard = forbidGlobalFetch();
    const seen: string[] = [];
    let submitted: Record<string, unknown> | null = null;
    const door = {
      fetch: async (url: string, init?: RequestInit) => {
        seen.push(url);
        if (url.includes("/async/finish")) {
          submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify({ ok: true, jobId: "j810" }), {
            status: 202, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "pending" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    };
    const { env, read } = boundEnv(3, door);
    await advanceFilmJob(env, FILM);

    expect(seen.some((u) => u.startsWith("http://video-finish/async/finish")), "a submit reached the binding").toBe(true);
    expect(submitted, "the payload was built, so the tier was NOT treated as missing").not.toBeNull();
    // The pool from #301 still rides along: the two changes have to compose.
    expect((submitted as unknown as { partialUrls: unknown[] }).partialUrls.length).toBe(3);
    // The job parked in poll rather than degrading.
    expect(read().phase, "phase after a 202 submit").toBe("assemble");
    expect(guard.touched(), "nothing left the isolate").toBe(false);
  });
});
