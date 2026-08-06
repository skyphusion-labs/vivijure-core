import { describe, it, expect } from "vitest";
import { getRenderByIdForUser, listRendersForUser, toPublicRenderRow, markFinishDone } from "../src/renders-db.js";
import { normalizeFinishElapsedMs, accumulateFinishElapsed } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// cf#268: renders.finish_elapsed_ms must be written AND readable (same class of defect as
// output_ms write-only in 1.7.0).

const rawRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  public_id: "r_pub_7",
  job_id: "film-abc",
  project: "p",
  bundle_key: "bundles/p.tar.gz",
  quality_tier: "final",
  render_overrides: null,
  status: "COMPLETED",
  output_key: "renders/film-abc/film-ff1.mp4",
  output: JSON.stringify({ output_key: "renders/film-abc/film-ff1.mp4", project: "p", mode: "full" }),
  error: null,
  execution_time_ms: 888173,
  delay_time_ms: null,
  output_ms: 47250,
  finish_elapsed_ms: 12345,
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
  const binds: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        sqlSeen.push(sql);
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            return this;
          },
          async first() { return rows[0] ?? null; },
          async all() { return { results: rows }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    },
  } as unknown as Env;
  return { env, sqlSeen, binds };
}

describe("normalizeFinishElapsedMs / accumulateFinishElapsed (cf#268)", () => {
  it("accepts non-negative finite numbers as rounded integers", () => {
    expect(normalizeFinishElapsedMs(12.4)).toBe(12);
    expect(normalizeFinishElapsedMs(0)).toBe(0);
  });
  it("rejects unusable values", () => {
    for (const bad of [undefined, null, -1, NaN, Infinity, "12"]) {
      expect(normalizeFinishElapsedMs(bad), String(bad)).toBeNull();
    }
  });
  it("sums successive container elapseds onto the job", () => {
    const job: { finish_elapsed_ms?: number } = {};
    accumulateFinishElapsed(job, 100);
    accumulateFinishElapsed(job, 50.6);
    accumulateFinishElapsed(job, undefined);
    expect(job.finish_elapsed_ms).toBe(151);
  });
});

describe("finish_elapsed_ms write path (cf#268)", () => {
  it("markFinishDone binds finish_elapsed_ms before job_id", async () => {
    const { env, binds, sqlSeen } = envWith([]);
    await markFinishDone(env, "film-abc", "k.mp4", "{}", 47250, 999);
    expect(sqlSeen.some((s) => s.includes("finish_elapsed_ms"))).toBe(true);
    const last = binds[binds.length - 1];
    expect(last.at(-1)).toBe("film-abc");
    expect(last.at(-2)).toBe(999);
    expect(last.at(-3)).toBe(47250);
  });

  it("omitting finishElapsedMs binds null (does not invent zero)", async () => {
    const { env, binds } = envWith([]);
    await markFinishDone(env, "film-abc", "k.mp4", "{}", 47250);
    expect(binds[binds.length - 1].at(-2)).toBeNull();
  });
});

describe("finish_elapsed_ms survives the read path (cf#268)", () => {
  it("getRenderByIdForUser returns it as a number", async () => {
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.finish_elapsed_ms).toBe(12345);
  });

  it("listRendersForUser SELECTs the column", async () => {
    const { env, sqlSeen } = envWith([rawRow()]);
    await listRendersForUser(env, 10);
    expect(sqlSeen[0]).toContain("r.finish_elapsed_ms");
  });

  it("reaches the client shape", async () => {
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 7);
    expect(toPublicRenderRow(row!).finish_elapsed_ms).toBe(12345);
  });

  it("NULL stays NULL", async () => {
    const { env } = envWith([rawRow({ finish_elapsed_ms: null })]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.finish_elapsed_ms).toBeNull();
  });

  it("absent column reads null not NaN", async () => {
    const r = rawRow();
    delete (r as Record<string, unknown>).finish_elapsed_ms;
    const { env } = envWith([r]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.finish_elapsed_ms).toBeNull();
    expect(Number.isNaN(row?.finish_elapsed_ms as number)).toBe(false);
  });
});
