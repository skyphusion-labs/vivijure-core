// vivijure-core#487: a status read of a render that is already terminal must not rewrite its completed_at,
// execution_time_ms or delay_time_ms. Every poll of a render goes through updateRenderFromView, and a film
// view's executionTimeMs is the elapsed time at the moment of the read, so before this fix a second read of a
// finished render made both columns say when the row was last READ (measured on vivijure-cf#1281: 12 rows
// went from 44,880..266,742 ms to 482,186..830,869 ms, and every completed_at moved to the second of the read).
//
// Real SQLite, the real cf schema, the shipped UPDATE text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";
import { insertRender, reopenRenderForFinishRetry, updateRenderFromView } from "../src/renders-db.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RunpodJobView } from "../src/runpod-submit.js";

let d1: TestD1;
beforeEach(() => { d1 = openTestD1(); });
afterEach(() => { d1.close(); vi.useRealTimers(); });
const env = () => ({ DB: d1.DB, R2_RENDERS: { head: async () => null, put: async () => null } }) as unknown as Env;

const JOB = "film-487";
const T0 = 1_794_000_000; // seconds

async function readAt(sec: number, view: Partial<RunpodJobView>) {
  vi.useFakeTimers();
  vi.setSystemTime(sec * 1000);
  await updateRenderFromView(env(), { jobId: JOB, statusRaw: "x", ...view } as RunpodJobView);
  vi.useRealTimers();
}

function row() {
  return d1.raw
    .prepare("SELECT status, completed_at, execution_time_ms, delay_time_ms FROM renders WHERE job_id = ?")
    .get(JOB) as { status: string; completed_at: number | null; execution_time_ms: number | null; delay_time_ms: number | null };
}

async function seed() {
  await insertRender(env(), { jobId: JOB, project: "p", bundleKey: "", qualityTier: "standard", status: "IN_PROGRESS" } as never);
}

describe("a terminal render keeps the record its first terminal view wrote (vivijure-core#487)", () => {
  it("in progress, the timings follow the view and nothing is completed", async () => {
    await seed();
    await readAt(T0 + 10, { status: "IN_PROGRESS", executionTimeMs: 10_000 });
    await readAt(T0 + 20, { status: "IN_PROGRESS", executionTimeMs: 20_000 });
    expect(row()).toMatchObject({ status: "IN_PROGRESS", completed_at: null, execution_time_ms: 20_000 });
  });

  it("the first terminal view records completed_at and the timings", async () => {
    await seed();
    await readAt(T0 + 30, { status: "COMPLETED", executionTimeMs: 44_880, delayTimeMs: 1_200 });
    expect(row()).toEqual({ status: "COMPLETED", completed_at: T0 + 30, execution_time_ms: 44_880, delay_time_ms: 1_200 });
  });

  it("a later read of the finished render changes none of them", async () => {
    await seed();
    await readAt(T0 + 30, { status: "COMPLETED", executionTimeMs: 44_880, delayTimeMs: 1_200 });
    await readAt(T0 + 500, { status: "COMPLETED", executionTimeMs: 482_186, delayTimeMs: 9_999 });
    await readAt(T0 + 900, { status: "COMPLETED", executionTimeMs: 830_869 });
    expect(row()).toEqual({ status: "COMPLETED", completed_at: T0 + 30, execution_time_ms: 44_880, delay_time_ms: 1_200 });
  });

  it("FAILED and CANCELLED are terminal too", async () => {
    for (const status of ["FAILED", "CANCELLED"] as const) {
      d1.raw.prepare("DELETE FROM renders WHERE job_id = ?").run(JOB);
      await seed();
      await readAt(T0 + 40, { status, executionTimeMs: 7_000 });
      await readAt(T0 + 400, { status, executionTimeMs: 70_000 });
      expect(row()).toMatchObject({ status, completed_at: T0 + 40, execution_time_ms: 7_000 });
    }
  });

  it("a finish retry reopens the row and measures again", async () => {
    await seed();
    await readAt(T0 + 30, { status: "COMPLETED", executionTimeMs: 44_880 });
    await reopenRenderForFinishRetry(env(), JOB);
    expect(row()).toMatchObject({ status: "IN_PROGRESS", completed_at: null });
    await readAt(T0 + 600, { status: "COMPLETED", executionTimeMs: 600_000 });
    expect(row()).toMatchObject({ status: "COMPLETED", completed_at: T0 + 600, execution_time_ms: 600_000 });
  });

  it("CONTROL: the harness has the real schema and the row is the one under test", async () => {
    expect(d1.applied.length).toBeGreaterThan(0);
    await seed();
    expect(row()).toMatchObject({ status: "IN_PROGRESS", completed_at: null, execution_time_ms: null });
  });
});
