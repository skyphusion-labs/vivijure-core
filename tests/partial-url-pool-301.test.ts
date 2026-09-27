// core#301: the partialUrls pool, and the TTL that has to outlive the whole job.
//
// WHAT THIS FILE HAS TO SEE, and why a key-set assertion alone cannot. The pre-existing presign
// suites assert WHICH keys are signed. This defect is not in the key set at all -- the keys were
// always right. It is in the EXPIRY, a second argument nobody was reading. So every assertion here
// records the TTL alongside the key, and the wiring test asserts against the JSON body actually
// posted to /async/finish rather than against a helper's return value, because the bug this is
// written for is a CALL SITE passing 1800 to a correct helper.
import { afterEach, describe, expect, it } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import {
  ASSEMBLE_MAX_JOB_SECONDS,
  ASSEMBLE_MAX_POOL_PAIRS,
  ASSEMBLE_PRESIGN_TTL_SECONDS,
  assertAssembleTtl,
  deletePartialPool,
  encodeAssemblePoll,
  mintPartialUrlPool,
  partialKeyFor,
  tickVideoFinishAssemble,
} from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// ---------------------------------------------------------------- the TTL invariant

describe("core#301: an assemble presign must outlive the job it is minted for", () => {
  it("the shipped TTL clears the horizon (the constant that failed was 1800)", () => {
    expect(ASSEMBLE_PRESIGN_TTL_SECONDS).toBeGreaterThan(ASSEMBLE_MAX_JOB_SECONDS);
    // The exact number that was in production at all six assemble presign sites.
    expect(ASSEMBLE_PRESIGN_TTL_SECONDS).toBeGreaterThan(1800);
  });

  it("assertAssembleTtl REFUSES the old 1800, and says why", () => {
    expect(() => assertAssembleTtl(1800, "test")).toThrow(/cannot outlive an assemble job/);
    // It refuses anything under the horizon, not just the one literal that happened to be there.
    expect(() => assertAssembleTtl(ASSEMBLE_MAX_JOB_SECONDS - 1, "test")).toThrow();
    expect(() => assertAssembleTtl(Number.NaN, "test")).toThrow();
    expect(assertAssembleTtl(ASSEMBLE_PRESIGN_TTL_SECONDS, "test")).toBe(ASSEMBLE_PRESIGN_TTL_SECONDS);
  });

  it("mintPartialUrlPool refuses a short TTL rather than quietly widening it", async () => {
    // Clamping instead of throwing would hide exactly the mistake this exists to surface: a caller
    // that passes 1800 has a wrong model of the job, and deserves to hear so.
    await expect(mintPartialUrlPool(recordingEnv().env, "renders/f/film.mp4", 4, 1800)).rejects.toThrow(
      /cannot outlive an assemble job/,
    );
  });
});

// ---------------------------------------------------------------- the pool itself

/** A presigner that records (key, ttl) for every signature it is asked for. The TTL is the point. */
function recordingEnv() {
  const gets: { key: string; ttl: number }[] = [];
  const puts: { key: string; ttl: number }[] = [];
  const deleted: string[] = [];
  const env = {
    PRESIGNER: {
      presignGet: async (key: string, ttl: number) => {
        gets.push({ key, ttl });
        return `https://get.invalid/${key}?e=${ttl}`;
      },
      presignPut: async (key: string, _ct: string, ttl: number) => {
        puts.push({ key, ttl });
        return `https://put.invalid/${key}?e=${ttl}`;
      },
    },
    R2_RENDERS: { delete: async (key: string) => { deleted.push(key); } },
  } as unknown as Env;
  return { env, gets, puts, deleted };
}

describe("core#301: the partialUrls pool", () => {
  it("mints exactly one pair per clip, because a batch always holds at least one clip", async () => {
    // POOL SIZE IS THE PROVABLE PART. The container flushes only a non-empty batch, so batches can
    // never outnumber clips. If this ever mints fewer, the container raises "partialUrls pool
    // exhausted" mid-film, after the GPU time is already spent.
    const { env, gets, puts } = recordingEnv();
    const pool = await mintPartialUrlPool(env, "renders/f1/film.mp4", 5);
    expect(pool.length, "one pair per clip").toBe(5);
    expect(gets.length).toBe(5);
    expect(puts.length).toBe(5);
    expect(pool.every((p) => p.put && p.get)).toBe(true);
  });

  it("every minted URL carries the long TTL, put AND get", async () => {
    const { env, gets, puts } = recordingEnv();
    await mintPartialUrlPool(env, "renders/f1/film.mp4", 3);
    // THE assertion this file exists for. The GET is the one that bites: partial 0 is minted at t0
    // and first READ in the final pass, at the very end of the job.
    for (const rec of [...gets, ...puts]) {
      expect(rec.ttl, `TTL for ${rec.key}`).toBeGreaterThanOrEqual(ASSEMBLE_MAX_JOB_SECONDS);
    }
  });

  it("keys are deterministic and sit under the film's own prefix, so cleanup needs no stored state", () => {
    expect(partialKeyFor("renders/f1/film.mp4", 0)).toBe("renders/f1/partials/partial-000.mp4");
    expect(partialKeyFor("renders/f1/film.mp4", 12)).toBe("renders/f1/partials/partial-012.mp4");
    expect(partialKeyFor("film.mp4", 1)).toBe("partials/partial-001.mp4");
  });

  it("is capped at the container's own MAX_CLIPS, and is empty for no clips", async () => {
    const { env } = recordingEnv();
    expect((await mintPartialUrlPool(env, "renders/f/film.mp4", 500)).length).toBe(ASSEMBLE_MAX_POOL_PAIRS);
    expect((await mintPartialUrlPool(env, "renders/f/film.mp4", 0)).length).toBe(0);
  });

  it("cleanup deletes every candidate key and never throws on a failing store", async () => {
    const { env, deleted } = recordingEnv();
    const res = await deletePartialPool(env, "renders/f1/film.mp4", 3);
    expect(deleted).toEqual([
      "renders/f1/partials/partial-000.mp4",
      "renders/f1/partials/partial-001.mp4",
      "renders/f1/partials/partial-002.mp4",
    ]);
    expect(res).toEqual({ attempted: 3, failed: 0 });

    const hostile = { R2_RENDERS: { delete: async () => { throw new Error("R2 down"); } } } as unknown as Env;
    // A storage leak must never fail a film that actually rendered.
    await expect(deletePartialPool(hostile, "renders/f1/film.mp4", 2)).resolves.toEqual({ attempted: 2, failed: 2 });
  });
});

// ---------------------------------------------------------------- the give-up horizon

describe("core#301: a job past the horizon is dead, not pending", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const doorEnv = () =>
    ({
      VIDEO_FINISH_URL: "https://finish.invalid",
      MEDIA_FINISH_TOKEN: "t",
      PRESIGNER: recordingEnv().env.PRESIGNER,
    }) as unknown as Env;

  const pendingFetch = () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "pending" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  };

  const PAYLOAD = { clips: [], outputUrl: "u", outputKey: "k" };

  it("fails once submittedAt is older than ASSEMBLE_MAX_JOB_SECONDS, instead of polling forever", async () => {
    // Before this, notFoundStreak reset to 0 on any `pending` and submittedAt was never read at all
    // (grep-zero), so a job whose presigns had expired polled for ever and the film resolved neither
    // way. That is why a short TTL presented as a hang rather than an error.
    pendingFetch();
    const stale = encodeAssemblePoll({
      jobId: "j1",
      submittedAt: Date.now() - (ASSEMBLE_MAX_JOB_SECONDS + 60) * 1000,
      notFoundStreak: 0,
    });
    const tick = await tickVideoFinishAssemble(doorEnv(), PAYLOAD, stale);
    expect(tick.kind).toBe("failed");
    if (tick.kind === "failed") expect(tick.error).toMatch(/expired/);
  });

  it("CONTROL: the same pending response inside the horizon still polls", async () => {
    // Without this row the test above could pass because the harness never reaches a pending state
    // at all, which would make it a claim about the fixture rather than about the horizon.
    pendingFetch();
    const fresh = encodeAssemblePoll({ jobId: "j1", submittedAt: Date.now() - 1000, notFoundStreak: 0 });
    const tick = await tickVideoFinishAssemble(doorEnv(), PAYLOAD, fresh);
    expect(tick.kind).toBe("pending");
  });
});

// ---------------------------------------------------------------- the call site

// WIRING. Everything above drives helpers directly, and a helper test cannot see this defect: the
// helpers were never wrong, the CALL SITES passed 1800 to a correct presigner. So this drives
// advanceFilmJob into the assemble phase and asserts against the JSON body actually POSTed to
// /async/finish. The stub presigner bakes the TTL it was asked for into the URL it returns, which
// makes the submitted payload itself the witness -- there is no way to satisfy these rows except
// by the orchestrator really asking for a long TTL for really every URL.
describe("core#301 WIRING: the assemble submit carries a pool, and every URL outlives the job", () => {
  const FILM = "film-301-wiring";
  const CLIPS = "clips-301-wiring";
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function assembleEnv(shots: number) {
    const job: Partial<FilmJob> & { film_id: string } = {
      film_id: FILM,
      project: "p",
      bundle_key: "bundles/p.tar.gz",
      scenes: Array.from({ length: shots }, (_u, i) => ({ shot_id: `shot_${i}`, prompt: "a", seconds: 4 })),
      motion_backend: "own-gpu",
      motion_config: {},
      finish_config: {},
      keyframe_binding: null,
      phase: "clips",
      clip_job_id: CLIPS,
      created_at: 0,
    };
    const clipJob = {
      job_id: CLIPS,
      project: "p",
      shots: Array.from({ length: shots }, (_u, i) => ({
        shot_id: `shot_${i}`, status: "done", clip_key: `renders/${FILM}/shot_${i}.mp4`,
      })),
    };
    const store = new Map<string, string>([
      [filmJobDocKey(FILM), JSON.stringify(job)],
      [`renders/clip-jobs/${CLIPS}.json`, JSON.stringify(clipJob)],
    ]);
    const env = {
      VIDEO_FINISH_URL: "https://finish.invalid",
      MEDIA_FINISH_TOKEN: "t",
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
      // The TTL it was asked for is baked into the URL, so the SUBMITTED BODY carries it.
      PRESIGNER: {
        presignGet: async (k: string, ttl: number) => `https://get.invalid/${k}?e=${ttl}`,
        presignPut: async (k: string, _ct: string, ttl: number) => `https://put.invalid/${k}?e=${ttl}`,
      },
    } as unknown as Env;
    return { env, read: () => JSON.parse(store.get(filmJobDocKey(FILM)) as string) as FilmJob };
  }

  /** Capture the body POSTed to /async/finish, and answer 202 so the job parks in poll. */
  function captureSubmit(): { body: () => Record<string, unknown> | null } {
    let captured: Record<string, unknown> | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/async/finish")) {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, jobId: "job-301" }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "pending" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { body: () => captured };
  }

  const ttlOf = (u: string): number => Number(new URL(u).searchParams.get("e"));

  it("CONTROL: the harness actually reaches an assemble submit", async () => {
    // Every row below reads a field off the submitted body. If nothing was ever submitted, they
    // would all read undefined and could be made to pass by a careless assertion. Prove the
    // submit happened before believing anything about its contents.
    const { env } = assembleEnv(3);
    const cap = captureSubmit();
    await advanceFilmJob(env, FILM);
    const body = cap.body();
    expect(body, "a body reached /async/finish").not.toBeNull();
    expect(Array.isArray(body?.clips) && (body?.clips as unknown[]).length, "DENOMINATOR: clips submitted").toBe(3);
  });

  it("submits a partialUrls pool, one pair per clip", async () => {
    const { env } = assembleEnv(3);
    const cap = captureSubmit();
    await advanceFilmJob(env, FILM);
    const pool = cap.body()?.partialUrls as { put: string; get: string }[] | undefined;
    expect(pool, "partialUrls present: without it the container takes the single-pass path").toBeDefined();
    expect(pool?.length).toBe(3);
    expect(pool?.[0].get).toContain("partials/partial-000.mp4");
  });

  it("EVERY url in the submitted payload outlives the job -- clips, output and pool alike", async () => {
    // The clip GETs are the half that is easy to miss, because that line of code did not change:
    // under chunking batch N downloads its clips only after batch N-1 has encoded, so a 1800s clip
    // URL expires mid-film. This row would have gone red on the code as it shipped.
    const { env } = assembleEnv(4);
    const cap = captureSubmit();
    await advanceFilmJob(env, FILM);
    const body = cap.body() as { clips: { url: string }[]; outputUrl: string; partialUrls: { put: string; get: string }[] };
    const urls = [
      ...body.clips.map((c) => c.url),
      body.outputUrl,
      ...body.partialUrls.flatMap((p) => [p.put, p.get]),
    ];
    expect(urls.length, "DENOMINATOR: urls in the payload").toBe(4 + 1 + 8);
    for (const u of urls) {
      expect(ttlOf(u), `TTL baked into ${u}`).toBeGreaterThanOrEqual(ASSEMBLE_MAX_JOB_SECONDS);
    }
    // And named explicitly, so a future edit that halves the constant is still caught by intent.
    expect(new Set(urls.map(ttlOf))).toEqual(new Set([ASSEMBLE_PRESIGN_TTL_SECONDS]));
  });
});
