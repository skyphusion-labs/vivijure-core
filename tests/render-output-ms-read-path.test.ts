import { describe, it, expect } from "vitest";
import { getRenderByIdForUser, listRendersForUser, toPublicRenderRow } from "../src/renders-db.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// renders.output_ms MUST SURVIVE THE READ PATH, NOT JUST THE WRITE.
//
// THE DEFECT THIS EXISTS FOR, AND IT WAS MINE. 1.7.0 shipped the capture: markFinishDone writes
// renders.output_ms, the metering basis. It added the column to NO read path -- not the shared
// column list, not the raw row type, not the normalizer -- so the value was write-only. Nothing
// could observe it: not the panel, not the meter that will eventually bill on it, and not the smoke
// meant to prove it landed. The only way to see it was an account-credentialled D1 query.
//
// WHY MY OWN SUITE COULD NOT CATCH IT. Every test I wrote for 1.7.0 asserted the WRITE, through a
// stubbed D1 binding -- it inspected the bind parameters of the UPDATE. A capture path with no
// reader passes every test that only exercises capture. The stub was the boundary, so the read side
// was not merely untested, it was OUT OF FRAME.
//
// So this drives the REAL read functions and asserts the value arrives on the shape a client
// receives. It fails on the 1.7.0 code, which is the only reason to trust it.
//
// A note on the shape it guards: RENDER_ROW_COLUMNS -> RawRenderRow -> normalizeRow -> RenderRow ->
// toPublicRenderRow. Four hops, and a field dropped at ANY of them vanishes silently with no type
// error, because the SQL column list is a template string the compiler cannot check against the
// row interface. That is exactly how it went missing.

/** A raw D1 row as the shared column list would return it. `output_ms` present and integer. */
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

/** Records the SQL it was handed, so a test can assert the column was actually SELECTed rather than
 *  only that the normalizer would have copied it had it been there. Those are different claims and
 *  only one of them catches the real defect. */
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

describe("output_ms survives the read path (the 1.7.0 write-only defect)", () => {
  it("getRenderByIdForUser returns it as a number", async () => {
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.output_ms).toBe(47250);
  });

  it("listRendersForUser returns it as a number", async () => {
    const { env } = envWith([rawRow()]);
    const rows = await listRendersForUser(env, 10);
    expect(rows[0]?.output_ms).toBe(47250);
  });

  it("THE ACTUAL DEFECT: the shared column list SELECTs it", async () => {
    // The normalizer could map a field the SQL never asked for and every assertion above would still
    // pass against this stub, because the stub hands back whatever the fixture contains rather than
    // what the query requested. Against a REAL D1 the column would simply be absent. So assert the
    // SQL itself.
    const { env, sqlSeen } = envWith([rawRow()]);
    await listRendersForUser(env, 10);
    expect(sqlSeen.length).toBeGreaterThan(0);
    expect(sqlSeen[0]).toContain("r.output_ms");
    // CONTROL: the matcher is looking at real SQL that contains the sibling columns, so a pass above
    // is not an artefact of matching an empty or unrelated string.
    expect(sqlSeen[0]).toContain("r.execution_time_ms");
    expect(sqlSeen[0]).toContain("r.delay_time_ms");
  });

  it("reaches the CLIENT shape, not just the internal row", async () => {
    // toPublicRenderRow spreads ...rest, so this passes by construction today -- which is the point
    // of asserting it: if anyone converts that spread into a hand-listed projection, this fails.
    const { env } = envWith([rawRow()]);
    const row = await getRenderByIdForUser(env, 7);
    const pub = toPublicRenderRow(row!);
    expect(pub.output_ms).toBe(47250);
  });

  it("NULL stays NULL and is never coalesced to zero", async () => {
    // The distinction the whole column rests on: NULL is "not measured", 0 is "a film of no length".
    // A billing query that cannot tell them apart bills nothing for a real render.
    const { env } = envWith([rawRow({ output_ms: null })]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.output_ms).toBeNull();
    expect(row?.output_ms).not.toBe(0);
  });

  it("a legacy row with the field ABSENT reads null, not NaN", async () => {
    // Rows written before migration 0016 have no such column. Number(undefined) is NaN, which would
    // serialize to null in JSON and look identical to an honest null while being a different bug.
    const r = rawRow();
    delete (r as Record<string, unknown>).output_ms;
    const { env } = envWith([r]);
    const row = await getRenderByIdForUser(env, 7);
    expect(row?.output_ms).toBeNull();
    expect(Number.isNaN(row?.output_ms as number)).toBe(false);
  });
});
