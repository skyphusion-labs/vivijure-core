import { describe, it, expect } from "vitest";
import {
  buildInsertRenderStmt,
  getRenderByIdForUser,
  listRendersForUser,
  toPublicRenderRow,
} from "../src/renders-db.js";
import { filmRenderRowSeedFromJob } from "../src/film-render-bridge.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { FilmJob } from "../src/film-model.js";

// cf#393: the render library must record which motion (and keyframe) backend produced a film.
//
// THE GAP. A completed row carried quality_tier and clip_deliveries but no motion_backend. Searching
// 60 rows for "own-gpu" or "seedance" returned zero even when seedance had demonstrably rendered a
// film -- because the column did not exist. Clip keys are GPU-assigned tokens and are not a
// substitute (film-model: keys are not derivable from module names).
//
// This suite drives the INSERT bind list AND the full read path (SELECT -> normalize -> public),
// the same shape that caught the output_ms write-only defect. A normalizer that maps a field the
// SQL never asked for would still pass against a stub that hands back the fixture; asserting the
// SQL itself closes that hole.

/** Raw D1 row as the shared column list would return it. */
const rawRow = (over: Record<string, unknown> = {}) => ({
  id: 9,
  public_id: "r_pub_9",
  job_id: "film-seedance-1",
  project: "rollins-cf278x-matrix",
  bundle_key: "bundles/keeper_log-3ed2f8a957ea4607.tar.gz",
  quality_tier: "standard",
  motion_backend: "seedance",
  keyframe_backend: "keyframe",
  render_overrides: null,
  status: "COMPLETED",
  output_key: "renders/film-seedance-1/film.mp4",
  output: JSON.stringify({ mode: "full" }),
  error: null,
  execution_time_ms: 622178,
  delay_time_ms: null,
  output_ms: 21141,
  submitted_at: 1785588189,
  updated_at: 1785589075,
  completed_at: 1785589075,
  label: null,
  keyframes_json: null,
  mode: "full",
  locked_shots_json: null,
  project_id: null,
  folder_path: null,
  tags_json: null,
  parent_id: null,
  project_public_id: null,
  parent_public_id: null,
  ...over,
});

function envWith(rows: Record<string, unknown>[]) {
  const sqlSeen: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        sqlSeen.push(sql);
        return {
          bind() { return this; },
          async first() { return rows[0] ?? null; },
          async all() { return { results: rows }; },
        };
      },
    },
  } as unknown as Env;
  return { env, sqlSeen };
}

/** Capture INSERT SQL + bind args from buildInsertRenderStmt. */
function captureInsert(row: Parameters<typeof buildInsertRenderStmt>[1]) {
  let sql = "";
  let binds: unknown[] = [];
  const env = {
    DB: {
      prepare(s: string) {
        sql = s;
        return {
          bind(...args: unknown[]) {
            binds = args;
            return this;
          },
        };
      },
    },
  } as unknown as Env;
  buildInsertRenderStmt(env, row);
  return { sql, binds };
}

describe("cf#393 motion_backend / keyframe_backend on the render row", () => {
  it("INSERT SQL names both columns and binds the resolved names", () => {
    const { sql, binds } = captureInsert({
      jobId: "film-x",
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      qualityTier: "final",
      status: "IN_QUEUE",
      motionBackend: "own-gpu",
      keyframeBackend: "keyframe",
    });
    expect(sql).toMatch(/motion_backend/);
    expect(sql).toMatch(/keyframe_backend/);
    // public_id, job_id, project, bundle_key, quality_tier, motion_backend, keyframe_backend, ...
    expect(binds[1]).toBe("film-x");
    expect(binds[4]).toBe("final");
    expect(binds[5]).toBe("own-gpu");
    expect(binds[6]).toBe("keyframe");
  });

  it("INSERT stores NULL when backends are omitted (keyframes-only / legacy)", () => {
    const { binds } = captureInsert({
      jobId: "film-kf-only",
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      qualityTier: "draft",
      status: "IN_QUEUE",
      mode: "keyframes-only",
    });
    expect(binds[5]).toBeNull();
    expect(binds[6]).toBeNull();
  });

  it("INSERT trims whitespace and collapses empty string to NULL", () => {
    const { binds } = captureInsert({
      jobId: "film-blank",
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      qualityTier: "final",
      status: "IN_QUEUE",
      motionBackend: "  seedance  ",
      keyframeBackend: "   ",
    });
    expect(binds[5]).toBe("seedance");
    expect(binds[6]).toBeNull();
  });

  it("getRenderByIdForUser returns motion_backend and keyframe_backend", async () => {
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 9);
    expect(row?.motion_backend).toBe("seedance");
    expect(row?.keyframe_backend).toBe("keyframe");
  });

  it("listRendersForUser returns them", async () => {
    const { env } = envWith([rawRow()]);
    const rows = await listRendersForUser(env, 10);
    expect(rows[0]?.motion_backend).toBe("seedance");
    expect(rows[0]?.keyframe_backend).toBe("keyframe");
  });

  it("THE ACTUAL DEFECT: the shared column list SELECTs both", async () => {
    const { env, sqlSeen } = envWith([rawRow()]);
    await listRendersForUser(env, 10);
    expect(sqlSeen[0]).toContain("r.motion_backend");
    expect(sqlSeen[0]).toContain("r.keyframe_backend");
    // Control: siblings still present so the match is on real SQL.
    expect(sqlSeen[0]).toContain("r.quality_tier");
    expect(sqlSeen[0]).toContain("r.output_ms");
  });

  it("reaches the CLIENT shape via toPublicRenderRow", async () => {
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 9);
    const pub = toPublicRenderRow(row!);
    expect(pub.motion_backend).toBe("seedance");
    expect(pub.keyframe_backend).toBe("keyframe");
    // Internal sequential ids stay out of the public shape.
    expect((pub as { public_id?: string }).public_id).toBeUndefined();
  });

  it("NULL / absent columns read as null, never the literal string \"null\"", async () => {
    const r = rawRow({ motion_backend: null, keyframe_backend: null });
    delete (r as Record<string, unknown>).motion_backend;
    delete (r as Record<string, unknown>).keyframe_backend;
    const { env } = envWith([r]);
    const row = await getRenderByIdForUser(env, 9);
    expect(row?.motion_backend).toBeNull();
    expect(row?.keyframe_backend).toBeNull();
  });

  it("filmRenderRowSeedFromJob carries backends off the film job", () => {
    const job: FilmJob = {
      film_id: "film-seed",
      project: "demo",
      bundle_key: "bundles/demo.tar.gz",
      scenes: [],
      motion_backend: "own-gpu",
      keyframe_backend: "keyframe",
      motion_config: {},
      finish_config: {},
      speech_config: {},
      film_finish_config: {},
      master_config: {},
      keyframe_binding: "MODULE_KEYFRAME",
      phase: "keyframe",
      created_at: Date.now(),
      phase_started_at: Date.now(),
      quality_tier: "final",
    };
    const seed = filmRenderRowSeedFromJob(job);
    expect(seed.motionBackend).toBe("own-gpu");
    expect(seed.keyframeBackend).toBe("keyframe");
  });
});
