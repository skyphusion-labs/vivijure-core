import { describe, expect, it } from "vitest";
import {
  LINE_WAV_MAX_SECONDS,
  LINE_WAV_MIN_SECONDS,
  mintSilenceWav,
  normalizeLineWav,
  parseWavDurationSeconds,
  secondsForShot,
} from "../src/wav-duration.js";

describe("wav-duration", () => {
  it("parses a linear16 silence WAV and reports its length", () => {
    const wav = mintSilenceWav(LINE_WAV_MIN_SECONDS);
    const seconds = parseWavDurationSeconds(wav);
    expect(seconds).toBeCloseTo(LINE_WAV_MIN_SECONDS, 6);
    expect(wav.subarray(0, 4).toString()).toBe("82,73,70,70"); // RIFF
  });

  it("pads a sub-3s line to 3.0s", () => {
    const short = mintSilenceWav(1.5);
    expect(parseWavDurationSeconds(short)).toBeCloseTo(1.5, 6);
    const normalized = normalizeLineWav(short);
    expect(normalized).not.toBeNull();
    expect(normalized!.padded).toBe(true);
    expect(normalized!.trimmed).toBe(false);
    expect(normalized!.seconds).toBeCloseTo(LINE_WAV_MIN_SECONDS, 6);
    expect(parseWavDurationSeconds(normalized!.bytes)).toBeCloseTo(LINE_WAV_MIN_SECONDS, 6);
  });

  it("keeps a legal 3-15s file unchanged", () => {
    const wav = mintSilenceWav(8);
    const normalized = normalizeLineWav(wav);
    expect(normalized).not.toBeNull();
    expect(normalized!.padded).toBe(false);
    expect(normalized!.trimmed).toBe(false);
    expect(normalized!.bytes).toBe(wav);
    expect(normalized!.seconds).toBeCloseTo(8, 6);
  });

  it("trims a file above 15s", () => {
    const long = mintSilenceWav(20);
    const normalized = normalizeLineWav(long);
    expect(normalized).not.toBeNull();
    expect(normalized!.trimmed).toBe(true);
    expect(normalized!.padded).toBe(false);
    expect(normalized!.seconds).toBeCloseTo(LINE_WAV_MAX_SECONDS, 6);
    expect(parseWavDurationSeconds(normalized!.bytes)).toBeCloseTo(LINE_WAV_MAX_SECONDS, 6);
  });

  it("refuses a non-RIFF buffer", () => {
    expect(parseWavDurationSeconds(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(normalizeLineWav(new Uint8Array(64))).toBeNull();
  });

  it("secondsForShot is max(board, wav) and never snaps down", () => {
    expect(secondsForShot(5, 1.5)).toBe(5);
    expect(secondsForShot(5, 3)).toBe(5);
    expect(secondsForShot(5, 12)).toBe(12);
    expect(secondsForShot(4, 4)).toBe(4);
    expect(secondsForShot(5, undefined)).toBe(5);
  });
});
