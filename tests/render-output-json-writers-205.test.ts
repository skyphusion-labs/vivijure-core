import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import { handleAdoptRender } from "../src/render-adopt.js";
import { filmDonePayload, scatterDonePayload } from "../src/render-output-payload.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { ClipJob } from "../src/render-orchestrator.js";
import type { ScatterJob } from "../src/scatter-orchestrator-types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// core#205: renders.output_json had FIVE writers and only ONE derived its payload.
//
// WHY THE DEFECT WAS INVISIBLE, and therefore what this file has to do differently. Both hand-built
// payloads are LOCAL to functions reachable only through a FULL ADVANCE TICK, so no test touched
// them; the poll view, which every test drives, is the one writer that was already correct. So a
// field added to the view passed the whole suite and was still missing from the row, because
// markFinishDone writes `output_json = ?` UNCONDITIONALLY (not COALESCE, unlike output_ms and
// finish_elapsed_ms in the same statement) and the last writer takes the column outright.
//
// Every test here therefore drives advanceFilmJob / advanceScatterJob and reads the D1 BIND, never
// the view object. A test that asserts on the view cannot fail on this defect, which is exactly how
// the defect shipped.
//
// The probe value is NON-DEFAULT on purpose. `keyframes_incomplete` is the live instance: it is
// derived from the job doc alone, it has been in the poll view since it was added, and it was NOT in
// transitionToDone's hand-built object -- and on the single-film path that hand-built write is the
// LAST writer of the tick. Absent this fix, the row loses it. Asserting the absence of some field
// would prove nothing; these assert the DELTA reaching the artifact.

const JSON_HDR = { "content-type": "application/json" };
const jr = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: JSON_HDR });

/** Every output_json write of a tick, in order, with the payload each one bound.
 *  `finish` = markFinishDone (UPDATE ... finish_state = 'done').
 *  `view`   = updateRenderFromView (UPDATE renders SET status = ?, ...). */
interface OutputWrite {
  kind: "finish" | "view";
  payload: Record<string, unknown>;
  raw: string;
}

function outputJsonRecorder() {
  const writes: OutputWrite[] = [];
  const record = (sql: string, binds: unknown[]): void => {
    // markFinishDone binds: outputKey, outputJson, now, now, output_ms, finish_elapsed_ms, job_id.
    if (/finish_state = 'done'/i.test(sql)) {
      const raw = String(binds[1]);
      writes.push({ kind: "finish", payload: JSON.parse(raw) as Record<string, unknown>, raw });
      return;
    }
    // prepareRenderUpdate binds: status, output_key, output_json, error, ...
    if (/UPDATE renders SET\s+status = \?/i.test(sql) && binds[2] != null) {
      const raw = String(binds[2]);
      writes.push({ kind: "view", payload: JSON.parse(raw) as Record<string, unknown>, raw });
    }
  };
  return { writes, record };
}

function recordingDb(record: (sql: string, binds: unknown[]) => void, first?: (sql: string) => unknown) {
  return {
    prepare(sql: string) {
      const st = {
        _binds: [] as unknown[],
        bind(...b: unknown[]) { st._binds = b; return st; },
        async first() { return (first?.(sql) ?? null) as unknown; },
        async run() { record(sql, st._binds); return { success: true, meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
      return st;
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) { return Promise.all(stmts.map((s) => s.run())); },
  };
}

// ---------------------------------------------------------------------------------------------
// SINGLE FILM: transitionToDone -> markFinishDone, reached only through a full advance tick.
// ---------------------------------------------------------------------------------------------

const FILM = "film-c205-single";
const SILENT = `renders/${FILM}/film-silent.mp4`;
const MUXED = `renders/${FILM}/film-audio.mp4`;

// Non-default and distinctive: a default-shaped value cannot distinguish "carried through" from
// "rebuilt with the same default".
const KF_INCOMPLETE = { adopted: 7, expected: 9, dropped: ["shot_08", "shot_09"] };
const FILM_PROJECT = "proj-c205-single-distinct";

const filmJob = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  film_id: FILM,
  project: FILM_PROJECT,
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux",
  silent_film_key: SILENT,
  audio_key: `renders/${FILM}/bed.wav`,
  mux_output_key: MUXED,
  keyframes_incomplete: KF_INCOMPLETE,
  created_at: 0,
  ...over,
});

function filmEnv(job: Record<string, unknown> = filmJob()) {
  let stored = JSON.stringify(job);
  const rec = outputJsonRecorder();
  const env = {
    DB: recordingDb(rec.record, (sql) => (/SELECT id FROM renders/i.test(sql) ? { id: 1 } : null)),
    R2_RENDERS: {
      get: async (k: string) => (k === filmJobDocKey(FILM) ? { text: async () => stored } : null),
      head: async () => null,
      put: async (k: string, v: string) => { if (k === filmJobDocKey(FILM)) stored = v; },
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
    VIDEO_FINISH_VPC: { fetch: async () => jr({ ok: true, key: MUXED, hasAudio: true }) },
  } as unknown as Env;
  return { env, writes: rec.writes, read: () => JSON.parse(stored) as FilmJob };
}

describe("core#205 single film: the finalize writer carries the whole derived payload", () => {
  it("a job-derived field reaches the ROW, not just the poll view", async () => {
    _resetModuleDiscoveryCache();
    const { env, writes } = filmEnv();

    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase, "the tick must actually reach done, else this proves nothing").toBe("done");

    const finish = writes.filter((w) => w.kind === "finish");
    expect(finish.length, `finish writes seen: ${JSON.stringify(writes.map((w) => w.kind))}`).toBe(1);

    // THE ASSERTION. Before the fix this key is absent from the finalize payload entirely.
    expect(finish[0].payload.keyframes_incomplete).toEqual(KF_INCOMPLETE);
    expect(finish[0].payload.output_key).toBe(MUXED);
    expect(finish[0].payload.project).toBe(FILM_PROJECT);
  });

  it("the row payload IS the builder's output for the persisted job (no second shape)", async () => {
    _resetModuleDiscoveryCache();
    const { env, writes, read } = filmEnv();
    await advanceFilmJob(env, FILM);
    const finish = writes.filter((w) => w.kind === "finish");
    expect(finish.length).toBe(1);
    // The generalized guard: whatever filmDonePayload grows, the finalize write must equal it. A
    // reintroduced hand-built object reddens here even for a field this file never heard of.
    expect(finish[0].payload).toEqual(filmDonePayload(read(), null));
  });

  it("ORDERING: markFinishDone is the LAST output_json writer of the single-film tick", async () => {
    _resetModuleDiscoveryCache();
    const { env, writes } = filmEnv();
    await advanceFilmJob(env, FILM);
    // Stated as a contract instead of left as convention (core#205). Nothing re-writes the row in
    // this tick, which is precisely why a field missing from the finalize payload is lost outright
    // on this path rather than being repaired by a later view write in the same tick.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1].kind).toBe("finish");
  });
});

// ---------------------------------------------------------------------------------------------
// SCATTER: finalizeScatterDone -> markFinishDone, THEN updateRenderFromView. Opposite order.
// ---------------------------------------------------------------------------------------------

const SID = "scatter-c205";
const SCATTER_FILM_KEY = `renders/${SID}/film.mp4`;
const SCATTER_PROJECT = "proj-c205-scatter-distinct";

const scatterJob = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scatter_id: SID,
  project: SCATTER_PROJECT,
  bundle_key: `bundles/${SID}.tar.gz`,
  quality_tier: "final",
  shard_film_ids: ["shard-a"],
  shard_shots: [["shot_01"]],
  expected_shot_ids: ["shot_01"],
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
  phase: "finishing",
  film_key: SCATTER_FILM_KEY,
  created_at: 0,
  ...over,
});

function scatterEnv(job: Record<string, unknown> = scatterJob()) {
  let stored = JSON.stringify(job);
  const docKey = `renders/${SID}/scatter-job.json`;
  const rec = outputJsonRecorder();
  const env = {
    DB: recordingDb(rec.record, (sql) => {
      if (/SELECT id FROM renders/i.test(sql)) return { id: 1 };
      if (/SELECT finish_state/i.test(sql)) return { finish_state: null, output_key: null };
      return null;
    }),
    R2_RENDERS: {
      get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
      head: async () => null,
      put: async (k: string, v: string) => { if (k === docKey) stored = v; },
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
  } as unknown as Env;
  return { env, writes: rec.writes, read: () => JSON.parse(stored) as ScatterJob };
}

describe("core#205 scatter: both writers agree, so the write order stops being load-bearing", () => {
  it("ORDERING: finalizeScatterDone writes FIRST and the poll view writes LAST", async () => {
    _resetModuleDiscoveryCache();
    const { env, writes } = scatterEnv();
    const view = await advanceScatterJob(env, SID);
    expect(view?.status, "the tick must reach COMPLETED, else this proves nothing").toBe("COMPLETED");
    expect(writes.map((w) => w.kind)).toEqual(["finish", "view"]);
  });

  it("the two writes are byte-identical, and both are the builder's output", async () => {
    _resetModuleDiscoveryCache();
    const { env, writes, read } = scatterEnv();
    await advanceScatterJob(env, SID);
    expect(writes.length).toBe(2);
    // Scatter survived the original defect only because its two hand-built objects happened to
    // restate the same three keys. That was luck. This asserts the property directly.
    expect(writes[0].raw).toBe(writes[1].raw);
    expect(writes[0].payload).toEqual(scatterDonePayload(read()));
    expect(writes[0].payload.project).toBe(SCATTER_PROJECT);
    expect(writes[0].payload.output_key).toBe(SCATTER_FILM_KEY);
  });
});

// ---------------------------------------------------------------------------------------------
// The clipJob asymmetry, asserted as an ENUMERATED DELTA rather than left as an absence.
// ---------------------------------------------------------------------------------------------

describe("core#205: the finalize writer's payload differs from the view's by exactly two keys", () => {
  const job = {
    film_id: "film-c205-delta",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "done",
    film_key: "renders/film-c205-delta/film.mp4",
    derive_mode: "full",
    created_at: 0,
  } as unknown as FilmJob;
  const clipJob = {
    clip_job_id: "clip-c205",
    motion_backend: "wan",
    shots: [
      { shot_id: "shot_01", status: "done", clip_key: "renders/clips/shot_01.mp4", delivered_fps: 24, delivered_frames: 72 },
    ],
  } as unknown as ClipJob;

  it("only clips/model and clip_deliveries are clip-doc-derived; everything else is job-derived", () => {
    const withClips = Object.keys(filmDonePayload(job, clipJob)).sort();
    const withoutClips = Object.keys(filmDonePayload(job, null)).sort();
    const delta = withClips.filter((k) => !withoutClips.includes(k));
    // Named explicitly: if a future field lands in the clip-doc branch, this reddens and forces a
    // decision about whether the finalize write can honestly carry it, instead of it going missing.
    expect(delta).toEqual(["clip_deliveries", "clips", "model"]);
    expect(withoutClips.filter((k) => !withClips.includes(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// render-adopt: SCREENED, and deliberately NOT folded into the builder. Pinned so it stays a
// deliberate difference rather than becoming the next silent divergence.
// ---------------------------------------------------------------------------------------------

describe("core#205: the adopt writer is a separate contract, pinned on purpose", () => {
  it("writes {output_key, seconds, has_audio} and nothing film-shaped", async () => {
    const rec = outputJsonRecorder();
    const env = {
      DB: recordingDb(rec.record, () => null),
    } as unknown as Env;
    const res = await handleAdoptRender(
      new Request("https://studio.test/api/storyboard/renders/adopt", {
        method: "POST",
        body: JSON.stringify({
          jobId: "film-c205-adopt",
          outputKey: "renders/film-c205-adopt/film.mp4",
          project: "proj-c205-adopt",
          seconds: 12.5,
          hasAudio: true,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const finish = rec.writes.filter((w) => w.kind === "finish");
    expect(finish.length).toBe(1);
    // Adopt takes a render produced OUTSIDE the orchestrator: there is no job doc, so there is
    // nothing to derive from. seconds/has_audio are not in the film payload and output_key is the
    // only overlap -- a different contract, not a drifted copy.
    expect(Object.keys(finish[0].payload).sort()).toEqual(["has_audio", "output_key", "seconds"]);
  });
});
