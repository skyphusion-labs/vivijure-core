import { describe, expect, it } from "vitest";
import {
  LINE_WAV_MAX_SECONDS,
  LINE_WAV_MIN_SECONDS,
  UNLINED_SILENCE_SECONDS,
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

  it("pads nothing by default (core#464): a 1.5s line stays 1.5s", () => {
    const short = mintSilenceWav(1.5);
    const normalized = normalizeLineWav(short);
    expect(normalized).not.toBeNull();
    expect(normalized!.padded).toBe(false);
    expect(normalized!.bytes).toBe(short);
    expect(normalized!.seconds).toBeCloseTo(1.5, 6);
  });

  it("pads to the floor it is given, and only to that floor", () => {
    const short = mintSilenceWav(1.5);
    const normalized = normalizeLineWav(short, 3);
    expect(normalized!.padded).toBe(true);
    expect(normalized!.trimmed).toBe(false);
    expect(normalized!.seconds).toBeCloseTo(3, 6);
    expect(parseWavDurationSeconds(normalized!.bytes)).toBeCloseTo(3, 6);
    expect(normalizeLineWav(short, 2)!.seconds).toBeCloseTo(2, 6);
  });

  it("an unusable floor pads nothing, and a floor over the cap stops at the cap", () => {
    const short = mintSilenceWav(1.5);
    for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      expect(normalizeLineWav(short, bad)!.seconds, String(bad)).toBeCloseTo(1.5, 6);
    }
    expect(normalizeLineWav(short, 99)!.seconds).toBeCloseTo(LINE_WAV_MAX_SECONDS, 6);
  });

  it("the minted silence for an unlined shot is still 3s", () => {
    expect(parseWavDurationSeconds(mintSilenceWav())).toBeCloseTo(UNLINED_SILENCE_SECONDS, 6);
    expect(LINE_WAV_MIN_SECONDS).toBe(UNLINED_SILENCE_SECONDS);
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
