// vivijure-core#130 / #663: an ADOPTED film.finish step must still yield its measurements.
//
// THE DEFECT. A step whose artifact lands in R2 between polls is adopted on the next tick and its
// OUTPUT IS NEVER READ, so the two numbers that only travel on the output -- the delivered length and
// any title-card prepend -- were lost. Adoption is the NORMAL completion route on the async drive
// path (the R2 presence check runs BEFORE the poll-token check and discards the token), so the
// covered case was described as common and the uncovered one as residual, and it is the reverse.
//
// The consequence was a NULL `output_ms` on a COMPLETED row: a film we rendered and billed nothing
// for, silently, on the common path.

import { describe, expect, it } from "vitest";
import { runFilmFinish, metaKeyFor, readStepMeta } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";

const FILM = "renders/p1/film.mp4";
const STEP0 = "renders/p1/film-ff0.mp4";

const MOD: RegisteredModule = {
  name: "film-titles",
  version: "0.1.0",
  api: "vivijure-module/1",
  hooks: ["film.finish"],
  ui: { section: "finish", order: 10 },
  binding: "MODULE_FILM_TITLES",
} as unknown as RegisteredModule;

/** An env where STEP0 ALREADY EXISTS in R2, which is what forces the adoption branch. `meta` is the
 *  sidecar body, or null for "the step wrote no sidecar". */
function envWith(meta: string | null, opts: { bundle?: string } = {}) {
  const puts: Record<string, string> = {};
  return {
    env: {
      R2_RENDERS: {
        head: async (k: string) => (k === STEP0 ? {} : null),
        get: async (k: string) => {
          if (k === metaKeyFor(STEP0)) return meta === null ? null : { text: async () => meta };
          if (opts.bundle && k === opts.bundle) return { text: async () => "{}" };
          return null;
        },
        put: async (k: string, b: string) => { puts[k] = b; },
      },
      PRESIGNER: {
        presignGet: async (k: string) => `https://g/${k}`,
        presignPut: async (k: string) => `https://p/${k}`,
      },
      // Never reached: the step is adopted, so nothing is dispatched. Throwing makes that ASSERTED
      // rather than assumed -- if a future change starts dispatching an adopted step, this test says so.
      MODULE_FILM_TITLES: {
        fetch: async () => { throw new Error("an ADOPTED step must never be dispatched"); },
      },
    } as unknown as Env,
    puts,
  };
}

const run = (env: Env) =>
  runFilmFinish(
    env,
    { film_key: FILM, scenes: [], bundle_key: "bundles/p1.tar.gz", project: "p1", job_id: "j1" },
    [MOD],
  );

describe("metaKeyFor", () => {
  it("derives the sidecar key from the artifact key alone", () => {
    // Derived, never stored: on the adoption path there is no module output to tell us where it went.
    expect(metaKeyFor("renders/p1/film-ff0.mp4")).toBe("renders/p1/film-ff0.meta.json");
    expect(metaKeyFor("renders/p1/film-ff0.MP4")).toBe("renders/p1/film-ff0.meta.json");
  });
});

describe("an ADOPTED step recovers its measurements from the sidecar (#130/#663)", () => {
  it("records the delivered length, so output_ms is no longer NULL on the common path", async () => {
    const { env } = envWith(JSON.stringify({ duration_seconds: 42.5 }));
    const r = await run(env);
    expect(r.adopted).toEqual(["film-titles"]);
    expect(r.applied).toEqual([]); // adopted, NOT a fake applied run
    expect(r.film_key).toBe(STEP0);
    expect(r.duration_seconds).toBe(42.5);
  });

  it("records the title-card prepend, so the final .srt is not under-shifted (#663)", async () => {
    const prepends: Record<string, number> = {};
    const { env } = envWith(JSON.stringify({ duration_seconds: 10, prepend_seconds: 4 }));
    await runFilmFinish(
      env,
      { film_key: FILM, scenes: [], bundle_key: "b", project: "p1", job_id: "j1" },
      [MOD],
      { prepends, persistPrepend: async (k: string, v: number) => { prepends[k] = v; } },
    );
    expect(prepends[STEP0]).toBe(4);
  });

  it("persists through the caller's callbacks, so a later tick still sees it", async () => {
    const durations: Record<string, number> = {};
    const { env } = envWith(JSON.stringify({ duration_seconds: 7 }));
    await runFilmFinish(
      env,
      { film_key: FILM, scenes: [], bundle_key: "b", project: "p1", job_id: "j1" },
      [MOD],
      { durations, persistDuration: async (k: string, v: number) => { durations[k] = v; } },
    );
    expect(durations[STEP0]).toBe(7);
  });
});

describe("the fallback is HONEST: absent stays NOT MEASURED, never synthesized", () => {
  // THE NEGATIVE CONTROL, and the one that matters most. Every film whose steps ran before this
  // shipped has no sidecar, and the contract explicitly allows a module not to write one. Those must
  // land on undefined -> NULL, which is exactly the behaviour before this change. The defect being
  // fixed is a NULL nobody could ever fill; it is not a licence to invent a length.
  it("no sidecar -> duration stays undefined (the pre-change behaviour, unchanged)", async () => {
    const { env } = envWith(null);
    const r = await run(env);
    expect(r.adopted).toEqual(["film-titles"]);
    expect(r.duration_seconds).toBeUndefined();
    expect(r.duration_seconds).not.toBe(0); // a 0 in a billing column is a film of no length
  });

  it("malformed JSON -> undefined, and does not throw the chain", async () => {
    const { env } = envWith("{not json at all");
    const r = await run(env);
    expect(r.adopted).toEqual(["film-titles"]);
    expect(r.duration_seconds).toBeUndefined();
  });

  it("a sidecar with no usable numbers -> undefined", async () => {
    const { env } = envWith(JSON.stringify({ note: "nothing measurable here" }));
    expect(await readStepMeta(envWith(JSON.stringify({ note: "x" })).env, STEP0)).toBeUndefined();
    const r = await run(env);
    expect(r.duration_seconds).toBeUndefined();
  });

  // Same gate as the fold path: finite AND positive. Zero, NaN and negatives are not measurements of
  // a film, and coalescing any of them into the billing column would read as a real length.
  it("rejects 0, negative, NaN and non-numeric rather than recording them", async () => {
    for (const bad of [0, -3, "12", null, true]) {
      const { env } = envWith(JSON.stringify({ duration_seconds: bad }));
      const r = await run(env);
      expect(r.duration_seconds).toBeUndefined();
    }
    // NaN does not survive JSON, so it arrives as null -- asserted explicitly so the reason is on the
    // record rather than looking like an untested case.
    const { env } = envWith('{"duration_seconds": NaN}');
    expect((await run(env)).duration_seconds).toBeUndefined();
  });
});

describe("precedence: a FOLDED measurement always beats the sidecar copy", () => {
  // The module output is authoritative; the sidecar is the copy that survives the output never being
  // read. If a value was folded on an earlier tick it must not be overwritten by the sidecar.
  it("a duration already recorded for this artifact is not overwritten", async () => {
    const durations: Record<string, number> = { [STEP0]: 99 };
    const { env } = envWith(JSON.stringify({ duration_seconds: 42.5 }));
    const r = await runFilmFinish(
      env,
      { film_key: FILM, scenes: [], bundle_key: "b", project: "p1", job_id: "j1" },
      [MOD],
      { durations, persistDuration: async (k: string, v: number) => { durations[k] = v; } },
    );
    expect(r.duration_seconds).toBe(99);
    expect(durations[STEP0]).toBe(99);
  });

  it("a prepend already recorded for this step is not overwritten", async () => {
    const prepends: Record<string, number> = { [STEP0]: 6 };
    const { env } = envWith(JSON.stringify({ prepend_seconds: 4 }));
    await runFilmFinish(
      env,
      { film_key: FILM, scenes: [], bundle_key: "b", project: "p1", job_id: "j1" },
      [MOD],
      { prepends, persistPrepend: async (k: string, v: number) => { prepends[k] = v; } },
    );
    expect(prepends[STEP0]).toBe(6);
  });
});
