// core#513: a finish job the bound door MARKS lost to a container restart (cf#1377: a 404 with
// `lost: "instance_restarted"`) is re-submitted on that tick, under the same output key, with fresh
// URLs. An unmarked 404 keeps the not-found streak. A malformed mark is an unmarked 404.
// Lead ruling on the issue, 2026-11-09.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSEMBLE_LOST_RESUBMIT_MAX,
  ASSEMBLE_NOTFOUND_STREAK,
  FINISH_JOB_LOST_REASON,
  decodeAssemblePoll,
  encodeAssemblePoll,
  tickVideoFinishAssemble,
} from "../src/video-finish-assemble.js";
import { advanceFilmJob, filmJobDocKey } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const STALE = { clips: [{ url: "https://invalid.invalid/c.mp4" }], outputUrl: "https://invalid.invalid/assemble", outputKey: "renders/f/film.mp4" };
const FRESH = { clips: [{ url: "https://r2/c.mp4?sig=new" }], outputUrl: "https://r2/film.mp4?sig=new", outputKey: "renders/f/film.mp4" };

/** The bound door, answering /async/status with `status404Body` and /async/finish with a new job id. */
function door(status404Body: string, submit: () => Response = () => new Response(JSON.stringify({ ok: true, jobId: "job-2" }), { status: 202 })) {
  const submits: unknown[] = [];
  const polls: string[] = [];
  const env = {
    MEDIA_FINISH_TOKEN: "t",
    VIDEO_FINISH_URL: "http://video-finish",
    MEDIA_DOOR_FETCHERS: {
      VIDEO_FINISH_URL: {
        fetch: async (url: string, init: RequestInit = {}) => {
          const path = new URL(url).pathname;
          if (path === "/async/finish") { submits.push(JSON.parse(String(init.body))); return submit(); }
          polls.push(path);
          if (path === "/async/status/job-2") return new Response(JSON.stringify({ ok: true, status: "pending" }), { status: 200 });
          return new Response(status404Body, { status: 404 });
        },
      },
    },
  } as unknown as Env;
  return { env, submits, polls };
}

const polling = (over: Record<string, unknown> = {}) => encodeAssemblePoll({ jobId: "job-1", submittedAt: Date.now() - 5000, notFoundStreak: 0, ...over });
const MARKED = JSON.stringify({ ok: false, error: "not_found", lost: FINISH_JOB_LOST_REASON });

describe("a 404 marked lost", () => {
  it("re-submits on that tick, with the fresh payload and the same output key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door(MARKED);
    const tick = await tickVideoFinishAssemble(d.env, STALE, polling(), { affinity: "film-f", repayload: async () => FRESH });
    expect(d.polls).toEqual(["/async/status/job-1"]);
    expect(d.submits).toEqual([FRESH]);
    expect(tick.kind).toBe("pending");
    if (tick.kind !== "pending") return;
    expect(tick.poll).toMatchObject({ jobId: "job-2", notFoundStreak: 0, lost: 1 });
  });

  it("even with a streak already running: the mark ends the debounce", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door(MARKED);
    const tick = await tickVideoFinishAssemble(d.env, STALE, polling({ notFoundStreak: 5 }), { repayload: async () => FRESH });
    expect(d.submits).toHaveLength(1);
    expect(tick.kind === "pending" && tick.poll.notFoundStreak).toBe(0);
  });

  it("the count survives the round trip, and a pending poll carries it", async () => {
    const d = door(MARKED);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await tickVideoFinishAssemble(d.env, STALE, polling({ lost: 1 }), { repayload: async () => FRESH });
    expect(first.kind === "pending" && first.poll.lost).toBe(2);
    if (first.kind !== "pending") throw new Error("expected pending");
    const raw = encodeAssemblePoll(first.poll);
    expect(decodeAssemblePoll(raw)?.lost).toBe(2);
    const next = await tickVideoFinishAssemble(d.env, STALE, raw, { repayload: async () => FRESH });
    expect(next.kind === "pending" && next.poll).toMatchObject({ jobId: "job-2", lost: 2 });
  });

  it(`fails by name once it has been re-submitted ${ASSEMBLE_LOST_RESUBMIT_MAX} times, and does not submit again`, async () => {
    const d = door(MARKED);
    const tick = await tickVideoFinishAssemble(d.env, STALE, polling({ lost: ASSEMBLE_LOST_RESUBMIT_MAX }), { repayload: async () => FRESH });
    expect(d.submits).toEqual([]);
    expect(tick.kind).toBe("failed");
    expect(tick.kind === "failed" && tick.error).toContain("lost the assemble job to a container restart");
  });

  it("a re-submit the door refuses fails the tick by name", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = door(MARKED, () => new Response("bad", { status: 400 }));
    const tick = await tickVideoFinishAssemble(d.env, STALE, polling(), { repayload: async () => FRESH });
    expect(d.submits).toHaveLength(1);
    expect(tick.kind === "failed" && tick.error).toContain("re-submit failed");
  });

  it("with no repayload the mark is read as an ordinary 404, because the stale payload has no live URLs", async () => {
    const d = door(MARKED);
    const tick = await tickVideoFinishAssemble(d.env, STALE, polling(), {});
    expect(d.submits).toEqual([]);
    expect(tick.kind === "pending" && tick.poll.notFoundStreak).toBe(1);
  });
});

describe("an unmarked 404 keeps the debounce", () => {
  it("waits out the streak and never re-submits", async () => {
    const d = door(JSON.stringify({ ok: false, error: "not_found" }));
    let raw = polling();
    for (let i = 1; i < ASSEMBLE_NOTFOUND_STREAK; i++) {
      const t = await tickVideoFinishAssemble(d.env, STALE, raw, { repayload: async () => FRESH });
      expect(t.kind).toBe("pending");
      if (t.kind !== "pending") return;
      expect(t.poll.notFoundStreak).toBe(i);
      raw = encodeAssemblePoll(t.poll);
    }
    const last = await tickVideoFinishAssemble(d.env, STALE, raw, { repayload: async () => FRESH });
    expect(last.kind).toBe("failed");
    expect(d.submits).toEqual([]);
  });

  for (const [label, body] of [
    ["another reason", JSON.stringify({ lost: "evicted" })],
    ["a boolean", JSON.stringify({ lost: true })],
    ["a nested value", JSON.stringify({ lost: { reason: FINISH_JOB_LOST_REASON } })],
    ["an array body", JSON.stringify([{ lost: FINISH_JOB_LOST_REASON }])],
    ["a body that is not JSON", `lost: ${FINISH_JOB_LOST_REASON}`],
    ["an empty body", ""],
  ] as const) {
    it(`a malformed mark (${label}) is unmarked`, async () => {
      const d = door(body);
      const tick = await tickVideoFinishAssemble(d.env, STALE, polling(), { repayload: async () => FRESH });
      expect(d.submits).toEqual([]);
      expect(tick.kind === "pending" && tick.poll.notFoundStreak).toBe(1);
    });
  }
});

describe("every assemble caller can re-submit", () => {
  // The tick can only re-submit when its caller hands it a way to presign. A call site that forgets is
  // silent: the mark reads as a plain 404 and the film waits out the streak. So the source is the check.
  const SRC = join(import.meta.dirname, "..", "src");
  const sites = (file: string) => readFileSync(join(SRC, file), "utf8").split("\n").filter((l) => /tickVideoFinishAssemble\(env,/.test(l));
  it("all four call sites pass repayload", () => {
    const all = [...sites("film-orchestrator.ts"), ...sites("scatter-orchestrator.ts")];
    expect(all).toHaveLength(4); // the denominator
    expect(all.filter((l) => !/repayload:/.test(l))).toEqual([]);
  });
});

describe("a real film tick re-submits a lost assemble with presigned URLs", () => {
  it("the film's own presign builds the re-submit, so it carries live URLs and the film's output key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const FILM = "film-lost";
    const CLIP = `renders/${FILM}/shots/shot_01.mp4`;
    let stored = JSON.stringify({
      film_id: FILM, project: "p", bundle_key: "bundles/none.tar.gz", phase: "assemble", created_at: Date.now(),
      scenes: [{ shot_id: "shot_01", prompt: "x" }],
      finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done", chain: [], idx: 0 }],
      assemble_poll: encodeAssemblePoll({ jobId: "job-1", submittedAt: Date.now() - 60_000, notFoundStreak: 0 }),
    });
    const d = door(MARKED);
    const env = {
      ...(d.env as unknown as Record<string, unknown>),
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(FILM) ? { text: async () => stored } : null),
        head: async () => null,
        put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM)) stored = val; },
        delete: async () => {},
        list: async () => ({ objects: [], truncated: false }),
      },
      PRESIGNER: {
        presignGet: async (key: string) => `https://presigned/${key}`,
        presignPut: async (key: string) => `https://presigned-put/${key}`,
      },
    } as unknown as Env;
    await advanceFilmJob(env, FILM);
    expect(d.polls).toEqual(["/async/status/job-1"]);
    expect(d.submits).toHaveLength(1);
    const body = d.submits[0] as { clips: { url: string }[]; outputUrl: string; outputKey: string };
    expect(body.clips.map((c) => c.url)).toEqual([`https://presigned/${CLIP}`]);
    expect(body.outputUrl).toBe(`https://presigned-put/${body.outputKey}`);
    expect(body.outputKey).toBe(`renders/${FILM}/film.mp4`);
    const after = JSON.parse(stored) as { phase: string; assemble_poll?: string; error?: string };
    expect(after.phase).toBe("assemble");
    expect(after.error).toBeUndefined();
    expect(decodeAssemblePoll(after.assemble_poll)).toMatchObject({ jobId: "job-2", lost: 1 });
  });
});
