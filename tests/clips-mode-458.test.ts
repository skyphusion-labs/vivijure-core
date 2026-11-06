// vivijure-core#458: a standalone clip job row reads back with mode "clips", not "full".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";
import { insertRender, listRendersForUser, RENDER_MODES, toPublicRenderRow } from "../src/renders-db.js";
import type { Env } from "../src/platform/orchestrator-context.js";

let d1: TestD1;
beforeEach(() => { d1 = openTestD1(); });
afterEach(() => d1.close());
const env = () => ({ DB: d1.DB }) as unknown as Env;
const seed = (jobId: string, mode?: string) => ({ jobId, project: "p", bundleKey: "", qualityTier: "final", status: "IN_PROGRESS", ...(mode ? { mode } : {}) });

describe("the clips render mode (vivijure-core#458)", () => {
  it("a row inserted as clips lists as clips", async () => {
    await insertRender(env(), seed("clips-a", "clips") as never);
    const rows = await listRendersForUser(env());
    expect(rows.map((r) => [r.job_id, r.mode])).toEqual([["clips-a", "clips"]]);
    expect(toPublicRenderRow(rows[0]).mode).toBe("clips");
  });
  it("every known mode passes through, and an unknown or NULL one reads as full", async () => {
    for (const m of RENDER_MODES) await insertRender(env(), seed(`job-${m}`, m) as never);
    d1.raw.prepare("INSERT INTO renders (job_id, project, bundle_key, quality_tier, status, submitted_at, updated_at, mode) VALUES ('job-odd', 'p', '', 'final', 'IN_PROGRESS', 1, 1, 'scatter')").run();
    d1.raw.prepare("INSERT INTO renders (job_id, project, bundle_key, quality_tier, status, submitted_at, updated_at, mode) VALUES ('job-null', 'p', '', 'final', 'IN_PROGRESS', 1, 1, NULL)").run();
    const byId = Object.fromEntries((await listRendersForUser(env())).map((r) => [r.job_id, r.mode]));
    for (const m of RENDER_MODES) expect(byId[`job-${m}`]).toBe(m);
    expect(byId["job-odd"]).toBe("full");
    expect(byId["job-null"]).toBe("full");
  });
  it("CONTROL: the set is the five modes, clips among them", () => {
    expect([...RENDER_MODES].sort()).toEqual(["clips", "cloud-finalized", "finalized", "full", "keyframes-only"]);
  });
});
