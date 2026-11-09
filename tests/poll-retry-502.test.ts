// core#502: a failed clip poll can SAY whether another try can help. applyPoll reads the closed
// `retry` field first and falls back to the prose classifiers only when it is absent.
//
// The proof that the field is read is a contradiction: the field and the prose disagree, and the
// field wins, in both directions. The proof that nothing moved for a module that does not set it is
// the table at the bottom: every prose case gives the same shot state with the field absent as it did
// before, and an unknown value behaves exactly like absent.

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPoll, CLIP_SUBMIT_MAX_ATTEMPTS, declaredPollRetry, type ClipShot } from "../src/render-orchestrator.js";
import { isPollRetry, POLL_RETRY_VALUES, type PollResponse } from "../src/modules/types.js";
import type { MotionBackendOutput } from "../src/modules/types.js";

afterEach(() => vi.restoreAllMocks());

const shot = (): ClipShot => ({ shot_id: "s", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", poll: "t" });
type Fail = Extract<PollResponse<MotionBackendOutput>, { ok: false }>;
const fail = (error: string, retry?: unknown): PollResponse<MotionBackendOutput> =>
  (retry === undefined ? { ok: false, error } : { ok: false, error, retry }) as Fail;
const state = (s: ClipShot) => ({ status: s.status, poll: s.poll, poll_attempts: s.poll_attempts, submit_attempts: s.submit_attempts, error: s.error });

const DETERMINISTIC_PROSE = "own-gpu job not found on RunPod (#141)";
const TRANSIENT_PROSE = "google-veo job failed: high load, try again later";

describe("the closed retry set (core#502)", () => {
  it("is exactly transient and deterministic", () => {
    expect(POLL_RETRY_VALUES).toEqual(["transient", "deterministic"]);
    expect(["transient", "deterministic", "Transient", "retry", "", null, 1].map(isPollRetry))
      .toEqual([true, true, false, false, false, false, false]);
  });
});

describe("applyPoll reads the declared retry before the prose (core#502)", () => {
  it("declared transient wins over deterministic prose: the dead token is dropped and the shot resubmits", () => {
    const s = shot();
    applyPoll(s, fail(DETERMINISTIC_PROSE, "transient"), "p");
    expect(s.status).toBe("pending");
    expect(s.poll).toBeUndefined();
    expect(s.submit_attempts).toBe(1);
    expect(s.error).toBe(`transient submit retry 1/${CLIP_SUBMIT_MAX_ATTEMPTS}: ${DETERMINISTIC_PROSE}`);
  });

  it("declared deterministic wins over transient prose: the shot fails now, with no retry", () => {
    const s = shot();
    applyPoll(s, fail(TRANSIENT_PROSE, "deterministic"), "p");
    expect(s.status).toBe("failed");
    expect(s.error).toBe(TRANSIENT_PROSE);
    expect(s.submit_attempts).toBeUndefined();
  });

  it("a declared transient is a failed provider job, never a re-poll, even when the prose reads like transport", () => {
    // Only pollModule builds transport errors, and it never sets retry, so a declared value means the
    // module answered. Re-polling a dead token would wait on nothing.
    const s = shot();
    applyPoll(s, fail("module unreachable: connection reset", "transient"), "p");
    expect(s.poll).toBeUndefined();
    expect(s.poll_attempts).toBe(0);
    expect(s.submit_attempts).toBe(1);
  });

  it("declared transient still honours the submit cap", () => {
    const s = shot();
    for (let i = 0; i < CLIP_SUBMIT_MAX_ATTEMPTS; i++) {
      s.poll = "t";
      applyPoll(s, fail("provider restarted", "transient"), "p");
    }
    expect(s.status).toBe("failed");
    expect(s.error).toBe(`provider restarted (submit retries exhausted, ${CLIP_SUBMIT_MAX_ATTEMPTS})`);
  });

  it("an unknown value is logged and read as absent, never guessed into a class", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(declaredPollRetry({ retry: "maybe" })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"maybe"'));
    expect(declaredPollRetry({})).toBeUndefined();
    expect(declaredPollRetry({ retry: "deterministic" })).toBe("deterministic");
  });
});

describe("no retry decision moves for a module that does not set the field (core#502)", () => {
  // Every prose shape the existing suites classify. Each row is run from a fresh shot three times:
  // field absent, then an unknown value (which must behave as absent). The expected state is today's.
  const PROSE: [string, "repoll" | "resubmit" | "fail"][] = [
    ["module /poll -> 502", "repoll"],
    ["module /invoke -> 429", "repoll"],
    ["module unreachable: fetch failed", "repoll"],
    ["module unreachable: connection reset", "repoll"],
    ["local-gpu /status -> 504", "resubmit"],
    ["AiGatewayError: 7003: Model execution failed", "resubmit"],
    [TRANSIENT_PROSE, "resubmit"],
    ["fetch proxied image -> 429", "resubmit"],
    ["module /poll -> 404", "fail"],
    ["CUDA out of memory", "fail"],
    [DETERMINISTIC_PROSE, "fail"],
    ['Invalid request body: field "resolution" must be one of ["720p"]', "fail"],
    ["boom", "fail"],
  ];

  for (const [error, expected] of PROSE) {
    it(`${expected}: ${error}`, () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const absent = shot();
      applyPoll(absent, fail(error), "p");
      if (expected === "repoll") expect(state(absent)).toMatchObject({ status: "pending", poll: "t", poll_attempts: 1 });
      if (expected === "resubmit") expect(state(absent)).toMatchObject({ status: "pending", poll: undefined, submit_attempts: 1 });
      if (expected === "fail") expect(state(absent)).toMatchObject({ status: "failed", error });
      const unknown = shot();
      applyPoll(unknown, fail(error, "sometimes"), "p");
      expect(state(unknown)).toEqual(state(absent));
    });
  }
});
