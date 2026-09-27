import { describe, it, expect } from "vitest";
import { filmDonePayload } from "../src/render-output-payload.js";
import type { FilmJob } from "../src/film-model.js";

// vivijure-cf#836: the master and speech degrades were console.warn only, so `finish_unavailable`
// could never be true for them and the panel painted a plain green "completed" over a film that was
// never mastered, or whose speech chain was skipped. The panel was doing its job correctly on the
// information it was given; the information was not being given.
//
// The correction to the issue, which is what makes this small: BOTH RECORDS ALREADY EXISTED on the
// job doc and are persisted with it (job.master.degraded: string[], job.speech_shots[].degraded:
// string). This was never a missing channel, only a missing projection. dialogue is the third, whose
// record cf#834 added.
//
// THE LADDER is the whole contract and the last case asserts it directly (fc#1662's discipline):
//   key ABSENT      -> the stage was never reached. NOT MEASURED.
//   degraded: 0     -> it ran and ran clean.
//   degraded: n > 0 -> it ran and degraded, and `reasons` says how.
// A stage that collapses "never ran" into "ran clean" rebuilds cf#549 one field over.

const job = (over: Partial<FilmJob> = {}): FilmJob =>
  ({
    film_id: "film-836",
    project: "p",
    bundle_key: "b",
    scenes: [],
    motion_backend: null,
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "done",
    film_key: "renders/film-836/film.mp4",
    created_at: 0,
    phase_started_at: 0,
    ...over,
  }) as FilmJob;

const speechShot = (shot_id: string, degraded?: string) => ({
  shot_id,
  audio_key: `renders/film-836/dialogue/${shot_id}.wav`,
  chain: ["MODULE_SPEECH"],
  idx: 1,
  status: "done" as const,
  applied: [],
  ...(degraded ? { degraded } : {}),
});

describe("cf#836: every stage that can degrade reaches the payload", () => {
  it("CONTROL: a film that reached none of the three stages carries none of the keys", async () => {
    // Runs first: every case below asserts a key is PRESENT with a value, and presence means nothing
    // until absence has been shown to be the other state.
    const out = filmDonePayload(job(), null);
    expect(out.speech).toBeUndefined();
    expect(out.master).toBeUndefined();
    expect(out.dialogue).toBeUndefined();
  });

  it("speech: a clean chain reports degraded 0, so unmeasured stays distinguishable", () => {
    const out = filmDonePayload(job({ speech_shots: [speechShot("shot_01"), speechShot("shot_02")] }), null);
    expect(out.speech).toEqual({ degraded: 0, reasons: [] });
  });

  it("speech: per-shot reasons reach the payload, counted and deduped", () => {
    const out = filmDonePayload(
      job({
        speech_shots: [
          speechShot("shot_01", "speech module MODULE_SPEECH not bound"),
          speechShot("shot_02", "speech module MODULE_SPEECH not bound"),
          speechShot("shot_03"),
        ],
      }),
      null,
    );
    expect(out.speech).toEqual({
      degraded: 2,
      reasons: ["speech module MODULE_SPEECH not bound"],
    });
  });

  it("master: a clean chain reports degraded 0", () => {
    const out = filmDonePayload(
      job({ master: { chain: ["MODULE_MASTER"], idx: 1, applied: ["music-upscale:soxr48k"], degraded: [] } }),
      null,
    );
    expect(out.master).toEqual({ degraded: 0, reasons: [] });
  });

  it("master: the per-step reasons reach the payload verbatim", () => {
    const out = filmDonePayload(
      job({
        master: {
          chain: ["MODULE_MASTER", "MODULE_LOUDNESS"],
          idx: 2,
          applied: [],
          degraded: ["MODULE_MASTER: invoke failed: 503", "MODULE_LOUDNESS: module not bound"],
        },
      }),
      null,
    );
    expect(out.master).toEqual({
      degraded: 2,
      reasons: ["MODULE_MASTER: invoke failed: 503", "MODULE_LOUDNESS: module not bound"],
    });
  });

  it("dialogue: a voiced film reports degraded 0", () => {
    const out = filmDonePayload(job({ dialogue_audio: { shot_01: "renders/film-836/d/shot_01.wav" } }), null);
    expect(out.dialogue).toEqual({ degraded: 0, reasons: [] });
  });

  it("dialogue: the cf#834 degrade reaches the payload in the studio's own words", () => {
    const out = filmDonePayload(
      job({ dialogue_degraded: "no dialogue module installed; shipped a silent film" }),
      null,
    );
    expect(out.dialogue).toEqual({
      degraded: 1,
      reasons: ["no dialogue module installed; shipped a silent film"],
    });
  });

  it("THE LADDER: absent, clean and degraded are three mutually distinguishable states", () => {
    const never = filmDonePayload(job(), null);
    const clean = filmDonePayload(job({ master: { chain: ["M"], idx: 1, applied: [], degraded: [] } }), null);
    const bad = filmDonePayload(job({ master: { chain: ["M"], idx: 1, applied: [], degraded: ["M: passthrough"] } }), null);

    expect("master" in never).toBe(false);
    expect(clean.master).toEqual({ degraded: 0, reasons: [] });
    expect((bad.master as { degraded: number }).degraded).toBe(1);
    // and the three are not equal to each other, which is the property the panel rides on
    expect(never.master).not.toEqual(clean.master);
    expect(clean.master).not.toEqual(bad.master);
  });

  it("WHAT THE PANEL GETS: a limited render is separable from a clean one by these keys alone", () => {
    // The panel's rule is `limited = !!(degrade || clipFinish)` over the payload. Before this change,
    // a film whose master chain passed everything through carried NOTHING to make that true.
    const limited = filmDonePayload(
      job({
        master: { chain: ["MODULE_MASTER"], idx: 1, applied: [], degraded: ["MODULE_MASTER: passthrough"] },
        speech_shots: [speechShot("shot_01", "poll failed: 504")],
        dialogue_degraded: "no dialogue module installed; shipped a silent film",
      }),
      null,
    );
    const clean = filmDonePayload(
      job({
        master: { chain: ["MODULE_MASTER"], idx: 1, applied: ["x"], degraded: [] },
        speech_shots: [speechShot("shot_01")],
        dialogue_audio: { shot_01: "renders/film-836/d/shot_01.wav" },
      }),
      null,
    );
    const limitedCount = ["speech", "master", "dialogue"]
      .map((k) => (limited[k] as { degraded: number } | undefined)?.degraded ?? 0)
      .reduce((a, b) => a + b, 0);
    const cleanCount = ["speech", "master", "dialogue"]
      .map((k) => (clean[k] as { degraded: number } | undefined)?.degraded ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(limitedCount).toBe(3);
    expect(cleanCount).toBe(0);
  });
});
