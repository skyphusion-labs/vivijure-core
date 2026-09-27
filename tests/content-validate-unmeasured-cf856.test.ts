import { describe, it, expect, vi, afterEach } from "vitest";
import { contentValidateDoneClips, contentValidationView } from "../src/clip-content-validate.js";
import { filmDonePayload } from "../src/render-output-payload.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { installVfFetch } from "./install-vf-fetch.js";
import { MODULE_API } from "../src/modules/types.js";
import type { ClipJob } from "../src/render-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#856, and this one arrived as a MEASUREMENT rather than a code reading. From a live
// `wrangler tail` on film-2a5922b5 while the video-finish container was crash-looping (cf#851):
//
//   {"ev":"clip.content_validate","shot_id":"shot_01","verdict":"skip",
//    "reason":"video-finish /inspect unreachable or errored"}
//
// 5 skips, 0 passes, 0 failures, and the film advanced from clips to assemble anyway. The #523
// Layer 2 pixel gate did not look at a single clip and NOTHING in the render record said so.
//
// The deceptive part is that Layer 1 (structural) PASSED on the same clips, because it needs no
// container. So a reader sees "validate: pass" beside "content_validate: skip", one word apart,
// and only one of them inspected anything.
//
// WHAT IS NOT THE FIX: making the skip a hard failure. A momentary /inspect blip must not kill a
// fully rendered film, and #30 already established that a skip must not even be persisted as a
// VERDICT, because a truthy content_validated short-circuits re-inspection and one blip disables
// the gate for the whole pass. The defect is not that it skips. It is that the skip is SILENT and
// indistinguishable from a pass. So: make the state durable and visible, change no verdict.

const REAL_REASON = "video-finish /inspect unreachable or errored";
const env = { VIDEO_FINISH_URL: "https://video-finish.test", MEDIA_FINISH_TOKEN: "t" } as unknown as Env;

type Shot = ClipJob["shots"][number];
const clipJob = (shots: Partial<Shot>[]): ClipJob => ({ job_id: "j1", shots } as unknown as ClipJob);

const done = (shot_id: string, over: Partial<Shot> = {}): Partial<Shot> => ({
  shot_id,
  status: "done",
  clip_key: `renders/f/${shot_id}.mp4`,
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); });

describe("cf#856: a skip is recorded as UNMEASURED, without becoming a verdict", () => {
  it("records the reason and asks the caller to persist, while content_validated stays unset", async () => {
    const job = clipJob([done("s1")]);
    const changed = await contentValidateDoneClips(env, job, async () => ({ verdict: "skip", reason: REAL_REASON }));
    expect(job.shots[0].content_unmeasured).toBe(REAL_REASON);
    expect(changed, "the caller only writes the doc when this is true").toBe(true);
    // THE #30 PROPERTY, asserted here so this change cannot quietly undo it: a skip must not become
    // a verdict, or the next tick short-circuits and the pixel gate is off for the whole pass.
    expect(job.shots[0].content_validated).toBeUndefined();
  });

  it("does NOT re-report a change when the same skip repeats (no write per tick)", async () => {
    const job = clipJob([done("s1", { content_unmeasured: REAL_REASON })]);
    const changed = await contentValidateDoneClips(env, job, async () => ({ verdict: "skip", reason: REAL_REASON }));
    expect(changed).toBe(false);
    expect(job.shots[0].content_unmeasured).toBe(REAL_REASON);
  });

  it("CLEARS the record the moment a terminal verdict lands, so it can never be stale", async () => {
    const job = clipJob([done("s1", { content_unmeasured: REAL_REASON })]);
    const changed = await contentValidateDoneClips(env, job, async () => ({ verdict: "ok" }));
    expect(job.shots[0].content_unmeasured).toBeUndefined();
    expect(job.shots[0].content_validated).toBe("ok");
    expect(changed).toBe(true);
  });

  it("a corrupt verdict still FAILS the shot, and carries no unmeasured record", async () => {
    const job = clipJob([done("s1", { content_unmeasured: REAL_REASON })]);
    await contentValidateDoneClips(env, job, async () => ({ verdict: "corrupt", reason: "chromatic noise" }));
    expect(job.shots[0].status).toBe("failed");
    expect(job.shots[0].content_unmeasured).toBeUndefined();
  });
});

describe("cf#856: the ladder -- never ran, ran clean, and could not measure are three states", () => {
  it("NEVER RAN -> undefined (a self-host with no VIDEO_FINISH_URL is exactly this)", () => {
    expect(contentValidationView(clipJob([done("s1"), done("s2")]))).toBeUndefined();
  });

  it("RAN CLEAN -> unmeasured 0, which is NOT the same object as never having run", () => {
    const v = contentValidationView(clipJob([done("s1", { content_validated: "ok" }), done("s2", { content_validated: "ok" })]));
    expect(v).toEqual({ checked: 2, unmeasured: 0, reasons: [] });
  });

  it("THE LIVE SHAPE: 5 clips, 0 checked, 5 unmeasured, one deduped reason", () => {
    const five = ["shot_01", "shot_02", "shot_03", "shot_04", "shot_05"].map((id) =>
      done(id, { content_unmeasured: REAL_REASON }),
    );
    expect(contentValidationView(clipJob(five))).toEqual({
      checked: 0,
      unmeasured: 5,
      reasons: [REAL_REASON],
    });
  });

  it("a PARTIAL pass reports both halves, so half-measured is its own fact", () => {
    const v = contentValidationView(
      clipJob([done("s1", { content_validated: "ok" }), done("s2", { content_unmeasured: REAL_REASON })]),
    );
    expect(v).toEqual({ checked: 1, unmeasured: 1, reasons: [REAL_REASON] });
  });

  it("counts only the population Layer 2 covers (done clips), not failed or pending shots", () => {
    const v = contentValidationView(
      clipJob([
        done("s1", { content_validated: "ok" }),
        { shot_id: "s2", status: "failed" } as Partial<Shot>,
        { shot_id: "s3", status: "pending" } as Partial<Shot>,
      ]),
    );
    expect(v).toEqual({ checked: 1, unmeasured: 0, reasons: [] });
  });

  it("the three states are mutually distinguishable", () => {
    const never = contentValidationView(clipJob([done("s1")]));
    const clean = contentValidationView(clipJob([done("s1", { content_validated: "ok" })]));
    const blocked = contentValidationView(clipJob([done("s1", { content_unmeasured: REAL_REASON })]));
    expect(never).toBeUndefined();
    expect(clean).not.toEqual(never);
    expect(blocked).not.toEqual(clean);
  });
});

describe("cf#856: it reaches the render payload, which is the whole point", () => {
  const film = (over: Partial<FilmJob> = {}): FilmJob =>
    ({
      film_id: "film-856", project: "p", bundle_key: "b", scenes: [], motion_backend: null,
      motion_config: {}, finish_config: {}, keyframe_binding: null, phase: "done",
      film_key: "renders/film-856/film.mp4", created_at: 0, phase_started_at: 0, ...over,
    }) as FilmJob;

  it("absent when Layer 2 never ran", () => {
    expect(filmDonePayload(film(), null).content_validation).toBeUndefined();
  });

  it("present, verbatim, when it could not measure", () => {
    const out = filmDonePayload(film({ content_validation: { checked: 0, unmeasured: 5, reasons: [REAL_REASON] } }), null);
    expect(out.content_validation).toEqual({ checked: 0, unmeasured: 5, reasons: [REAL_REASON] });
  });
});

// --- the live incident, end to end ------------------------------------------------------------

const FILM = "film-856-e2e";
const CLIPS = "clips-856-e2e";
// The real layout, read off clipDocKey rather than guessed: a fixture that invents a key shape
// tests its own invention.
const CLIP_DOC_KEY = `renders/${CLIPS}/clips-job.json`;

function filmEnv() {
  const job: Partial<FilmJob> & { film_id: string } = {
    film_id: FILM, project: "p", bundle_key: "bundles/p.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }, { shot_id: "shot_02", prompt: "b", seconds: 4 }],
    motion_backend: "seedance", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "clips", clip_job_id: CLIPS,
    created_at: Date.now(), phase_started_at: Date.now(), last_progress_at: Date.now(),
  };
  const clips = {
    job_id: CLIPS, project: "p",
    shots: [
      { shot_id: "shot_01", status: "done", clip_key: `renders/${FILM}/shot_01.mp4`, validated: "pass" },
      { shot_id: "shot_02", status: "done", clip_key: `renders/${FILM}/shot_02.mp4`, validated: "pass" },
    ],
  };
  const store = new Map<string, string>([
    [filmJobDocKey(FILM), JSON.stringify(job)],
    [CLIP_DOC_KEY, JSON.stringify(clips)],
  ]);
  const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => {
        for (const [k, v] of store) if (k === key || (key.includes(CLIPS) && k.includes(CLIPS))) return { text: async () => v };
        return null;
      },
      head: async () => null,
      list: async () => ({ objects: [] }),
      put: async (key: string, val: string) => { store.set(key, val); },
    },
    PRESIGNER: { presignGet: async (k: string) => `https://presigned/${k}`, presignPut: async (k: string) => `https://presigned-put/${k}` },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "t",
  };
  // One finish module, bound and parking, so the film reaches the Layer 2 gate and then stops there.
  env.MODULE_FINISH_RIFE = {
    fetch: async (url: string) => {
      if (String(url).endsWith("/module.json")) {
        return jsonResp({ name: "finish-rife", version: "1.0.0", api: MODULE_API, hooks: ["finish"], ui: { order: 10, section: "finish" } });
      }
      return jsonResp({ ok: true, pending: true, poll: "https://module/poll/x" });
    },
  };
  return {
    env: env as unknown as Env,
    readFilm: () => JSON.parse(store.get(filmJobDocKey(FILM)) as string) as FilmJob,
    readClips: () => JSON.parse(store.get(CLIP_DOC_KEY) as string) as ClipJob,
  };
}

describe("cf#856 end to end: the crashing container, reproduced", () => {
  it("a dead /inspect leaves the film ADVANCING but carrying the unmeasured record", async () => {
    const h = filmEnv();
    // cf#851's signature: the container process dies before it binds, so the edge answers 5xx.
    installVfFetch(async () => new Response("Container crashed while checking for ports", { status: 500 }));

    await advanceFilmJob(h.env, FILM);
    const film = h.readFilm();

    // It still advances: a down inspector must not kill a fully rendered film.
    expect(film.phase).not.toBe("failed");
    // And it is no longer silent. THIS is the assertion the issue is about.
    expect(film.content_validation).toBeTruthy();
    expect(film.content_validation?.unmeasured).toBe(2);
    expect(film.content_validation?.checked).toBe(0);
    expect(film.content_validation?.reasons.join(" ")).toMatch(/inspect unreachable or errored/);
    // The per-shot record is durable on the clip doc, and no verdict was invented.
    const clips = h.readClips();
    expect(clips.shots.map((s) => s.content_unmeasured).filter(Boolean)).toHaveLength(2);
    expect(clips.shots.map((s) => s.content_validated).filter(Boolean)).toHaveLength(0);
  });

  it("POSITIVE CONTROL: a healthy /inspect leaves checked 2, unmeasured 0, and no reasons", async () => {
    const h = filmEnv();
    installVfFetch(async () =>
      new Response(JSON.stringify({ ok: true, verdict: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await advanceFilmJob(h.env, FILM);
    const film = h.readFilm();

    expect(film.content_validation).toEqual({ checked: 2, unmeasured: 0, reasons: [] });
    expect(h.readClips().shots.every((s) => s.content_validated === "ok")).toBe(true);
  });
});
