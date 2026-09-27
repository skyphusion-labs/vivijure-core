import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import {
  defaultFilmOutputKey,
  filmDeliverableExpected,
  resolveFilmOutputKey,
} from "../src/film-output-key.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#833: a COMPLETED row whose output_key points at an object that was never written.
//
// resolveFilmOutputKey used to END with `return defaultFilmOutputKey(job.film_id)`, so it handed back
// a truthy key for every job that was neither keyframes-only nor a clips degrade -- probed or not.
// BOTH R2-existence heals are guarded on that value being FALSY (transitionToDone ->
// adoptFilmOutputKeyFromStore, and the COMPLETED backfill in renders-db.ts), so the guess did not
// merely mislabel the row: it made the two checks written to catch that exact row unreachable.
//
// The entry path is the mux resume: enterMuxPhase on a persisted doc whose phase is "mux" but whose
// silent_film_key did not persist sets film_key = undefined and calls transitionToDone.
//
// THE POSITIVE CONTROLS ARE THE POINT. Cases 2 and 4 below drive the identical doc with the artifact
// PRESENT in the fake store and assert `done`, so the gate is not an always-fail: it distinguishes
// the two states, which is the whole property a guard has to have.

const FILM = "film-cf833";
const SILENT = `renders/${FILM}/film-silent.mp4`;

/** A fake R2 whose contents I control per case: `present` is the exact set of keys that exist. */
function envFor(job: object, present: string[]) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  const store = new Set(present);
  const heads: string[] = [];
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) =>
        key === filmJobDocKey(filmId) ? { text: async () => stored } : null,
      head: async (key: string) => {
        heads.push(key);
        if (key === filmJobDocKey(filmId)) return { size: stored.length };
        return store.has(key) ? { size: 4096 } : null;
      },
      put: async (key: string, val: string) => {
        if (key === filmJobDocKey(filmId)) stored = val;
        else store.add(key);
      },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
  };
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob, heads };
}

const muxJob = (over: object = {}) => ({
  film_id: FILM,
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  created_at: 0,
  ...over,
});

describe("cf#833: a film that is OWED and is not in R2 fails; it does not complete on a guessed key", () => {
  it("a resumed mux doc that lost silent_film_key FAILS, and probes the deterministic key first", async () => {
    const { env, read, heads } = envFor(muxJob(), []); // store holds the job doc only
    const r = await advanceFilmJob(env, FILM);

    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("no assembled film in R2");
    expect(r?.job.phase).not.toBe("done");
    // The #99 adoption probe is REACHABLE again -- under the guess it never ran.
    expect(heads).toContain(defaultFilmOutputKey(FILM));
    // Persisted, not merely returned.
    expect(read().phase).toBe("failed");
    // And no key was stamped onto the doc for a film that does not exist.
    expect(read().film_key).toBeUndefined();
  });

  it("POSITIVE CONTROL / the #99 heal: the same doc COMPLETES when film.mp4 is really there", async () => {
    const { env, read } = envFor(muxJob(), [defaultFilmOutputKey(FILM)]);
    const r = await advanceFilmJob(env, FILM);

    expect(r?.job.phase).toBe("done");
    expect(read().film_key).toBe(defaultFilmOutputKey(FILM));
  });

  it("a doc key is a CLAIM: silent_film_key absent from the store FAILS, naming the key", async () => {
    const { env, read } = envFor(muxJob({ silent_film_key: SILENT }), []);
    const r = await advanceFilmJob(env, FILM);

    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain(SILENT);
    expect(read().phase).toBe("failed");
  });

  it("POSITIVE CONTROL: the identical doc COMPLETES when the silent film IS in the store", async () => {
    const { env, read } = envFor(muxJob({ silent_film_key: SILENT }), [SILENT]);
    const r = await advanceFilmJob(env, FILM);

    expect(r?.job.phase).toBe("done");
    expect(read().film_key).toBe(SILENT);
  });
});

describe("cf#833: resolveFilmOutputKey reports the doc, it does not guess", () => {
  const doc = (over: Partial<FilmJob> = {}): FilmJob =>
    ({
      film_id: "film-6df85aed",
      project: "p",
      bundle_key: "b",
      scenes: [],
      motion_backend: null,
      motion_config: {},
      finish_config: {},
      keyframe_binding: null,
      phase: "done",
      created_at: 0,
      phase_started_at: 0,
      ...over,
    }) as FilmJob;

  it("a done doc carrying NO key resolves to undefined (it used to resolve to film.mp4)", () => {
    expect(resolveFilmOutputKey(doc())).toBeUndefined();
  });

  it("prefers film_key, then silent_film_key", () => {
    expect(resolveFilmOutputKey(doc({ film_key: "a.mp4", silent_film_key: "b.mp4" }))).toBe("a.mp4");
    expect(resolveFilmOutputKey(doc({ silent_film_key: "b.mp4" }))).toBe("b.mp4");
  });

  it("filmDeliverableExpected is false only for the two shapes that owe no film", () => {
    expect(filmDeliverableExpected(doc())).toBe(true);
    expect(filmDeliverableExpected(doc({ keyframes_only: true }))).toBe(false);
    expect(
      filmDeliverableExpected(
        doc({ finish_unavailable: { at: "assemble", reason: "r", delivered: "clips" } }),
      ),
    ).toBe(false);
    // A mux degrade DID deliver a film (the silent one), so it stays gated.
    expect(
      filmDeliverableExpected(
        doc({ finish_unavailable: { at: "mux", reason: "r", delivered: "silent_film" } }),
      ),
    ).toBe(true);
  });
});
