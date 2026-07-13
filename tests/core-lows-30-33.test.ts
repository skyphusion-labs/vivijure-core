import { describe, expect, it } from "vitest";
import { contentValidateDoneClips } from "../src/clip-content-validate.js";
import { stageAudioKeyForRenders } from "../src/audio-stage.js";
import { advanceFilmJob } from "../src/film-orchestrator.js";
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
