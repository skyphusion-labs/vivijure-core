import { describe, it, expect } from "vitest";
import { validateClipArtifact, CLIP_MIN_BYTES } from "../src/clip-validate.js";
import { validateDoneClips } from "../src/render-orchestrator.js";
import { craftFilmBytes, r2WithObjects } from "./helpers/mp4.js";
import type { ClipJob } from "../src/render-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// core#310, filed by me while adding the FILM judge in cf#835 and deliberately not fixed there.
//
// `clip-validate.ts`'s own docstring promises: "an unreadable artifact is a 'skip' (transient), not
// a fail, so a blip cannot false-reject a real render." It honoured that for two of the three ways
// an artifact can be unreadable and not for the third. When HEAD said the object exists but a
// ranged GET came back empty, `locateStructure` broke out with `ftypOk: false`, and `judgeClip`
// reported "not a valid mp4 (no ftyp/moov box tree); corrupt or wrong format" -- a positive claim
// about CONTENT from a read that returned none -- and the shot was FAILED on it.
//
// WHY THIS WAS NOT A ONE-LINE FIX, and the reason it waited for its own change: the fix turns a
// FAIL into a SKIP, and `validateDoneClips` wrote that skip straight into `shot.validated`, whose
// truthiness is the idempotence guard. So the naive fix converts a wrong refusal into a PERMANENT
// UNCHECKED PASS -- the shot is never structurally validated again. That is core#30's defect
// (proven in Layer 2) sitting unnoticed in Layer 1, and it has to be fixed in the same change or
// the "fix" is worse than the bug.

const KEY = "renders/p/clips/shot_01.mp4";
const envWith = (objects: Record<string, Uint8Array | number>) =>
  ({ R2_RENDERS: r2WithObjects(objects) }) as unknown as Env;

describe("core#310: an unreadable body is a SKIP, and the docstring stops lying", () => {
  it("present but with no readable body -> skip, NOT a content claim", async () => {
    // The number form is "HEAD reports this size, GET models no body", i.e. the exact shape that
    // used to produce "not a valid mp4".
    const r = await validateClipArtifact(envWith({ [KEY]: 5_000_000 }), KEY, 4);
    expect(r.verdict).toBe("skip");
    expect(r.reason).toMatch(/could not be read/);
    expect(r.reason).not.toMatch(/not a valid mp4/);
  });

  it("THE ORDER THAT MATTERS: a 0-byte clip still FAILS on its size, not excused as unreadable", async () => {
    const r = await validateClipArtifact(envWith({ [KEY]: new Uint8Array(0) }), KEY, 4);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/truncated or empty/);
  });

  it("a truncated clip under the byte floor still FAILS", async () => {
    const r = await validateClipArtifact(envWith({ [KEY]: new Uint8Array(CLIP_MIN_BYTES - 1) }), KEY, 4);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/truncated or empty/);
  });

  it("CONTROL: a body that IS readable and IS garbage still fails as a content claim", async () => {
    // The distinction this PR rests on: read nothing -> skip; read bytes that are not an mp4 -> fail.
    const r = await validateClipArtifact(envWith({ [KEY]: new Uint8Array(64 * 1024).fill(0x5a) }), KEY, 4);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/not a valid mp4/);
  });

  it("CONTROL: a real clip still passes", async () => {
    const r = await validateClipArtifact(envWith({ [KEY]: craftFilmBytes({ durationS: 4, frames: 96 }) }), KEY, 4);
    expect(r.verdict).toBe("pass");
  });

  it("an ABSENT artifact is still a skip (unchanged)", async () => {
    const r = await validateClipArtifact(envWith({}), KEY, 4);
    expect(r.verdict).toBe("skip");
    expect(r.reason).toMatch(/not found in R2/);
  });
});

describe("core#310: a skip does not become a verdict, so Layer 1 re-runs (the core#30 rule, one layer down)", () => {
  const clipJob = (shots: unknown[]): ClipJob => ({ job_id: "j1", shots } as unknown as ClipJob);
  const shot = (over: Record<string, unknown> = {}) => ({
    shot_id: "s1", status: "done", clip_key: KEY, seconds: 4, ...over,
  });

  it("an unreadable body leaves validated UNSET and records why", async () => {
    const job = clipJob([shot()]);
    const changed = await validateDoneClips(envWith({ [KEY]: 5_000_000 }), job);
    expect(job.shots[0].validated, "a skip is not a verdict").toBeUndefined();
    expect(job.shots[0].validated_unmeasured).toMatch(/could not be read/);
    expect(job.shots[0].status, "and it does not fail the shot").toBe("done");
    expect(changed, "the caller must persist the record").toBe(true);
  });

  it("THE REGRESSION THIS PREVENTS: a shot skipped once is re-validated, and fails when now corrupt", async () => {
    // Pre-fix this shot carried validated:"skip", the guard saw a truthy value and `continue`d, and
    // Layer 1 never looked at it again -- a permanent unchecked pass.
    const job = clipJob([shot({ validated: "skip", validated_unmeasured: "clip artifact present but its bytes could not be read this tick" })]);
    await validateDoneClips(envWith({ [KEY]: new Uint8Array(64 * 1024).fill(0x5a) }), job);
    expect(job.shots[0].validated).toBe("fail");
    expect(job.shots[0].status).toBe("failed");
    expect(job.shots[0].validated_unmeasured, "cleared once a verdict lands").toBeUndefined();
  });

  it("a real verdict still short-circuits, so the pass stays idempotent", async () => {
    const job = clipJob([shot({ validated: "pass" })]);
    const changed = await validateDoneClips(envWith({ [KEY]: new Uint8Array(0) }), job);
    expect(job.shots[0].validated).toBe("pass"); // not re-judged
    expect(job.shots[0].status).toBe("done");
    expect(changed).toBe(false);
  });

  it("the record is not rewritten when the same skip repeats (no write per tick)", async () => {
    const job = clipJob([shot({ validated_unmeasured: "clip artifact present but its bytes could not be read this tick" })]);
    const changed = await validateDoneClips(envWith({ [KEY]: 5_000_000 }), job);
    expect(changed).toBe(false);
  });

  it("CONTROL: a readable, valid clip still passes and is recorded as a verdict", async () => {
    const job = clipJob([shot()]);
    await validateDoneClips(envWith({ [KEY]: craftFilmBytes({ durationS: 4, frames: 96 }) }), job);
    expect(job.shots[0].validated).toBe("pass");
    expect(job.shots[0].validated_unmeasured).toBeUndefined();
  });
});
