import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FILM_SUBMIT_CLAIMS_DDL,
  FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS,
  claimFilmSubmit,
  filmSubmitClaimKey,
  naturalKeyForStartFilmJob,
  naturalKeyForStartFromKeyframes,
  releaseFilmSubmitClaim,
} from "../src/film-submit-idempotency.js";
import type { Database, PreparedStatement } from "../src/platform/types.js";

// ---------------------------------------------------------------- a real-enough D1 fake
//
// Mirrors tests/storage-quota.test.ts: the fake implements the exact statements the module issues
// rather than pattern-matching loosely, so a change to the SQL that the fake does not understand
// FAILS here instead of silently no-oping.
//
// It implements SQLite's `ON CONFLICT ... DO UPDATE ... WHERE` semantics for real, because the whole
// guard is that one statement: the WHERE arm is what lets an EXPIRED claim be taken over, and the
// load-bearing false-positive test rides on it.

interface ClaimRow {
  film_id: string;
  claimed_at: number;
}

interface FakeDb extends Database {
  rows: Map<string, ClaimRow>;
  calls: string[];
  tableExists: boolean;
  /** Emulate a host whose D1 shim does not report `meta.changes` (the blind-changes defence). */
  blindChanges: boolean;
  failNext?: string;
}

function fakeDb(opts: { tableExists?: boolean; blindChanges?: boolean } = {}): FakeDb {
  const rows = new Map<string, ClaimRow>();
  const calls: string[] = [];
  const db = {
    rows,
    calls,
    tableExists: opts.tableExists ?? false,
    blindChanges: opts.blindChanges ?? false,
  } as FakeDb;

  const make = (norm: string, bound: unknown[]): PreparedStatement => ({
    bind(...values: unknown[]) {
      return make(norm, values);
    },
    async first<T>() {
      calls.push(norm);
      if (db.failNext && norm.includes(db.failNext)) throw new Error("db exploded");
      if (norm.startsWith("SELECT film_id FROM film_submit_claims")) {
        if (!db.tableExists) throw new Error("no such table: film_submit_claims");
        const row = rows.get(String(bound[0]));
        // The SELECT carries the window in its own WHERE, so an expired row is not returned.
        if (!row) return null;
        if (row.claimed_at <= Number(bound[1])) return null;
        return { film_id: row.film_id } as T;
      }
      throw new Error(`fake db does not understand: ${norm}`);
    },
    async run() {
      calls.push(norm);
      if (db.failNext && norm.includes(db.failNext)) throw new Error("db exploded");
      if (norm.startsWith("CREATE TABLE IF NOT EXISTS film_submit_claims")) {
        db.tableExists = true;
        return { success: true, meta: { changes: 0 } };
      }
      if (!db.tableExists) throw new Error("no such table: film_submit_claims");
      if (norm.startsWith("INSERT INTO film_submit_claims")) {
        const key = String(bound[0]);
        const filmId = String(bound[1]);
        const now = Number(bound[2]);
        const cutoff = Number(bound[3]);
        const existing = rows.get(key);
        let changes = 0;
        if (!existing) {
          rows.set(key, { film_id: filmId, claimed_at: now });
          changes = 1;
        } else if (existing.claimed_at <= cutoff) {
          // The DO UPDATE ... WHERE arm: an expired claim is taken over, window reset.
          rows.set(key, { film_id: filmId, claimed_at: now });
          changes = 1;
        }
        return { success: true, meta: db.blindChanges ? {} : { changes } };
      }
      if (norm.startsWith("DELETE FROM film_submit_claims")) {
        const key = String(bound[0]);
        const filmId = String(bound[1]);
        const existing = rows.get(key);
        let changes = 0;
        // Scoped by film_id so a release can never take another submit's live claim.
        if (existing && existing.film_id === filmId) {
          rows.delete(key);
          changes = 1;
        }
        return { success: true, meta: { changes } };
      }
      throw new Error(`fake db does not understand: ${norm}`);
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });

  db.prepare = (sql: string) => make(sql.replace(/\s+/g, " ").trim(), []);
  return db;
}

const envWith = (db: Database | undefined) => ({ DB: db }) as never;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- CONTROL: the fake itself
//
// Every assertion below rides on this fake behaving like D1. Run the control FIRST, then the claim
// (N318): a failed control arriving underneath a conclusion already written is exactly when it gets
// rationalised past.

describe("the DB fake itself (control)", () => {
  it("binds per statement, and honours the DO UPDATE ... WHERE arm", async () => {
    const db = fakeDb({ tableExists: true });
    const stmt = db.prepare(
      `INSERT INTO film_submit_claims (claim_key, film_id, claimed_at) VALUES (?, ?, ?)
       ON CONFLICT(claim_key) DO UPDATE SET film_id = excluded.film_id, claimed_at = excluded.claimed_at
       WHERE film_submit_claims.claimed_at <= ?`,
    );
    // t=1000, nothing present -> INSERT arm, 1 change.
    const first = await stmt.bind("k", "film-a", 1000, 940).run();
    expect(first.meta?.changes).toBe(1);
    // t=1010, live claim (1000 > 950 cutoff) -> WHERE fails, 0 changes, row untouched.
    const second = await stmt.bind("k", "film-b", 1010, 950).run();
    expect(second.meta?.changes).toBe(0);
    expect(db.rows.get("k")).toEqual({ film_id: "film-a", claimed_at: 1000 });
    // t=1100, claim expired (1000 <= 1040 cutoff) -> DO UPDATE arm fires, 1 change, row replaced.
    const third = await stmt.bind("k", "film-c", 1100, 1040).run();
    expect(third.meta?.changes).toBe(1);
    expect(db.rows.get("k")).toEqual({ film_id: "film-c", claimed_at: 1100 });
  });

  it("throws on a missing table, exactly as D1 does", async () => {
    const db = fakeDb({ tableExists: false });
    await expect(
      db.prepare("INSERT INTO film_submit_claims (claim_key) VALUES (?)").bind("k").run(),
    ).rejects.toThrow(/no such table/);
  });
});

// ---------------------------------------------------------------- the natural key
//
// The per-dimension discrimination fixture (not a global one): for EVERY field that changes what
// gets rendered, a pair differing ONLY along that axis must produce a DIFFERENT key. A single
// "two different submits differ" assertion passes against an implementation that hashes only
// `project`, which is the tautology this shape exists to defeat.

const BASE_START = {
  project: "p1",
  bundle_key: "b/1.tar",
  scenes: [{ shot_id: "s1", prompt: "a" }],
  motion_backend: "own-gpu",
  keyframe_backend: "keyframe",
  keyframe_config: { steps: 20 },
  motion_config: { fps: 24 },
  finish_config: { upscale: { factor: 2 } },
  speech_config: {},
  film_finish_config: {},
  master_config: {},
  keyframes_only: false,
  clips_only: false,
  pretrained_loras: { hero: "k/hero.safetensors" },
  quality_tier: "final" as const,
  audio_key: "a/bed.mp3",
  dialogue_lines: [{ shot_id: "s1", text: "hello" }],
  cast_loras: { hero: 1 },
  film_titles: { title: { text: "T" } },
};

describe("the natural key discriminates on every render-affecting field", () => {
  const mutations: [string, Record<string, unknown>][] = [
    ["project", { project: "p2" }],
    ["bundle_key", { bundle_key: "b/2.tar" }],
    ["scenes", { scenes: [{ shot_id: "s1", prompt: "DIFFERENT" }] }],
    ["motion_backend", { motion_backend: "seedance" }],
    ["keyframe_backend", { keyframe_backend: "cloud-keyframe" }],
    ["keyframe_config", { keyframe_config: { steps: 40 } }],
    ["motion_config", { motion_config: { fps: 30 } }],
    ["finish_config", { finish_config: { upscale: { factor: 4 } } }],
    ["speech_config", { speech_config: { tts: { voice: "x" } } }],
    ["film_finish_config", { film_finish_config: { captions: { on: true } } }],
    ["master_config", { master_config: { lufs: { target: -14 } } }],
    ["keyframes_only", { keyframes_only: true }],
    ["clips_only", { clips_only: true }],
    ["pretrained_loras", { pretrained_loras: { hero: "k/other.safetensors" } }],
    ["quality_tier", { quality_tier: "draft" as const }],
    ["audio_key", { audio_key: "a/other.mp3" }],
    ["dialogue_lines", { dialogue_lines: [{ shot_id: "s1", text: "goodbye" }] }],
    ["cast_loras", { cast_loras: { hero: 2 } }],
    ["film_titles", { film_titles: { title: { text: "OTHER" } } }],
  ];

  it("CONTROL: two identical startFilmJob submits produce the SAME key", async () => {
    const a = await filmSubmitClaimKey(naturalKeyForStartFilmJob(BASE_START));
    const b = await filmSubmitClaimKey(naturalKeyForStartFilmJob({ ...BASE_START }));
    expect(a).toBe(b);
    expect(a).toMatch(/^nat:[0-9a-f]{64}$/);
  });

  for (const [field, patch] of mutations) {
    it(`changing ${field} changes the key`, async () => {
      const base = await filmSubmitClaimKey(naturalKeyForStartFilmJob(BASE_START));
      const mutated = await filmSubmitClaimKey(
        naturalKeyForStartFilmJob({ ...BASE_START, ...patch } as typeof BASE_START),
      );
      expect(mutated).not.toBe(base);
    });
  }

  it("the two entry points never collide on the same inputs", async () => {
    const start = await filmSubmitClaimKey(
      naturalKeyForStartFilmJob({ project: "p", bundle_key: "b", scenes: [] }),
    );
    const fromKf = await filmSubmitClaimKey(
      naturalKeyForStartFromKeyframes({
        project: "p",
        bundle_key: "b",
        scenes: [],
        keyframes: [],
        derive_mode: "finalized",
      }),
    );
    expect(fromKf).not.toBe(start);
  });

  it("from-keyframes discriminates on keyframes and derive_mode", async () => {
    const base = {
      project: "p",
      bundle_key: "b",
      scenes: [{ shot_id: "s1", prompt: "a" }],
      keyframes: [{ shot_id: "s1", keyframe_key: "k/1.png" }],
      derive_mode: "finalized" as const,
    };
    const a = await filmSubmitClaimKey(naturalKeyForStartFromKeyframes(base));
    const b = await filmSubmitClaimKey(
      naturalKeyForStartFromKeyframes({
        ...base,
        keyframes: [{ shot_id: "s1", keyframe_key: "k/2.png" }],
      }),
    );
    const c = await filmSubmitClaimKey(
      naturalKeyForStartFromKeyframes({ ...base, derive_mode: "cloud-finalized" }),
    );
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it("a client idempotency key REPLACES the natural key and is namespaced apart from it", async () => {
    const withKey = await filmSubmitClaimKey({
      ...naturalKeyForStartFilmJob(BASE_START),
      idempotencyKey: "client-abc",
    });
    const withSameKeyDifferentInputs = await filmSubmitClaimKey({
      ...naturalKeyForStartFilmJob({ ...BASE_START, project: "TOTALLY-OTHER" }),
      idempotencyKey: "client-abc",
    });
    expect(withKey).toMatch(/^idem:[0-9a-f]{64}$/);
    // C is the CLIENT declaring intent: the same declared key is the same submit, whatever the
    // inputs. That is the property that makes C zero-false-positive, and it is why it cannot be
    // derived from the natural key.
    expect(withSameKeyDifferentInputs).toBe(withKey);
    // ...but it must never land in the natural-key namespace.
    const natural = await filmSubmitClaimKey(naturalKeyForStartFilmJob(BASE_START));
    expect(withKey).not.toBe(natural);
  });

  it("a blank / whitespace idempotency key is NOT a key and falls back to the natural key", async () => {
    const natural = await filmSubmitClaimKey(naturalKeyForStartFilmJob(BASE_START));
    for (const blank of ["", "   ", "\t\n"]) {
      const k = await filmSubmitClaimKey({
        ...naturalKeyForStartFilmJob(BASE_START),
        idempotencyKey: blank,
      });
      expect(k).toBe(natural);
    }
  });
});

// ---------------------------------------------------------------- the claim

describe("claimFilmSubmit", () => {
  const identity = () => naturalKeyForStartFilmJob(BASE_START);

  it("wins on a first submit and records the claim", async () => {
    const db = fakeDb();
    const res = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-1" });
    expect(res.duplicateOf).toBeNull();
    expect(res.guarded).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.claimKey).toMatch(/^nat:/);
    expect(db.rows.size).toBe(1);
    // It creates its own table where it writes it, exactly as markStorageLedgerTrue does.
    expect(db.calls.some((c) => c.startsWith("CREATE TABLE IF NOT EXISTS film_submit_claims"))).toBe(true);
  });

  it("a SECOND identical submit inside the window loses, and names the existing film", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const db = fakeDb();
    const first = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-1" });
    expect(first.duplicateOf).toBeNull();

    vi.setSystemTime(new Date("2026-08-14T00:00:02Z")); // the double-click, ~2s later
    const second = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-2" });
    expect(second.duplicateOf).toBe("film-1");
    // The loser must not have overwritten the winner's row.
    expect(db.rows.get(second.claimKey as string)?.film_id).toBe("film-1");
  });

  // THE LOAD-BEARING TEST. A suite that only proves dedup works would pass against a version that
  // swallows every legitimate re-render, and a guard that refuses correct work is the guard people
  // switch off.
  it("LOAD-BEARING: a deliberate re-render OUTSIDE the window is NOT deduplicated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const db = fakeDb();
    await claimFilmSubmit(envWith(db), identity(), { filmId: "film-1" });

    vi.setSystemTime(
      new Date(Date.UTC(2026, 7, 14, 0, 0, FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS + 1)),
    );
    const later = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-2" });
    expect(later.duplicateOf).toBeNull();
    expect(later.guarded).toBe(true);
    // The window RESETS on the new claim, so a double-click on the re-render is still guarded.
    expect(db.rows.get(later.claimKey as string)?.film_id).toBe("film-2");
  });

  // The boundary, pinned from BOTH sides in one test so the pair cannot drift apart. A claim is live
  // for elapsed < WINDOW and EXPIRED at elapsed >= WINDOW: at exactly 60s it has served its full
  // window. The direction is deliberate rather than an off-by-one nobody thought about -- erring the
  // other way would extend the guard past its own stated window, and a guard that refuses correct
  // work is the guard people switch off. This assertion was originally written the other way round;
  // the implementation disagreed, and the implementation was right.
  it("the boundary: live at WINDOW-1 seconds, expired at exactly WINDOW seconds", async () => {
    vi.useFakeTimers();
    const at = async (elapsed: number, filmId: string) => {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 14, 0, 0, elapsed)));
      return claimFilmSubmit(envWith(db), identity(), { filmId });
    };
    const db = fakeDb();
    await at(0, "film-1");
    // One second inside: still the same submit.
    const inside = await at(FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS - 1, "film-2");
    expect(inside.duplicateOf).toBe("film-1");
    // Exactly at the window: the claim has expired, so this is a legitimate re-render.
    const onBoundary = await at(FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS, "film-3");
    expect(onBoundary.duplicateOf).toBeNull();
  });

  it("a DIFFERENT bundle inside the window is never deduplicated (sibling-green pairing)", async () => {
    const db = fakeDb();
    await claimFilmSubmit(envWith(db), identity(), { filmId: "film-1" });
    const other = await claimFilmSubmit(
      envWith(db),
      naturalKeyForStartFilmJob({ ...BASE_START, bundle_key: "b/OTHER.tar" }),
      { filmId: "film-2" },
    );
    expect(other.duplicateOf).toBeNull();
    expect(db.rows.size).toBe(2);
  });

  it("releasing a claim lets an immediate resubmit through, and only the owner may release", async () => {
    const db = fakeDb();
    const first = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-1" });
    // A NON-owner release must not take the claim.
    await releaseFilmSubmitClaim(envWith(db), first.claimKey as string, "film-SOMEONE-ELSE");
    expect(db.rows.size).toBe(1);
    const blocked = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-2" });
    expect(blocked.duplicateOf).toBe("film-1");

    await releaseFilmSubmitClaim(envWith(db), first.claimKey as string, "film-1");
    expect(db.rows.size).toBe(0);
    const allowed = await claimFilmSubmit(envWith(db), identity(), { filmId: "film-3" });
    expect(allowed.duplicateOf).toBeNull();
  });
});

// ---------------------------------------------------------------- honest degrade
//
// The guard must FAIL OPEN and say so. A submit that 500s because the guard could not run is
// strictly worse than the defect the guard exists to fix.

describe("the guard degrades honestly and never fails a submit", () => {
  it("no DB binding: proceeds unguarded with a named reason", async () => {
    const res = await claimFilmSubmit(envWith(undefined), naturalKeyForStartFilmJob(BASE_START), {
      filmId: "film-1",
    });
    expect(res.duplicateOf).toBeNull();
    expect(res.guarded).toBe(false);
    expect(res.reason).toMatch(/database/i);
  });

  it("a D1 failure: proceeds unguarded with a named reason carrying the error", async () => {
    const db = fakeDb();
    db.failNext = "INSERT INTO film_submit_claims";
    const res = await claimFilmSubmit(envWith(db), naturalKeyForStartFilmJob(BASE_START), {
      filmId: "film-1",
    });
    expect(res.duplicateOf).toBeNull();
    expect(res.guarded).toBe(false);
    expect(res.reason).toContain("db exploded");
  });

  it("a release failure is swallowed: it must never propagate into a submit", async () => {
    const db = fakeDb();
    const first = await claimFilmSubmit(envWith(db), naturalKeyForStartFilmJob(BASE_START), {
      filmId: "film-1",
    });
    db.failNext = "DELETE FROM film_submit_claims";
    await expect(
      releaseFilmSubmitClaim(envWith(db), first.claimKey as string, "film-1"),
    ).resolves.toBeUndefined();
  });

  it("a host whose D1 shim omits meta.changes still starts exactly one film", async () => {
    // A blind `changes` read reports 0 for a WON insert, which naively reads as "someone else has
    // the claim" -- and would return a film id for a film that does not exist. The winner's own id
    // coming back from the row is the structural tell, and it must be treated as a WIN.
    const db = fakeDb({ blindChanges: true });
    const first = await claimFilmSubmit(envWith(db), naturalKeyForStartFilmJob(BASE_START), {
      filmId: "film-1",
    });
    expect(first.duplicateOf).toBeNull();
    const second = await claimFilmSubmit(envWith(db), naturalKeyForStartFilmJob(BASE_START), {
      filmId: "film-2",
    });
    expect(second.duplicateOf).toBe("film-1");
  });
});

describe("the shipped DDL", () => {
  it("declares claim_key as the PRIMARY KEY, which is what makes the claim atomic", () => {
    expect(FILM_SUBMIT_CLAIMS_DDL).toContain("CREATE TABLE IF NOT EXISTS film_submit_claims");
    expect(FILM_SUBMIT_CLAIMS_DDL).toMatch(/claim_key\s+TEXT\s+PRIMARY KEY/);
  });

  it("the window is 60 seconds", () => {
    expect(FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS).toBe(60);
  });
});
