// cf#312: speechEnhancedAudioKey must stay locked to modules/speech-upscale's enhancedAudioKey
// convention so the core can presign the speech step's PUT without importing a module.

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
