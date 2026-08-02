import { describe, it, expect } from "vitest";
import { startFilmFromKeyframes } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { FilmJob } from "../src/film-model.js";

// vivijure-cf#334: startFilmFromKeyframes had no `dialogue_lines` parameter and never set the field on
// the job it builds, so render-from-keyframes / finalize / animate-cloud / animate-hybrid were
// STRUCTURALLY incapable of a voiced film whatever their door resolved. The finish chain reads
// job.dialogue_lines (enterFinishPhase -> enterDialogueOrFinish) and a from-keyframes job enters at
// phase "clips" and reaches both, so the field was read and never written.
//
// Every assertion below reads the job doc back out of the fake R2 rather than the returned object: the
// persisted doc is what the poll ticks and the finish chain actually consume, and a field that is on the
// return value but not in R2 would look identical from the caller.

const DOC = (id: string) => `renders/${id}/film-job.json`;

function envWithR2() {
  const store = new Map<string, string>();
  const env = {
    R2_RENDERS: {
      async get(key: string) {
        const v = store.get(key);
        return v === undefined ? null : { text: async () => v, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      async put(key: string, body: string) {
        store.set(key, body);
      },
    },
  } as unknown as Env;
  return { env, store };
}

/** Read the persisted doc for the film the call just created. Fails loudly rather than returning a
 *  default if nothing was persisted, so "no doc" can never read as "a doc with no dialogue". */
function readDoc(store: Map<string, string>, filmId: string): FilmJob {
  const raw = store.get(DOC(filmId));
  if (raw === undefined) throw new Error(`no film job doc persisted at ${DOC(filmId)}`);
  return JSON.parse(raw) as FilmJob;
}

const SCENES = [
  { shot_id: "shot_01", prompt: "she speaks", seconds: 4 },
  { shot_id: "shot_02", prompt: "he answers", seconds: 4 },
];
// Deliberately mismatched so the call returns at the no-keyframes-matched branch: the job literal (the
// thing under test) is built BEFORE that branch, and this keeps the test off startClipJob, presigning
// and module dispatch, none of which this change touches.
const NO_MATCH: [] = [];

describe("cf#334: startFilmFromKeyframes carries dialogue_lines onto the persisted job", () => {
  it("persists the lines it was given", async () => {
    const { env, store } = envWithR2();
    const job = await startFilmFromKeyframes(env, {
      project: "p",
      bundle_key: "bundles/p.tar.gz",
      scenes: SCENES,
      keyframes: NO_MATCH,
      derive_mode: "finalized",
      dialogue_lines: [
        { shot_id: "shot_01", text: "So the seed vault is real.", voice_id: "angus" },
        { shot_id: "shot_02", text: "Hope is the only thing I still grow.", voice_id: "angus" },
      ],
    });
    const doc = readDoc(store, job.film_id);
    expect(doc.dialogue_lines?.map((l) => l.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(doc.dialogue_lines?.map((l) => l.text)).toEqual([
      "So the seed vault is real.",
      "Hope is the only thing I still grow.",
    ]);
  });

  it("re-keys line ids through the SAME coercion the scenes get (#563)", async () => {
    // A caller with its own id scheme: without coerceDialogueLineIds the scenes become shot_01/shot_02
    // while the lines stay s1/s2, so every consumer joins on ids that do not exist and the film ships
    // silent and uncaptioned even though the TTS ran.
    const { env, store } = envWithR2();
    const job = await startFilmFromKeyframes(env, {
      project: "p",
      bundle_key: "bundles/p.tar.gz",
      scenes: [
        { shot_id: "s1", prompt: "she speaks", seconds: 4 },
        { shot_id: "s2", prompt: "he answers", seconds: 4 },
      ],
      keyframes: NO_MATCH,
      derive_mode: "finalized",
      dialogue_lines: [{ shot_id: "s1", text: "line one" }],
    });
    const doc = readDoc(store, job.film_id);
    expect(doc.scenes.map((s) => s.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(doc.dialogue_lines?.map((l) => l.shot_id)).toEqual(["shot_01"]);
  });

  it("NEGATIVE CONTROL: no lines -> the key is ABSENT, not an empty array", async () => {
    // This is the control for the two assertions above: it proves the harness can report the field
    // missing. Without it, a probe that could only ever see `undefined` would pass here and would have
    // passed identically against the broken code.
    const { env, store } = envWithR2();
    const job = await startFilmFromKeyframes(env, {
      project: "p",
      bundle_key: "bundles/p.tar.gz",
      scenes: SCENES,
      keyframes: NO_MATCH,
      derive_mode: "finalized",
    });
    const doc = readDoc(store, job.film_id);
    expect(doc.dialogue_lines).toBeUndefined();
    expect("dialogue_lines" in doc).toBe(false);

    // Fixed-answer row: true under the old contract and the new one alike. If this ever fails, the
    // harness is broken and nothing else in this file is a finding about the change.
    expect(job.film_id.startsWith("film-")).toBe(true);
    expect(doc.derive_mode).toBe("finalized");
  });
});
