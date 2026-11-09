// core#308: a video-finish submit that never returns was unbounded. The capacity clock, the transport
// hold and the job horizon all start after submitAsync returns, so a door that never answered left
// `assemble` with no error, indistinguishable from work in progress. Now every door request has a
// deadline (FINISH_DOOR_TIMEOUT_SECONDS), and a hang is an outcome the tick classifies.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINISH_DOOR_TIMEOUT_SECONDS,
  FINISH_TRANSPORT_HOLD_MAX_SECONDS,
  decodeAssembleWait,
  encodeAssemblePoll,
  encodeAssembleWait,
  tickVideoFinishAssemble,
} from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const payload = { clips: [{ url: "https://r2/c.mp4" }], outputUrl: "https://r2/o.mp4", outputKey: "renders/x/film.mp4" };

/** A bound door. `hang` paths never settle unless their signal aborts; others answer at `delayMs`. */
function door(opts: { hang: (path: string) => boolean; delayMs?: number }) {
  const seen: Array<{ path: string; signal?: AbortSignal }> = [];
  const env = {
    MEDIA_FINISH_TOKEN: "t",
    VIDEO_FINISH_URL: "http://video-finish",
    MEDIA_DOOR_FETCHERS: {
      VIDEO_FINISH_URL: {
        fetch: (url: string, init: RequestInit = {}) => {
          const path = new URL(url).pathname;
          seen.push({ path, signal: init.signal ?? undefined });
          if (opts.hang(path)) return new Promise<Response>(() => {}); // never settles, ignores the signal
          return new Promise<Response>((resolve) => setTimeout(() => resolve(
            path === "/async/finish"
              ? new Response(JSON.stringify({ ok: true, jobId: "j1" }), { status: 202 })
              : new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
          ), opts.delayMs ?? 0));
        },
      },
    },
  } as unknown as Env;
  return { env, seen };
}

/** Run a tick under fake timers, advancing the clock until it settles or `maxMs` passes. */
async function settle<T>(p: Promise<T>, maxMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let out: { done: true; value: T } | { done: false } = { done: false };
  p.then((value) => { out = { done: true, value }; });
  for (let t = 0; t <= maxMs && !out.done; t += 1000) await vi.advanceTimersByTimeAsync(1000);
  return out;
}

describe("a submit that never answers", () => {
  it(`is unreachable within ${FINISH_DOOR_TIMEOUT_SECONDS}s, and with no holder the tick fails by name`, async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door({ hang: (p) => p === "/async/finish" });
    const r = await settle(tickVideoFinishAssemble(d.env, payload, undefined, {}), FINISH_DOOR_TIMEOUT_SECONDS * 1000 + 5000);
    expect(r.done).toBe(true);
    if (!r.done) return;
    // No holder: the transport failure fails the tick by name, and says why.
    expect(r.value).toMatchObject({ kind: "failed", unreachable: true });
    expect(r.value.kind === "failed" && r.value.error).toContain(`no answer within ${FINISH_DOOR_TIMEOUT_SECONDS}s`);
  });

  it("with an affinity holder it waits (the core#377 transport hold) instead of failing at once", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door({ hang: (p) => p === "/async/finish" });
    const r = await settle(tickVideoFinishAssemble(d.env, payload, undefined, { affinity: "film-1" }), FINISH_DOOR_TIMEOUT_SECONDS * 1000 + 5000);
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.value.kind).toBe("waiting");
    if (r.value.kind !== "waiting") return;
    expect(r.value.detail).toContain(`no answer within ${FINISH_DOOR_TIMEOUT_SECONDS}s`);
    expect(decodeAssembleWait(r.value.wait)?.attempts).toBe(1);
  });

  it("past the transport hold a hanging submit fails by name: the pre-jobId window is bounded", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door({ hang: (p) => p === "/async/finish" });
    const firstAt = Date.now() - FINISH_TRANSPORT_HOLD_MAX_SECONDS * 1000 - 1;
    const wait = encodeAssembleWait({ firstAt, attempts: 5, nextAt: Date.now() - 1, detail: "x" });
    const r = await settle(tickVideoFinishAssemble(d.env, payload, undefined, { affinity: "film-1", wait }), FINISH_DOOR_TIMEOUT_SECONDS * 1000 + 5000);
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.value).toMatchObject({ kind: "failed", unreachable: true });
  });

  it("the transport is handed a signal, and it is aborted at the deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door({ hang: (p) => p === "/async/finish" });
    await settle(tickVideoFinishAssemble(d.env, payload, undefined, {}), FINISH_DOOR_TIMEOUT_SECONDS * 1000 + 5000);
    const sub = d.seen.find((s) => s.path === "/async/finish");
    expect(sub?.signal).toBeInstanceOf(AbortSignal);
    expect(sub?.signal?.aborted).toBe(true);
  });

  it("CONTROL: a submit that answers just inside the deadline is accepted", async () => {
    vi.useFakeTimers();
    const d = door({ hang: () => false, delayMs: (FINISH_DOOR_TIMEOUT_SECONDS - 2) * 1000 });
    const r = await settle(tickVideoFinishAssemble(d.env, payload, undefined, {}), FINISH_DOOR_TIMEOUT_SECONDS * 2000);
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.value.kind).toBe("pending");
    expect(r.value.kind === "pending" && r.value.poll.jobId).toBe("j1");
  });
});

describe("a status poll that never answers (fix-forward, same defect)", () => {
  it("is a miss counted by the streak, within the deadline", async () => {
    vi.useFakeTimers();
    const d = door({ hang: (p) => p.startsWith("/async/status/") });
    const poll = encodeAssemblePoll({ jobId: "j1", submittedAt: Date.now(), notFoundStreak: 0 });
    const r = await settle(tickVideoFinishAssemble(d.env, payload, poll, {}), FINISH_DOOR_TIMEOUT_SECONDS * 1000 + 5000);
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.value.kind === "pending" && r.value.poll.notFoundStreak).toBe(1);
  });
});
