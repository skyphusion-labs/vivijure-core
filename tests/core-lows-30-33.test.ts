import { describe, expect, it, vi } from "vitest";
import { contentValidateDoneClips } from "../src/clip-content-validate.js";
import { stageAudioKeyForRenders } from "../src/audio-stage.js";
import { advanceFilmJob } from "../src/film-orchestrator.js";
import * as registry from "../src/modules/registry.js";
import type { FilmJob } from "../src/film-model.js";
import { ensureScatterRenderRow } from "../src/scatter-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { ClipJob } from "../src/render-orchestrator.js";
import type { ScatterJob } from "../src/scatter-orchestrator.js";

// Wave-5 lows: #30 transient-skip re-inspection, #31 audio-stage fail-loud, #32 corrupt-doc loud fail,
// #33 scatter shard-row self-heal.

describe("#30 contentValidateDoneClips: a transient 'skip' does not lock out re-inspection", () => {
  const env = { VIDEO_FINISH_VPC: {} } as unknown as Env;

  it("does NOT persist a 'skip' verdict (a later tick can re-inspect)", async () => {
    const job = { job_id: "j1", shots: [{ shot_id: "s1", status: "done", clip_key: "k1" }] } as unknown as ClipJob;
    await contentValidateDoneClips(env, job, async () => ({ verdict: "skip", reason: "/inspect blip" }));
    expect(job.shots[0].content_validated).toBeUndefined(); // pre-fix stored "skip" and short-circuited
  });

  it("re-inspects a shot previously marked 'skip' and fails it when now corrupt", async () => {
    const job = {
      job_id: "j1",
      shots: [{ shot_id: "s1", status: "done", clip_key: "k1", content_validated: "skip" }],
    } as unknown as ClipJob;
    await contentValidateDoneClips(env, job, async () => ({ verdict: "corrupt", reason: "chromatic noise" }));
    expect(job.shots[0].status).toBe("failed"); // pre-fix: truthy "skip" -> continue -> never inspected
  });
});

describe("#31 stageAudioKeyForRenders fails loudly on a missing in-renders key", () => {
  it("throws when a non-out/ key is absent from R2_RENDERS", async () => {
    const env = { R2_RENDERS: { head: async () => null } } as unknown as Env;
    await expect(stageAudioKeyForRenders(env, "audio/missing.mp3")).rejects.toThrow(/audio source not found/);
  });

  it("returns a present non-out/ key unchanged", async () => {
    const env = { R2_RENDERS: { head: async () => ({ size: 1 }) } } as unknown as Env;
    expect(await stageAudioKeyForRenders(env, "dialogue/s1.wav")).toBe("dialogue/s1.wav");
  });

  it("rejects keys outside the renders audio prefix allowlist (KF3 #69)", async () => {
    const env = { R2_RENDERS: { head: async () => ({ size: 1 }) } } as unknown as Env;
    await expect(stageAudioKeyForRenders(env, "bundles/victim/secret.tar.gz")).rejects.toThrow(
      /must start with one of/,
    );
  });

  it("rejects unsafe out/ keys with extra path segments", async () => {
    const env = {} as unknown as Env;
    await expect(stageAudioKeyForRenders(env, "out/nested/extra.mp3")).rejects.toThrow(
      /single segment under out/,
    );
  });
});

describe("#53 advanceFilmJob fails loudly on a non-SyntaxError throw (no forever-wedge)", () => {
  it("marks the render FAILED, persists phase=failed, and does not rethrow", async () => {
    const sqls: string[] = [];
    const puts: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string") {
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* ignore non-JSON */
        }
      }
    });
    const filmJob: FilmJob = {
      film_id: "film-presign-wedge",
      project: "p",
      bundle_key: "b",
      scenes: [{ shot_id: "s1", prompt: "x", seconds: 4 }],
      phase: "keyframe",
      created_at: Date.now(),
      phase_started_at: Date.now(),
      keyframe_binding: "keyframe",
      keyframe_poll: { token: "t" },
    } as unknown as FilmJob;
    const DB = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
    };
    const env = {
      DB,
      R2_RENDERS: {
        get: async () => ({ text: async () => JSON.stringify(filmJob) }),
        put: async (key: string, body: string) => {
          puts.push(body);
        },
      },
    } as unknown as Env;
    vi.spyOn(registry, "discoverModules").mockRejectedValueOnce(
      new Error("R2 presign needs R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET"),
    );
    const r = await advanceFilmJob(env, "film-presign-wedge");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/advance failed:.*R2 presign needs/);
    expect(sqls.some((s) => /status\s*=\s*'FAILED'/.test(s))).toBe(true);
    expect(puts.some((p) => JSON.parse(p).phase === "failed")).toBe(true);
    // cf#110: terminal transition carries prior phase from the R2 job doc (not from: null).
    expect(
      events.some(
        (e) => e.ev === "film.phase" && e.from === "keyframe" && e.to === "failed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.ev === "film.render.terminal" && e.from === "keyframe" && e.status === "failed",
      ),
    ).toBe(true);
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("#32 advanceFilmJob fails loudly on a corrupt job doc (no forever-wedge)", () => {
  it("marks the render FAILED and returns null instead of throwing every tick", async () => {
    const sqls: string[] = [];
    const DB = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
    };
    const env = {
      DB,
      R2_RENDERS: { get: async () => ({ text: async () => "{not valid json" }) },
    } as unknown as Env;
    const r = await advanceFilmJob(env, "film-corrupt");
    expect(r).toBeNull();
    expect(sqls.some((s) => /status\s*=\s*'FAILED'/.test(s))).toBe(true); // markRenderFailedByJobId ran
  });
});

describe("#33 ensureScatterRenderRow backfills missing shard rows", () => {
  it("inserts shard rows that are absent even when the parent row already exists", async () => {
    const insertedJobIds: string[] = [];
    const DB = {
      prepare(sql: string) {
        return {
          bind: (...args: unknown[]) => ({
            first: async () =>
              /SELECT id FROM renders WHERE job_id/.test(sql) ? (args[0] === "scatter-1" ? { id: 1 } : null) : null,
            all: async () => ({ results: [] }), // getScatterChildren: no shard rows exist yet
            run: async () => {
              if (/INSERT INTO renders/i.test(sql)) {
                for (const a of args) if (typeof a === "string" && a.startsWith("shard-")) insertedJobIds.push(a);
              }
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    };
    const env = { DB } as unknown as Env;
    const job = {
      scatter_id: "scatter-1",
      project: "p",
      bundle_key: "b",
      quality_tier: "std",
      render_overrides: {},
      project_id: null,
      shard_film_ids: ["shard-1", "shard-2"],
      expected_shot_ids: ["s1", "s2"],
      phase: "shards",
      cancelled: false,
      film_key: "f",
      created_at: 0,
    } as unknown as ScatterJob;
    await ensureScatterRenderRow(env, job);
    expect(insertedJobIds.sort()).toEqual(["shard-1", "shard-2"]); // pre-fix: early-returned, inserted nothing
  });
});
