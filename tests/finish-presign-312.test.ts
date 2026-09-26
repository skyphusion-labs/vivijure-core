// cf#312: speechEnhancedAudioKey pins the `_enh.wav` output-key convention the core presigns a speech
// step's PUT against, so the core never imports a module to compute it.
//
// This suite STARTED as one half of a cross-repo transcription lock against modules/speech-upscale's
// enhancedAudioKey. That module is retired (cf#786) and no shipped module declares the `speech` hook,
// so the other half of the lock is gone: the convention now lives HERE, and `SpeechInput.output_key`
// is the side a future speech module must match. The assertions are unchanged and still go red on a
// real defect, because the helper has a live caller (attachSpeechPresigns).
//
// WHAT THIS FILE CANNOT SEE, so nobody reads it as transport coverage: it asserts a pure string
// helper and drives NOTHING in the presign path. finish-presign-keyset-312.test.ts is the gate for
// that -- it drives attachFinishPresigns / attachSpeechPresigns at the one injected seam
// (env.PRESIGNER) and asserts the key set actually handed to the presigner.

import { describe, it, expect } from "vitest";
import { speechEnhancedAudioKey } from "../src/film-orchestrator.js";

describe("speechEnhancedAudioKey (cf#312)", () => {
  it("inserts _enh.wav before the extension", () => {
    expect(speechEnhancedAudioKey("renders/neon/dialogue/shot_01.wav")).toBe(
      "renders/neon/dialogue/shot_01_enh.wav",
    );
  });

  it("replaces a non-wav extension with _enh.wav (endpoint always writes wav)", () => {
    expect(speechEnhancedAudioKey("renders/p/dialogue/s.mp3")).toBe(
      "renders/p/dialogue/s_enh.wav",
    );
  });

  it("appends when there is no extension in the filename", () => {
    expect(speechEnhancedAudioKey("renders/p/dialogue/shot_01")).toBe(
      "renders/p/dialogue/shot_01_enh.wav",
    );
  });

  it("only treats a dot in the FILENAME as the extension", () => {
    expect(speechEnhancedAudioKey("a.b/dialogue/shot")).toBe("a.b/dialogue/shot_enh.wav");
  });
});
