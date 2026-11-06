// vivijure-cf#911: the BOUND media-door hop carries the bearer.
//
// Before this, mediaDoorFetch took the bound branch and returned before any token lookup, so the
// credential reached the container only if each call site remembered to build it into its own
// headers, and the bound poll in video-finish-assemble went around mediaDoorFetch entirely. The
// seam now attaches it. These rows drive the real exported functions against a door double that
// records the headers it RECEIVED, which is the property the container checks.
import { afterEach, describe, expect, it } from "vitest";
import { boundMediaDoorFetch, mediaDoorFetch, withMediaBearer } from "../src/media-finish-auth.js";
import { pollVideoFinishAsync } from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidGlobalFetch(): void {
  globalThis.fetch = (async (u: unknown) => {
    throw new Error(`global fetch must not be used on the bound path (tried ${String(u)})`);
  }) as unknown as typeof fetch;
}

/** The authorization header a request carried, read the way a server reads it. */
function authOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

function door(body = '{"status":"pending"}') {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetcher: {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(body, { status: 200 });
      },
    },
  };
}

function envWith(token: unknown, d: ReturnType<typeof door>): Env {
  return { MEDIA_FINISH_TOKEN: token, MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: d.fetcher, AUDIO_MIX_URL: d.fetcher } } as unknown as Env;
}

describe("cf#911: mediaDoorFetch's bound branch sends the bearer", () => {
  it("a caller that built NO headers still reaches the door with the bearer", async () => {
    forbidGlobalFetch();
    const d = door();
    await mediaDoorFetch(envWith("tok-911", d), "VIDEO_FINISH_URL", "/async/finish", { method: "POST", body: "{}" });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].url).toBe("http://video-finish/async/finish");
    expect(authOf(d.calls[0].init)).toBe("Bearer tok-911");
  });

  it("every bound door key gets it, not only video-finish", async () => {
    const d = door();
    await mediaDoorFetch(envWith("tok-911", d), "AUDIO_MIX_URL", "mix", { method: "POST" });
    expect(d.calls[0].url).toBe("http://audio-mix/mix");
    expect(authOf(d.calls[0].init)).toBe("Bearer tok-911");
  });

  it("a Secrets Store handle is resolved, not sent as an object", async () => {
    const d = door();
    await mediaDoorFetch(envWith({ get: async () => " tok-store " }, d), "VIDEO_FINISH_URL", "/inspect", {});
    expect(authOf(d.calls[0].init)).toBe("Bearer tok-store");
  });

  it("the caller's other headers survive, and the header shape is kept", async () => {
    const d = door();
    await mediaDoorFetch(envWith("tok-911", d), "VIDEO_FINISH_URL", "/finish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-finish-affinity": "film-1" },
    });
    const h = d.calls[0].init!.headers as Record<string, string>;
    expect(h).not.toBeInstanceOf(Headers);
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-finish-affinity"]).toBe("film-1");
    expect(h.authorization).toBe("Bearer tok-911");
  });

  it("a stale or foreign Authorization from the caller is REPLACED, in any case, never doubled", async () => {
    const d = door();
    await mediaDoorFetch(envWith("tok-911", d), "VIDEO_FINISH_URL", "/finish", {
      headers: { Authorization: "Bearer wrong" },
    });
    const h = d.calls[0].init!.headers as Record<string, string>;
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "authorization")).toEqual(["authorization"]);
    expect(h.authorization).toBe("Bearer tok-911");
  });

  it("a Headers instance and a tuple list are handled too", async () => {
    const a = await withMediaBearer({ MEDIA_FINISH_TOKEN: "t" } as unknown as Env, {
      headers: new Headers({ "content-type": "application/json", authorization: "Bearer x" }),
    });
    expect(a.headers).toBeInstanceOf(Headers);
    expect((a.headers as Headers).get("authorization")).toBe("Bearer t");
    expect((a.headers as Headers).get("content-type")).toBe("application/json");
    const b = await withMediaBearer({ MEDIA_FINISH_TOKEN: "t" } as unknown as Env, {
      headers: [["Authorization", "Bearer x"], ["x-a", "1"]],
    });
    expect(b.headers).toEqual([["x-a", "1"], ["authorization", "Bearer t"]]);
  });

  it("NO token: the bound call goes through WITHOUT a header and does not throw (the rollout stays safe)", async () => {
    const d = door();
    const resp = await mediaDoorFetch(envWith(undefined, d), "VIDEO_FINISH_URL", "/finish", { method: "POST" });
    expect(resp?.status).toBe(200);
    expect(authOf(d.calls[0].init)).toBeNull();
    // and a whitespace token is no token
    await mediaDoorFetch(envWith("   ", d), "VIDEO_FINISH_URL", "/finish", {});
    expect(authOf(d.calls[1].init)).toBeNull();
  });
});

describe("cf#911: the bound POLL carries the bearer", () => {
  // What this row proves is the PROPERTY (the poll arrives with the bearer), not which code put it
  // there. pollVia already builds its headers with mediaFinishHeaders, so routing the bound poll
  // through boundMediaDoorFetch is a second layer: a mutation that reverts only that routing stays
  // green here, by design, because the first layer still attaches the header.
  it("pollVideoFinishAsync on a bound door carries the bearer and never touches global fetch", async () => {
    forbidGlobalFetch();
    const d = door();
    const hit = await pollVideoFinishAsync(envWith("tok-911", d), "job-1");
    expect(hit.kind).toBe("pending");
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].url).toBe("http://video-finish/async/status/job-1");
    expect(authOf(d.calls[0].init)).toBe("Bearer tok-911");
  });
});

describe("boundMediaDoorFetch", () => {
  it("normalises the path and uses the door's internal origin", async () => {
    const d = door();
    await boundMediaDoorFetch({ MEDIA_FINISH_TOKEN: "t" } as unknown as Env, "IMAGE_PREP_URL", d.fetcher, "portrait/prep");
    expect(d.calls[0].url).toBe("http://image-prep/portrait/prep");
    expect(authOf(d.calls[0].init)).toBe("Bearer t");
  });
});
