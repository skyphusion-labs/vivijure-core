import { describe, expect, it } from "vitest";
import { FINISH_PRESIGN_TTL_SECONDS } from "../src/film-orchestrator.js";

// vivijure-cf#1161: measured on film-f6622666, a one-at-a-time door at about 2.5 minutes a clip.
describe("a finish step's presigned URLs", () => {
  it("outlast a 50 shot film on a one-at-a-time door", () => {
    const secondsPerClip = 150;
    const maxShots = 50;
    expect(FINISH_PRESIGN_TTL_SECONDS).toBeGreaterThan(secondsPerClip * maxShots);
  });
});
