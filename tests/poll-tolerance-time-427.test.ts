// core#427: a clip poll's transport tolerance is wall-clock time as well as consecutive polls.
//
// Polls come from the cron (one a minute) and from every client poll of the render, which can be
// seconds apart. Counted in polls alone, a fast client spent the whole tolerance on a blip of a few
// seconds. Now a run of transport failures fails the shot only once it has lasted
// CLIP_POLL_TOLERANCE_SECONDS AND CLIP_POLL_MAX_ATTEMPTS polls.

import { describe, expect, it } from "vitest";
import { applyPoll, CLIP_POLL_MAX_ATTEMPTS, CLIP_POLL_TOLERANCE_SECONDS, pollToleranceSpent, type ClipShot } from "../src/render-orchestrator.js";

const shot = (): ClipShot => ({ shot_id: "s", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", poll: "t" });
const blip = { ok: false as const, error: "module /poll -> 502" };
const W = CLIP_POLL_TOLERANCE_SECONDS * 1000;

describe("pollToleranceSpent (core#427)", () => {
  it("needs both the count and the time", () => {
    expect(CLIP_POLL_MAX_ATTEMPTS).toBe(3);
    expect(CLIP_POLL_TOLERANCE_SECONDS).toBe(120);
    expect(pollToleranceSpent(3, 0, W)).toBe(true);
    expect(pollToleranceSpent(3, 0, W - 1)).toBe(false); // enough polls, not enough time: the fast client
    expect(pollToleranceSpent(2, 0, 10 * W)).toBe(false); // enough time, not enough polls: a slow cadence
  });
});

describe("a fast poller cannot spend the clip poll tolerance (core#427)", () => {
  it("twenty failing polls one second apart hold the shot", () => {
    const s = shot();
    for (let i = 0; i < 20; i++) applyPoll(s, blip, "p", i * 1_000);
    expect(s.status).toBe("pending");
    expect(s.poll).toBe("t");
    expect(s.poll_attempts).toBe(20);
    expect(s.poll_failing_since).toBe(0);
  });

  it("the same run fails once it has lasted the window, and says how long", () => {
    const s = shot();
    for (let i = 0; i < 5; i++) applyPoll(s, blip, "p", i * 1_000);
    applyPoll(s, blip, "p", W);
    expect(s.status).toBe("failed");
    expect(s.error).toBe("module /poll -> 502 (persisted through 6 consecutive polls over 120s, #719)");
  });

  it("CONTROL: at the cron's cadence the shot fails on the third failing tick, as before", () => {
    const s = shot();
    applyPoll(s, blip, "p", 0);
    applyPoll(s, blip, "p", 60_000);
    expect(s.status).toBe("pending");
    applyPoll(s, blip, "p", 120_000);
    expect(s.status).toBe("failed");
  });

  it("a clean poll ends the run, so the window starts again", () => {
    const s = shot();
    applyPoll(s, blip, "p", 0);
    applyPoll(s, blip, "p", 1_000);
    applyPoll(s, { ok: true, pending: true }, "p", 2_000);
    expect(s.poll_attempts).toBe(0);
    expect(s.poll_failing_since).toBeUndefined();
    applyPoll(s, blip, "p", 100_000);
    applyPoll(s, blip, "p", 101_000);
    applyPoll(s, blip, "p", 130_000);
    expect(s.status).toBe("pending"); // 3 failures, only 30 s into this run
    expect(s.poll_failing_since).toBe(100_000);
  });
});
