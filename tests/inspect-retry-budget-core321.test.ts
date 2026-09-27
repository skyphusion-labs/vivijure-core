import { describe, it, expect, vi, afterEach } from "vitest";
import { callVideoFinishInspect, contentValidateDoneClips, type ContentVerdict } from "../src/clip-content-validate.js";
import { installVfFetch } from "./install-vf-fetch.js";
import type { ClipJob } from "../src/render-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// core#321, found while building cf#856's end-to-end case and filed rather than bundled.
//
// callVideoFinishInspect retried a THROWN fetch three times at 1500ms, because the loop's break
// tested `resp && resp.status !== 503 ...` and a throw leaves resp null, which is falsy, which is
// not a break. contentValidateDoneClips walks shots SEQUENTIALLY, so with the container down that
// is ~3s per shot: ~15s on the 5-shot cf#851 film, ~51s of a finish pass on a 17-shot one, re-paid
// on later ticks because core#30 says not to persist the skip.
//
// TWO CHANGES, AND THE SECOND IS THE ONE THAT MATTERS AT SCALE:
//   1. A thrown (or null) fetch is not the gateway-busy condition the backoff was written for. One
//      attempt establishes it.
//   2. A per-pass circuit breaker: once one shot says the tier is not serving, the rest of the pass
//      does not re-probe it, while STILL getting the cf#856 unmeasured record.
//
// WHAT IS DELIBERATELY UNCHANGED: the 503/504 retry. That is the container saying "busy, come
// back", and cutting it trades this latency problem for a coverage problem -- more false
// `unmeasured` records, which is the state cf#856 exists to make visible. The second case below is
// the guard on that, and it is the one that would catch an over-eager future simplification.

const env = { VIDEO_FINISH_URL: "https://video-finish.test", MEDIA_FINISH_TOKEN: "t" } as unknown as Env;
const payload = { clipUrl: "https://presigned/clip.mp4" };

afterEach(() => { vi.restoreAllMocks(); });

describe("core#321: the retry budget is spent on the condition it was written for", () => {
  it("a THROWN fetch is attempted ONCE and reported unreachable", async () => {
    let attempts = 0;
    installVfFetch(async () => { attempts += 1; throw new TypeError("fetch failed"); });
    const r = await callVideoFinishInspect(env, payload, { backoffMs: 0 });
    expect(attempts, "3 attempts before this change").toBe(1);
    expect(r).toEqual({ unreachable: true });
  });

  it("CONTROL, and the important one: a 503 is STILL retried to the full budget", async () => {
    let attempts = 0;
    installVfFetch(async () => { attempts += 1; return new Response("busy", { status: 503 }); });
    const r = await callVideoFinishInspect(env, payload, { retries: 3, backoffMs: 0 });
    expect(attempts, "cutting this would trade latency for coverage").toBe(3);
    expect(r).toEqual({ unreachable: true });
  });

  it("a 504 is still retried too", async () => {
    let attempts = 0;
    installVfFetch(async () => { attempts += 1; return new Response("gw timeout", { status: 504 }); });
    await callVideoFinishInspect(env, payload, { retries: 3, backoffMs: 0 });
    expect(attempts).toBe(3);
  });

  it("a 503 that RECOVERS mid-budget still returns the verdict", async () => {
    let attempts = 0;
    installVfFetch(async () => {
      attempts += 1;
      if (attempts < 2) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ ok: true, verdict: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const r = await callVideoFinishInspect(env, payload, { retries: 3, backoffMs: 0 });
    expect(attempts).toBe(2);
    expect(r).toEqual({ ok: true, verdict: "ok" });
  });

  it("a 500 is not retried (it answered; it is just not serving this call)", async () => {
    let attempts = 0;
    installVfFetch(async () => { attempts += 1; return new Response("crashed", { status: 500 }); });
    const r = await callVideoFinishInspect(env, payload, { retries: 3, backoffMs: 0 });
    expect(attempts).toBe(1);
    expect(r).toEqual({ unreachable: true });
  });

  it("a 2xx with an unreadable body is NOT unreachable: the tier is up, this clip is not readable", async () => {
    installVfFetch(async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const r = await callVideoFinishInspect(env, payload, { retries: 3, backoffMs: 0 });
    expect(r, "must not trip the per-pass breaker").toBeNull();
  });
});

describe("core#321: the per-pass circuit breaker", () => {
  const jobOf = (n: number): ClipJob =>
    ({
      job_id: "j1",
      shots: Array.from({ length: n }, (_unused, i) => ({
        shot_id: `shot_${String(i + 1).padStart(2, "0")}`,
        status: "done",
        clip_key: `renders/f/shot_${i + 1}.mp4`,
      })),
    }) as unknown as ClipJob;

  it("probes ONCE for a 17-shot film with the tier down, and still records all 17", async () => {
    let probes = 0;
    const inspect = async (): Promise<ContentVerdict> => {
      probes += 1;
      return { verdict: "skip", reason: "video-finish /inspect unreachable or errored", unreachable: true };
    };
    const job = jobOf(17);
    const changed = await contentValidateDoneClips(env, job, inspect);

    expect(probes, "17 sequential transport failures before this change").toBe(1);
    // cf#856's record is NOT sacrificed for the saving: every shot is still unvouched-for and says so.
    expect(job.shots.filter((s) => s.content_unmeasured).length).toBe(17);
    expect(job.shots.every((s) => s.content_validated === undefined)).toBe(true);
    expect(changed).toBe(true);
  });

  it("does NOT trip on a per-clip skip that is not a tier failure", async () => {
    // A presign failure is one clip's problem. Breaking the pass on it would skip clips that could
    // have been inspected, which is the opposite of what this gate is for.
    let probes = 0;
    const inspect = async (): Promise<ContentVerdict> => {
      probes += 1;
      return { verdict: "skip", reason: "presign failed: boom" };
    };
    const job = jobOf(5);
    await contentValidateDoneClips(env, job, inspect);
    expect(probes).toBe(5);
  });

  it("CONTROL: a healthy pass inspects every shot and trips nothing", async () => {
    let probes = 0;
    const inspect = async (): Promise<ContentVerdict> => { probes += 1; return { verdict: "ok" }; };
    const job = jobOf(5);
    await contentValidateDoneClips(env, job, inspect);
    expect(probes).toBe(5);
    expect(job.shots.every((s) => s.content_validated === "ok")).toBe(true);
  });

  it("the breaker does not latch beyond the pass: the next call probes again", async () => {
    const job = jobOf(3);
    let probes = 0;
    await contentValidateDoneClips(env, job, async () => {
      probes += 1;
      return { verdict: "skip", reason: "video-finish /inspect unreachable or errored", unreachable: true };
    });
    expect(probes).toBe(1);
    // The tier comes back. Nothing persisted a verdict, so every shot is re-inspected (core#30).
    await contentValidateDoneClips(env, job, async () => { probes += 1; return { verdict: "ok" }; });
    expect(probes).toBe(1 + 3);
    expect(job.shots.every((s) => s.content_validated === "ok")).toBe(true);
    expect(job.shots.every((s) => s.content_unmeasured === undefined)).toBe(true);
  });

  it("a mid-pass tier failure breaks only the REMAINDER, keeping the verdicts already earned", async () => {
    const job = jobOf(4);
    let probes = 0;
    await contentValidateDoneClips(env, job, async () => {
      probes += 1;
      if (probes <= 2) return { verdict: "ok" };
      return { verdict: "skip", reason: "video-finish /inspect unreachable or errored", unreachable: true };
    });
    expect(probes, "2 good, 1 that trips, and the 4th taken from the breaker").toBe(3);
    expect(job.shots.slice(0, 2).every((s) => s.content_validated === "ok")).toBe(true);
    expect(job.shots.slice(2).every((s) => s.content_unmeasured)).toBe(true);
  });
});
