import { describe, it, expect, vi, afterEach } from "vitest";
import { startFilmJob, startFilmFromKeyframes } from "../src/film-orchestrator.js";
import { FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS } from "../src/film-submit-idempotency.js";
import type { Database, PreparedStatement } from "../src/platform/types.js";
import type { RegisteredModule } from "../src/modules/types.js";

// The wiring half of cf#518. The unit half (tests/film-submit-idempotency.test.ts) proves the claim
// primitive; this proves the two mint sites in film-orchestrator actually CONSULT it, that a
// duplicate never reaches a module or a clip submit, and that the returned job is marked.
//
// The load-bearing assertion is the same one as in the unit suite and it is here too on purpose: a
// deliberate re-render OUTSIDE the window must reach the module and start a real second film.

const keyframeModule = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {},
  ui: { section: "keyframe", order: 10 },
} as unknown as RegisteredModule;

const motionModule = {
  name: "own-gpu",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_OWN_GPU",
  hooks: ["motion.backend" as const],
  config_schema: {},
  ui: { section: "motion", order: 5 },
} as unknown as RegisteredModule;

// A CLOUD motion backend. `own-gpu` and `local-gpu` are in BUCKET_KEYFRAME_MOTION_BACKENDS, so a
// clip submit on those stages the keyframe through R2 first -- machinery this harness does not
// stand up. The from-keyframes fixture uses this one so its clip submit genuinely succeeds.
const cloudMotionModule = {
  name: "seedance",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_SEEDANCE",
  hooks: ["motion.backend" as const],
  config_schema: {},
  ui: { section: "motion", order: 6, locality: "cloud" as const },
} as unknown as RegisteredModule;

const mods = [keyframeModule, motionModule, cloudMotionModule];

// ---------------------------------------------------------------- in-memory D1 + R2

interface ClaimRow {
  film_id: string;
  claimed_at: number;
}

function fakeDb(): Database & { rows: Map<string, ClaimRow> } {
  const rows = new Map<string, ClaimRow>();
  const make = (norm: string, bound: unknown[]): PreparedStatement => ({
    bind(...values: unknown[]) {
      return make(norm, values);
    },
    async first<T>() {
      if (norm.startsWith("SELECT film_id FROM film_submit_claims")) {
        const row = rows.get(String(bound[0]));
        if (!row || row.claimed_at <= Number(bound[1])) return null;
        return { film_id: row.film_id } as T;
      }
      throw new Error(`fake db does not understand: ${norm}`);
    },
    async run() {
      if (norm.startsWith("CREATE TABLE IF NOT EXISTS film_submit_claims")) {
        return { success: true, meta: { changes: 0 } };
      }
      if (norm.startsWith("INSERT INTO film_submit_claims")) {
        const [key, filmId, now, cutoff] = [
          String(bound[0]),
          String(bound[1]),
          Number(bound[2]),
          Number(bound[3]),
        ];
        const existing = rows.get(key);
        if (!existing || existing.claimed_at <= cutoff) {
          rows.set(key, { film_id: filmId, claimed_at: now });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      if (norm.startsWith("DELETE FROM film_submit_claims")) {
        const existing = rows.get(String(bound[0]));
        if (existing && existing.film_id === String(bound[1])) {
          rows.delete(String(bound[0]));
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      throw new Error(`fake db does not understand: ${norm}`);
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });
  const db = { rows } as Database & { rows: Map<string, ClaimRow> };
  db.prepare = (sql: string) => make(sql.replace(/\s+/g, " ").trim(), []);
  return db;
}

interface Harness {
  env: unknown;
  keyframeCalls: number;
  motionCalls: number;
  puts: string[];
  objects: Map<string, string>;
  db: Database & { rows: Map<string, ClaimRow> };
}

function harness(opts: { keyframeFails?: boolean } = {}): Harness {
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const h: Harness = { env: null, keyframeCalls: 0, motionCalls: 0, puts, objects, db: fakeDb() };
  h.env = {
    DB: h.db,
    MODULE_KEYFRAME: {
      fetch: async () => {
        h.keyframeCalls += 1;
        const body = opts.keyframeFails
          ? { ok: false, error: "the GPU said no" }
          : { ok: true, pending: true, poll: "kf-poll" };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://example.invalid/${key}`,
      presignPut: async (key: string) => `https://example.invalid/${key}`,
    },
    MODULE_OWN_GPU: {
      fetch: async () => {
        h.motionCalls += 1;
        return new Response(JSON.stringify({ ok: true, pending: true, poll: "clip-poll" }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
    MODULE_SEEDANCE: {
      fetch: async () => {
        h.motionCalls += 1;
        return new Response(JSON.stringify({ ok: true, pending: true, poll: "clip-poll" }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
    R2_RENDERS: {
      async put(key: string, value: string) {
        puts.push(key);
        objects.set(key, value);
        return undefined;
      },
      async get(key: string) {
        const v = objects.get(key);
        if (v === undefined) return null;
        return { text: async () => v };
      },
    },
  };
  return h;
}

const ARGS = {
  project: "film",
  bundle_key: "bundles/film.tar.gz",
  scenes: [{ shot_id: "shot_01", prompt: "slow push", seconds: 5 }],
  motion_backend: "own-gpu",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startFilmJob is guarded (cf#518)", () => {
  it("CONTROL: a first submit reaches the keyframe module and is NOT marked deduplicated", async () => {
    const h = harness();
    const job = await startFilmJob(h.env as never, ARGS, mods);
    expect(h.keyframeCalls).toBe(1);
    expect(job.deduplicated).toBeUndefined();
    expect(job.film_id).toMatch(/^film-/);
  });

  it("a double-click returns the SAME film, marked, having invoked no module", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(h.env as never, ARGS, mods);
    expect(h.keyframeCalls).toBe(1);

    vi.setSystemTime(new Date("2026-08-14T00:00:02Z")); // ~2s, the double-click
    const putsBefore = h.puts.length;
    const second = await startFilmJob(h.env as never, ARGS, mods);

    expect(second.film_id).toBe(first.film_id);
    // NON-OPTIONAL per the ruling: a 201-that-is-really-a-200 with no marker is an absence
    // rendering as a value. A caller, a log, a test and a load test all need to tell the two apart.
    expect(second.deduplicated).toBe(true);
    // The whole point: no second GPU submit.
    expect(h.keyframeCalls).toBe(1);
    // And no second film doc, so the marker cannot be persisted onto the film by this path.
    expect(h.puts.length).toBe(putsBefore);
  });

  it("the marker is NEVER persisted to the film doc", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(h.env as never, ARGS, mods);
    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const second = await startFilmJob(h.env as never, ARGS, mods);
    expect(second.deduplicated).toBe(true);
    for (const [, body] of h.objects) {
      expect(JSON.parse(body).deduplicated).toBeUndefined();
    }
  });

  // THE LOAD-BEARING TEST, at the wiring level.
  it("LOAD-BEARING: a deliberate re-render OUTSIDE the window starts a real second film", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(h.env as never, ARGS, mods);

    vi.setSystemTime(
      new Date(Date.UTC(2026, 7, 14, 0, 0, FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS + 1)),
    );
    const again = await startFilmJob(h.env as never, ARGS, mods);

    expect(again.film_id).not.toBe(first.film_id);
    expect(again.deduplicated).toBeUndefined();
    expect(h.keyframeCalls).toBe(2);
  });

  it("SIBLING-GREEN: a different bundle inside the window is never deduplicated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(h.env as never, ARGS, mods);
    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const other = await startFilmJob(
      h.env as never,
      { ...ARGS, bundle_key: "bundles/OTHER.tar.gz" },
      mods,
    );
    expect(other.film_id).not.toBe(first.film_id);
    expect(other.deduplicated).toBeUndefined();
    expect(h.keyframeCalls).toBe(2);
  });

  it("a client idempotency key dedups even when the inputs differ", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(
      h.env as never,
      { ...ARGS, idempotency_key: "panel-submit-1" },
      mods,
    );
    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const second = await startFilmJob(
      h.env as never,
      { ...ARGS, bundle_key: "bundles/DIFFERENT.tar.gz", idempotency_key: "panel-submit-1" },
      mods,
    );
    expect(second.film_id).toBe(first.film_id);
    expect(second.deduplicated).toBe(true);
    expect(h.keyframeCalls).toBe(1);
  });

  it("a film that FAILED at start releases its claim, so an immediate retry is not blocked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness({ keyframeFails: true });
    const first = await startFilmJob(h.env as never, ARGS, mods);
    expect(first.phase).toBe("failed");

    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const retry = await startFilmJob(h.env as never, ARGS, mods);
    // A failed submit spent nothing, so re-running it is legitimate work and the guard must not
    // hand back the corpse. The guard exists to stop a SECOND LIVE FILM, not a second attempt.
    expect(retry.film_id).not.toBe(first.film_id);
    expect(retry.deduplicated).toBeUndefined();
    expect(h.keyframeCalls).toBe(2);
  });

  it("no DB binding: the submit proceeds unguarded rather than failing", async () => {
    const h = harness();
    const env = { ...(h.env as Record<string, unknown>) };
    delete env.DB;
    const first = await startFilmJob(env as never, ARGS, mods);
    const second = await startFilmJob(env as never, ARGS, mods);
    expect(second.film_id).not.toBe(first.film_id);
    expect(h.keyframeCalls).toBe(2);
  });

  it("a claim pointing at a film whose doc is GONE starts fresh rather than returning a ghost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmJob(h.env as never, ARGS, mods);
    // Simulate the film doc having been deleted while the claim is still live.
    h.objects.clear();

    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const second = await startFilmJob(h.env as never, ARGS, mods);
    expect(second.deduplicated).toBeUndefined();
    expect(second.film_id).not.toBe(first.film_id);
    expect(h.keyframeCalls).toBe(2);
  });
});

describe("startFilmFromKeyframes is guarded (cf#518)", () => {
  // The keyframes MUST match the scenes. With an empty list nothing matches, the submit fails at
  // once and correctly releases its claim -- so a fixture built that way measures the failure path
  // and passes whether or not the guard exists at all. A fixture has to be a state the production
  // SUCCESS path can actually produce.
  const KF_ARGS = {
    project: "film",
    bundle_key: "bundles/film.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "slow push", seconds: 5 }],
    keyframes: [{ shot_id: "shot_01", keyframe_key: "keyframes/shot_01.png", prompt: "slow push", seconds: 5 }],
    motion_backend: "seedance",
    derive_mode: "finalized" as const,
  };

  it("CONTROL: the fixture really starts a film (it reaches the motion module and is not failed)", async () => {
    const h = harness();
    const job = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    expect(job.phase).toBe("clips");
    expect(h.motionCalls).toBe(1);
  });

  it("CONTROL: a first submit is not marked deduplicated", async () => {
    const h = harness();
    const job = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    expect(job.deduplicated).toBeUndefined();
    expect(job.film_id).toMatch(/^film-/);
  });

  it("a double-click returns the SAME film, marked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    vi.setSystemTime(new Date("2026-08-14T00:00:02Z"));
    const second = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    expect(second.film_id).toBe(first.film_id);
    expect(second.deduplicated).toBe(true);
    expect(h.motionCalls).toBe(1);
  });

  it("LOAD-BEARING: a re-render outside the window is a new film", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const first = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    vi.setSystemTime(
      new Date(Date.UTC(2026, 7, 14, 0, 0, FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS + 1)),
    );
    const again = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    expect(again.film_id).not.toBe(first.film_id);
    expect(again.deduplicated).toBeUndefined();
    expect(h.motionCalls).toBe(2);
  });

  it("the two entry points do not share a claim on the same project + bundle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const h = harness();
    const start = await startFilmJob(h.env as never, ARGS, mods);
    vi.setSystemTime(new Date("2026-08-14T00:00:01Z"));
    const fromKf = await startFilmFromKeyframes(h.env as never, KF_ARGS, mods);
    expect(fromKf.film_id).not.toBe(start.film_id);
    expect(fromKf.deduplicated).toBeUndefined();
  });
});
