// core#180 -- the cron sweep was capped at 25 per pass and ordered oldest-first, so the newest
// films were never swept.
//
// These tests drive the SHIPPED queries (imported, never restated) against a REAL SQLite engine
// carrying the REAL vivijure-cf schema. A recording fake cannot observe this defect at all: the
// defect IS the ORDER BY / LIMIT semantics, and a fake returns whatever it was told to. That is
// why the six existing renders-db tests, all of which pass, said nothing about it.
//
// PRE-FIX MEASUREMENT, taken with this same harness against c74ab92 before any change:
//   40 unresolved films, 10 ticks -> reached 25, NEVER REACHED 15 (film-025..film-039).
//   25 unresolvable films, 100 ticks -> the 15 behind them attempted ZERO times.
//   a film in phase "done" past 24h -> returned by NEITHER pass.
// Every assertion below is the inverse of one of those, and each was watched failing first.
//
// Controls run BEFORE claims, in the same test, so an absence is never mistaken for a finding.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countStrandedPostClipsFilmJobs,
  countUnresolvedNotifiableJobs,
  listStrandedPostClipsFilmJobs,
  listUnresolvedNotifiableJobs,
} from "../src/renders-db.js";
import {
  SWEEP_MAX_AGE_SECONDS,
  SWEEP_PAGE_SIZE,
  SWEEP_TICK_SECONDS,
  rotatingOffset,
  sweepUnresolvedJobs,
} from "../src/render-sweep.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

const NOW = Math.floor(Date.now() / 1000);

let d1: TestD1;
let env: Env;

function seed(opts: {
  jobId: string;
  submittedAt: number;
  status?: string;
  outputJson?: string | null;
}): void {
  d1.raw
    .prepare(
      `INSERT INTO renders (job_id, status, submitted_at, output_json, notified_at, mode, parent_id)
       VALUES (?, ?, ?, ?, NULL, 'full', NULL)`,
    )
    .run(opts.jobId, opts.status ?? "IN_PROGRESS", opts.submittedAt, opts.outputJson ?? null);
}

/** Population read independently of the code under test. A "never reached" claim is meaningless
 *  without the denominator, and a zero denominator makes every such claim vacuously true. */
function unresolvedTotal(): number {
  const row = d1.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM renders
        WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED')
          AND notified_at IS NULL
          AND COALESCE(mode,'full') != 'keyframes-only'
          AND parent_id IS NULL`,
    )
    .get() as { n: number };
  return Number(row.n);
}

/** Sweep one tick's worth of pass 1 the way render-sweep.ts does: count, rotate, list. */
async function pass1Tick(windowIndex: number): Promise<string[]> {
  const total = await countUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
  const offset = rotatingOffset(total, SWEEP_PAGE_SIZE, windowIndex);
  return listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS, SWEEP_PAGE_SIZE, offset);
}

beforeEach(() => {
  d1 = openTestD1();
  env = { DB: d1.DB } as unknown as Env;
});

describe("core#180 rotatingOffset", () => {
  it("is a no-op when the population fits in one page, or when the total is UNMEASURED", () => {
    expect(rotatingOffset(10, 25, 7)).toBe(0);
    expect(rotatingOffset(25, 25, 7)).toBe(0);
    // null is "could not read the count", NOT zero. Rotation off, today's behaviour, and the
    // caller reports the null rather than rendering it as full coverage.
    expect(rotatingOffset(null, 25, 7)).toBe(0);
  });

  it("walks every page and wraps, so coverage is complete every ceil(total/limit) ticks", () => {
    const total = 40; // -> 2 windows: [0,25) and [25,40)
    expect(rotatingOffset(total, 25, 0)).toBe(0);
    expect(rotatingOffset(total, 25, 1)).toBe(25);
    expect(rotatingOffset(total, 25, 2)).toBe(0); // wrapped
    expect(rotatingOffset(total, 25, 3)).toBe(25);
    // Negative / clock-skewed window indexes must not produce a negative OFFSET.
    expect(rotatingOffset(total, 25, -1)).toBe(25);
    expect(rotatingOffset(total, 25, -2)).toBe(0);
  });
});

describe("core#180 sweep cap + ordering", () => {
  it("CONTROL: the harness applies the real schema and the shipped query can see rows", async () => {
    expect(d1.applied.length).toBeGreaterThan(0);
    expect(d1.applied).toContain("0001_init.sql");

    seed({ jobId: "film-control-a", submittedAt: NOW - 100 });
    seed({ jobId: "film-control-b", submittedAt: NOW - 50 });
    expect(unresolvedTotal()).toBe(2);

    const ids = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
    // POSITIVE control: non-empty proves the query reaches the table. An empty result here would
    // make every "reached" assertion below unfalsifiable.
    expect(ids).toEqual(["film-control-a", "film-control-b"]);
    expect(await countUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS)).toBe(2);
  });

  it("MEASURED: 40 unresolved films are ALL reached within ceil(40/25) = 2 ticks", async () => {
    const N = 40;
    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const jobId = `film-${String(i).padStart(3, "0")}`;
      ids.push(jobId);
      seed({ jobId, submittedAt: NOW - (N - i) * 60 });
    }
    expect(unresolvedTotal()).toBe(N);

    const reached = new Set<string>();
    for (let tick = 0; tick < 2; tick += 1) {
      for (const id of await pass1Tick(tick)) reached.add(id);
    }
    const never = ids.filter((id) => !reached.has(id));
    console.log(
      `core#180 pass-1 coverage: unresolved=${N} reached_in_2_ticks=${reached.size} never_reached=${never.length}`,
    );
    expect(never).toEqual([]); // pre-fix this was 15 rows: film-025..film-039
    expect(reached.size).toBe(N);
  });

  it("MEASURED head-of-line: 25 films that can never resolve do not hold the queue", async () => {
    const N = 40;
    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const jobId = `film-${String(i).padStart(3, "0")}`;
      ids.push(jobId);
      seed({ jobId, submittedAt: NOW - (N - i) * 60 });
    }
    const BLOCKERS = 25; // exactly the page size: enough to occupy every slot under oldest-first
    const stuck = new Set(ids.slice(0, BLOCKERS));

    // Drain model: any reachable film that is not stuck resolves this tick. Only the ORDERING and
    // the PAGE SIZE come from the shipped code; the drain rule is the model, and it is stated so
    // it can be attacked rather than hidden inside the assertion.
    const reached = new Set<string>();
    for (let tick = 0; tick < 100; tick += 1) {
      const got = await pass1Tick(tick);
      if (got.length === 0) break;
      for (const id of got) {
        reached.add(id);
        if (!stuck.has(id)) {
          d1.raw.prepare(`UPDATE renders SET status = 'COMPLETED' WHERE job_id = ?`).run(id);
        }
      }
    }
    const never = ids.filter((id) => !reached.has(id));
    console.log(
      `core#180 head-of-line: blockers=${BLOCKERS} reached=${reached.size} never_reached=${never.length}`,
    );
    expect(never).toEqual([]); // pre-fix: 15 films, zero attempts in 100 ticks
    // And the 15 behind the blockers actually finished, rather than merely being looked at.
    const open = unresolvedTotal();
    expect(open).toBe(BLOCKERS);
  });

  it("MEASURED consequence 3: a film in phase 'done' past 24h is now picked up", async () => {
    const old = NOW - 25 * 3600;
    // CONTROL first: the phase-'finish' row proves pass 2 matches anything at all here.
    seed({
      jobId: "film-finish-old",
      submittedAt: old,
      outputJson: JSON.stringify({ phase: "finish" }),
    });
    const control = await listStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS);
    expect(control).toEqual(["film-finish-old"]);

    seed({
      jobId: "film-done-old",
      submittedAt: old + 1,
      outputJson: JSON.stringify({ phase: "done" }),
    });
    const pass1 = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
    const pass2 = await listStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS);
    console.log(`core#180 done-gap: pass1=[${pass1.join(",")}] pass2=[${pass2.join(",")}]`);
    expect(pass1).not.toContain("film-done-old"); // still outside the 24h window, by design
    expect(pass2).toContain("film-done-old"); // pre-fix: absent from BOTH passes, open forever
    expect(pass2).toContain("film-finish-old"); // control still firing
    expect(await countStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS)).toBe(2);
  });
});

describe("core#180 sweepUnresolvedJobs wiring", () => {
  it("rotates its window from the clock and reports coverage as a structured event", async () => {
    const N = 40;
    for (let i = 0; i < N; i += 1) {
      seed({ jobId: `job-${String(i).padStart(3, "0")}`, submittedAt: NOW - (N - i) * 60 });
    }
    const r2 = { head: async () => null, get: async () => null };
    const wired = { DB: d1.DB, R2_RENDERS: r2 } as unknown as Env;

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    vi.useFakeTimers();
    try {
      // Two ticks a full cadence apart. The window index is derived from the clock, so this is
      // the seam where the rotation actually meets the queries -- a unit test of rotatingOffset
      // alone cannot observe a caller that forgets to pass the offset through.
      vi.setSystemTime(new Date(0));
      await sweepUnresolvedJobs(wired);
      vi.setSystemTime(new Date(SWEEP_TICK_SECONDS * 1000));
      await sweepUnresolvedJobs(wired);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }

    const events = lines
      .filter((l) => l.startsWith("@event render_sweep "))
      .map((l) => JSON.parse(l.slice("@event render_sweep ".length)) as Record<string, never>);
    // Denominator: two ticks must produce two events. Zero events would make the rest vacuous.
    expect(events.length).toBe(2);
    console.log(`core#180 sweep events: ${JSON.stringify(events)}`);

    const p = events.map((e) => e.pass1 as unknown as Record<string, number>);
    expect(p[0].total).toBe(N); // coverage is now measurable at all -- it was not before
    expect(p[0].offset).toBe(0);
    expect(p[1].offset).toBe(SWEEP_PAGE_SIZE); // the window MOVED between ticks
    expect(p[0].returned + p[1].returned).toBe(N); // and the two pages cover the population
  });

  it("CROSS-REPO CONTROL: a fake whose COUNT query returns rows degrades to offset 0, never to a wrong offset", async () => {
    // vivijure-cf/tests/render-sweep.test.ts routes D1 queries by SQL TEXT and returns its canned
    // row array for anything matching `submitted_at >= ?` -- which now includes the COUNT query.
    // That fake must keep working, and it must degrade to TODAY's behaviour rather than to a
    // plausible wrong window. This reproduces its shape.
    const rows = [{ job_id: "job-a" }, { job_id: "job-b" }];
    const fakeEnv = {
      DB: {
        prepare: (sql: string) => {
          const isStranded = sql.includes('"phase":"assemble"');
          const inWindow = sql.includes("submitted_at >= ?") && !isStranded;
          const node = {
            bind: () => node,
            all: async () => ({ results: inWindow ? rows : [] }),
            first: async () => null,
            run: async () => ({ success: true }),
          };
          return node;
        },
      },
      R2_RENDERS: { head: async () => null, get: async () => null },
    } as unknown as Env;

    const total = await countUnresolvedNotifiableJobs(fakeEnv, SWEEP_MAX_AGE_SECONDS);
    // The count came back row-shaped, so `total` is UNMEASURED. Reporting 0 here would disable
    // rotation AND claim full coverage in the same breath.
    expect(total).toBeNull();
    expect(rotatingOffset(total, SWEEP_PAGE_SIZE, 99)).toBe(0);
    const ids = await listUnresolvedNotifiableJobs(fakeEnv, SWEEP_MAX_AGE_SECONDS, SWEEP_PAGE_SIZE, 0);
    expect(ids).toEqual(["job-a", "job-b"]); // the cf fake's contract still holds
  });
});

// ---------------------------------------------------------------------------------------------
// THE TIEBREAKER. Added after two independent reviewers found that mutating `, id ASC` out of both
// queries left all 8 tests above GREEN -- the suite never tied two rows, so it was structurally
// incapable of observing the tiebreaker, while the commit message claimed every behaviour had its
// own mutation. The false coverage claim was the worse half: a gap invites a second look, a claim
// of coverage forecloses one.
//
// WHY A NAIVE TIE TEST DOES NOT KILL THE MUTATION, established by probe before writing this:
// on a plain table scan SQLite returns ties in ROWID order, and `id` IS the rowid, so
// `ORDER BY submitted_at ASC` and `ORDER BY submitted_at ASC, id ASC` agree. That is why a reviewer
// could not reproduce the necessity in 300 attempts, and it is a fact about the current plan rather
// than a guarantee. Measured, same tied rows, `ORDER BY submitted_at ASC` with no tiebreaker:
//     as shipped                             -> film-000..005  (rowid order; idx_renders_parent)
//     + index (submitted_at DESC)            -> film-000..005  (planner does NOT take it)
//     + index (parent_id, submitted_at DESC) -> film-011..006  <-- REVERSED, and the planner DOES take it
// The last of those is the index someone would add to make THIS sweep query faster: it covers the
// WHERE's `parent_id IS NULL` and the ordering column. So the natural optimisation of this very
// query is what exposes the unspecified order, which is what makes it worth guarding. The property
// worth asserting is therefore PLAN INDEPENDENCE, and that is what the second test drives.
describe("core#180 the tiebreaker: ties are real, and the order must not depend on the plan", () => {
  /** Seed `n` rows that ALL share one submitted_at. INTEGER seconds means a bulk submit does this. */
  function seedTied(n: number, at: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const jobId = `film-tie-${String(i).padStart(3, "0")}`;
      ids.push(jobId);
      seed({ jobId, submittedAt: at });
    }
    return ids;
  }

  it("CONTROL: the rows really are tied, so this file is no longer blind to the tiebreaker", () => {
    seedTied(63, NOW - 600);
    const distinct = d1.raw
      .prepare(`SELECT COUNT(DISTINCT submitted_at) AS d, COUNT(*) AS n FROM renders`)
      .get() as { d: number; n: number };
    // The 8 tests above never produced this state -- every one gave each row a distinct second.
    expect(distinct.n).toBe(63);
    expect(distinct.d).toBe(1);
  });

  it("MEASURED: under 63-way ties the rotation still covers every row, gap-free and duplicate-free, and repeats", async () => {
    const N = 63; // 3 windows at page size 25: 25 + 25 + 13
    const ids = seedTied(N, NOW - 600);
    expect(await countUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS)).toBe(N);
    const windows = Math.ceil(N / SWEEP_PAGE_SIZE);
    expect(windows).toBe(3);

    const cycle = async () => {
      const pages: string[][] = [];
      for (let w = 0; w < windows; w += 1) pages.push(await pass1Tick(w));
      return pages;
    };
    const first = await cycle();
    const second = await cycle();

    const flat = first.flat();
    expect(flat.length).toBe(N); // gap-free AND duplicate-free: the pages partition the population
    expect(new Set(flat).size).toBe(N);
    expect([...flat].sort()).toEqual([...ids].sort());
    // A second full cycle must reproduce the first page-for-page. An unstable order under ties
    // would let a row be served twice in one cycle and skipped in the next.
    expect(second).toEqual(first);
    console.log(
      `core#180 tie coverage: n=${N} windows=${windows} pages=[${first.map((p) => p.length).join(",")}] ` +
        `unique=${new Set(flat).size} cycle2==cycle1=${JSON.stringify(second) === JSON.stringify(first)}`,
    );
  });

  it("MEASURED: the page must not change when the planner picks a different index (this is what `, id ASC` buys)", async () => {
    const N = 40;
    seedTied(N, NOW - 600);

    // Plan 1: whatever the planner picks with the schema as shipped.
    const before = await pass1Tick(0);
    expect(before.length).toBe(SWEEP_PAGE_SIZE); // control: the query returned a full page at all

    // Plan 2: the index someone would add to make THIS sweep query faster -- it covers the WHERE's
    // `parent_id IS NULL` and the ordering column, so the planner takes it over the shipped
    // `idx_renders_parent`.
    //
    // The first draft of this test used a bare `(submitted_at DESC)` index and PASSED, because the
    // planner never took it and the plan therefore never changed. The `usesIndex` control below is
    // what caught that: without it, `same_page=true` would have read as proof of plan independence
    // from a run in which nothing was independent of anything.
    d1.raw.exec(`CREATE INDEX idx_tie_probe ON renders (parent_id, submitted_at DESC)`);
    const after = await pass1Tick(0);

    // CONTROL that the new index is actually being used, so a pass cannot come from the planner
    // ignoring it: the query plan must name it.
    const plan = d1.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT job_id FROM renders
           WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') AND notified_at IS NULL
             AND COALESCE(mode,'full') != 'keyframes-only' AND parent_id IS NULL
             AND submitted_at >= 0
           ORDER BY submitted_at ASC, id ASC LIMIT 25 OFFSET 0`,
      )
      .all() as { detail: string }[];
    const usesIndex = plan.some((r) => /idx_tie_probe/.test(r.detail));
    console.log(
      `core#180 plan independence: uses_new_index=${usesIndex} same_page=${JSON.stringify(after) === JSON.stringify(before)} ` +
        `plan="${plan.map((r) => r.detail).join(" | ")}"`,
    );
    expect(usesIndex).toBe(true); // if false, this test proves nothing and must not read as a pass

    // THE ASSERTION. Without `, id ASC` the DESC index is walked backwards and the tied rows come
    // back reversed, so this page is a different 25 films.
    expect(after).toEqual(before);
  });
});
