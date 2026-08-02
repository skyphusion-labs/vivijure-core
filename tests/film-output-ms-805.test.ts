import { describe, it, expect } from "vitest";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import { outputMsFromSeconds } from "../src/film-orchestrator.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// renders.output_ms: the DELIVERED film length, which is what the meter bills on.
//
// THE RULE (Conrad, 2026-08-02): "we bill on the last writer." Three container routes each emit a
// durationSeconds -- /finish (assemble), /film-titles and /subtitle -- and a film that gets title
// cards is LONGER than its assemble output. Billing the assemble figure under-bills by the length of
// every card, on every film that gets one, silently, because the number looks entirely plausible.
//
// THE HAZARD THIS FILE EXISTS FOR. The film.finish chain ADOPTS an existing per-step artifact from R2
// when a prior tick already produced it (#600 survivability) and the adoption branch makes NO
// container call, so nothing is folded and no duration arrives on that tick. A length read only from
// a live dispatch result is therefore lost on exactly the films that took long enough to span ticks
// -- i.e. the expensive ones -- and it is lost as a NULL on a COMPLETED row, which bills nothing.
// The fix is the film_finish_prepend pattern: a per-artifact map persisted on the job doc.
//
// The map is keyed by FILM ARTIFACT KEY rather than step index, so "the last writer wins" is a
// property of the data (look up the final key) instead of an ordering rule someone has to maintain.

const SID = "scatter-output-ms";
const FILM_KEY = `renders/${SID}/film.mp4`;
const FF_CARD = `renders/${SID}/film-ff1.mp4`;   // film-titles is ui.order 10 -> step INDEX 1

const ASSEMBLE_SECONDS = 42.5;   // what the assemble produced
const CARDED_SECONDS = 47.25;    // what the viewer actually receives, after the title card

const SUBTITLE_MANIFEST = {
  name: "subtitle", version: "0.1.0", api: "vivijure-module/2",
  hooks: ["film.finish"], provides: [], config_schema: {}, ui: { section: "film.finish", order: 5 },
};
const TITLES_MANIFEST = {
  name: "film-titles", version: "0.1.0", api: "vivijure-module/2",
  hooks: ["film.finish"], provides: [], config_schema: {}, ui: { section: "film.finish", order: 10 },
};
function jr(b: unknown) { return new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } }); }

const scatterJob = (over: Record<string, unknown> = {}) => ({
  scatter_id: SID,
  project: "p",
  bundle_key: `bundles/${SID}.tar.gz`,
  shard_film_ids: ["shard-a"],
  shard_shots: [["shot_01"]],
  expected_shot_ids: ["shot_01"],
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
  film_titles: { title: { text: "The End" } },
  phase: "finishing" as const,
  film_key: FILM_KEY,
  created_at: 0,
  ...over,
});

/** `present` is the set of R2 keys that already exist -- i.e. what the chain will ADOPT. */
function makeEnv(opts: { job?: Record<string, unknown>; present?: string[]; titlesFolds?: boolean } = {}) {
  let stored = JSON.stringify(scatterJob(opts.job ?? {}));
  const present = new Set(opts.present ?? []);
  let finishState: string | null = null;
  const finishBinds: unknown[][] = [];
  const docKey = `renders/${SID}/scatter-job.json`;

  const db = {
    prepare(sql: string) {
      const st = {
        _binds: [] as unknown[],
        bind(...b: unknown[]) { st._binds = b; return st; },
        async first() {
          if (/SELECT id FROM renders/i.test(sql)) return { id: 1 };
          if (/SELECT finish_state/i.test(sql)) return { finish_state: finishState, output_key: null };
          return null;
        },
        async run() {
          if (/status = 'COMPLETED'[\s\S]*finish_state = 'done'/i.test(sql)) {
            finishBinds.push(st._binds);
            finishState = "done";
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all() { return { results: [] }; },
      };
      return st;
    },
  };

  const env = {
    DB: db,
    R2_RENDERS: {
      get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
      head: async (k: string) => (present.has(k) ? {} : null),
      put: async (k: string, b: string) => { if (k === docKey) stored = b; },
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
    // subtitle is a NOOP here (no dialogue): it returns the INPUT key unchanged and writes nothing,
    // which is the ordinary shape and the reason the final key can belong to an EARLIER step.
    MODULE_SUBTITLE: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return jr(SUBTITLE_MANIFEST);
        return jr({ ok: true, output: { film_key: FILM_KEY, applied: ["noop:no-cards"] } });
      },
    },
    MODULE_FILM_TITLES: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return jr(TITLES_MANIFEST);
        if (opts.titlesFolds === false) return jr({ ok: true, pending: true, poll: "tok" });
        return jr({
          ok: true,
          output: { film_key: FF_CARD, applied: ["film-titles"], prepend_seconds: 4.75, duration_seconds: CARDED_SECONDS },
        });
      },
    },
  } as unknown as Env;

  return {
    env,
    read: () => JSON.parse(stored) as Record<string, unknown>,
    // The LAST bind of markFinishDone's UPDATE is job_id and the one before it is output_ms.
    outputMs: () => (finishBinds.length ? (finishBinds[finishBinds.length - 1].at(-2) as number | null) : undefined),
    finishCount: () => finishBinds.length,
  };
}

describe("outputMsFromSeconds: NULL is not zero", () => {
  it("converts a real length to integer milliseconds", () => {
    expect(outputMsFromSeconds(47.25)).toBe(47250);
  });
  it("refuses every value that is not a length, rather than storing a plausible zero", () => {
    // A 0 in a billing column is a film of no length and is indistinguishable from "not measured"
    // once it is stored. These must all be NULL, not 0.
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      expect(outputMsFromSeconds(bad as number | undefined), `input ${String(bad)}`).toBeNull();
    }
  });
});

describe("renders.output_ms is the length of the LAST writer (Conrad, 2026-08-02)", () => {
  it("bills the CARDED length, not the assemble length", async () => {
    _resetModuleDiscoveryCache();
    // The assemble already recorded its own artifact's length; the card then writes a longer film.
    const { env, outputMs, finishCount } = makeEnv({
      job: { film_output_seconds: { [FILM_KEY]: ASSEMBLE_SECONDS } },
    });
    await advanceScatterJob(env, SID);
    expect(finishCount()).toBe(1);
    // CONTROL: the two numbers are genuinely different, so this assertion can distinguish them. If
    // the fixture ever made them equal, the test would pass while proving nothing.
    expect(CARDED_SECONDS).not.toBe(ASSEMBLE_SECONDS);
    expect(outputMs()).toBe(47250);
    expect(outputMs()).not.toBe(outputMsFromSeconds(ASSEMBLE_SECONDS));
  });
});

describe("an ADOPTED final step still lands a length (#600 resume)", () => {
  // THE RECONSTRUCTED RESUME. Tick 1 folds the card and persists its length. The job is then
  // re-entered with the card artifact ALREADY in R2, so the chain ADOPTS that step and makes no
  // container call at all -- the exact branch that produces no duration. The length must survive,
  // and it survives only because it was persisted per artifact key on the job doc.
  it("tick 2 adopts the card step and the delivered length is still billed", async () => {
    _resetModuleDiscoveryCache();
    const first = makeEnv({ job: { film_output_seconds: { [FILM_KEY]: ASSEMBLE_SECONDS } } });
    await advanceScatterJob(first.env, SID);
    const afterTick1 = first.read();
    const persisted = afterTick1.film_output_seconds as Record<string, number>;
    // CONTROL: tick 1 really did persist the carded length against the carded artifact's key. Without
    // this the adoption assertion below could pass for the wrong reason (e.g. both ticks folding).
    expect(persisted[FF_CARD]).toBe(CARDED_SECONDS);

    // Re-enter with the carded artifact PRESENT -> the step adopts instead of dispatching.
    _resetModuleDiscoveryCache();
    const resumed = makeEnv({
      job: { phase: "finishing", film_output_seconds: persisted },
      present: [FF_CARD],
    });
    await advanceScatterJob(resumed.env, SID);
    const doc = resumed.read();
    expect((doc.film_finish as { adopted?: string[] })?.adopted, "the step must have been ADOPTED, not re-run").toContain("film-titles");
    expect(resumed.outputMs()).toBe(47250);
  });

  it("NEGATIVE CONTROL: without the persisted map the same resume bills NOTHING", async () => {
    // Same adoption, same artifacts, only the persisted lengths removed -- i.e. what this change
    // would look like if the length were read solely from a live dispatch result. The row completes
    // with output_ms NULL, which is a real render that bills nothing. This is the defect, reproduced,
    // so the assertion above is known to be capable of the other answer.
    _resetModuleDiscoveryCache();
    const resumed = makeEnv({ job: { phase: "finishing" }, present: [FF_CARD] });
    await advanceScatterJob(resumed.env, SID);
    const doc = resumed.read();
    expect((doc.film_finish as { adopted?: string[] })?.adopted).toContain("film-titles");
    expect(resumed.outputMs()).toBeNull();
  });
});
