import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSEMBLE_NOTFOUND_STREAK,
  decodeAssemblePoll,
  encodeAssemblePoll,
  tickVideoFinishAssemble,
  videoFinishPollUrls,
} from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

function envWith(over: Record<string, unknown>): Env {
  return over as unknown as Env;
}

const payload = {
  clips: [{ url: "https://r2.example/c1.mp4" }],
  outputUrl: "https://r2.example/out.mp4",
  outputKey: "renders/x/film.mp4",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("videoFinishPollUrls", () => {
  it("is just the submit origin for a self-host URL", () => {
    expect(videoFinishPollUrls(envWith({ VIDEO_FINISH_URL: "https://finish.home:8000" }))).toEqual([
      "https://finish.home:8000",
    ]);
  });

  it("adds the three hosted poll names for video-finish.skyphusion.org", () => {
    const urls = videoFinishPollUrls(envWith({ VIDEO_FINISH_URL: "https://video-finish.skyphusion.org" }));
    expect(urls).toContain("https://video-finish.skyphusion.org");
    expect(urls).toContain("https://video-finish-jello.skyphusion.org");
    expect(urls).toContain("https://video-finish-descendents.skyphusion.org");
    expect(urls).toContain("https://video-finish-badbrains.skyphusion.org");
  });

  it("honors VIDEO_FINISH_POLL_URLS", () => {
    const urls = videoFinishPollUrls(envWith({
      VIDEO_FINISH_URL: "https://finish.home:8000",
      VIDEO_FINISH_POLL_URLS: "https://a.example, https://b.example",
    }));
    expect(urls).toEqual(["https://finish.home:8000", "https://a.example", "https://b.example"]);
  });
});

describe("tickVideoFinishAssemble", () => {
  it("submits /async/finish and returns pending with a job id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("/async/finish");
      return new Response(JSON.stringify({ ok: true, jobId: "job-1", status: "pending" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tick = await tickVideoFinishAssemble(
      envWith({ VIDEO_FINISH_URL: "https://video-finish.example" }),
      payload,
      undefined,
    );
    expect(tick.kind).toBe("pending");
    if (tick.kind === "pending") expect(tick.poll.jobId).toBe("job-1");
  });

  it("polls every hosted replica and takes the completed one", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/async/finish")) {
        return new Response(JSON.stringify({ ok: true, jobId: "job-2" }), { status: 202 });
      }
      if (u.includes("video-finish-jello") && u.includes("/async/status/job-2")) {
        return new Response(JSON.stringify({
          ok: true,
          status: "completed",
          result: { ok: true, durationSeconds: 48, clipDurations: [4, 4] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, status: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = envWith({ VIDEO_FINISH_URL: "https://video-finish.skyphusion.org" });
    const first = await tickVideoFinishAssemble(env, payload, undefined);
    expect(first.kind).toBe("pending");
    const token = first.kind === "pending" ? encodeAssemblePoll(first.poll) : "";
    const second = await tickVideoFinishAssemble(env, payload, token);
    expect(second.kind).toBe("done");
    if (second.kind === "done") expect(second.result.durationSeconds).toBe(48);
  });

  it("keeps pending through peer 404s until the streak cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, status: "not_found" }), { status: 404 }),
    ));
    const env = envWith({ VIDEO_FINISH_URL: "https://video-finish.example" });
    let token = encodeAssemblePoll({ jobId: "gone", submittedAt: Date.now(), notFoundStreak: ASSEMBLE_NOTFOUND_STREAK - 2 });
    const almost = await tickVideoFinishAssemble(env, payload, token);
    expect(almost.kind).toBe("pending");
    token = almost.kind === "pending" ? encodeAssemblePoll(almost.poll) : "";
    const dead = await tickVideoFinishAssemble(env, payload, token);
    expect(dead.kind).toBe("failed");
  });

  it("treats a 524 on poll as pending, not terminal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("timeout", { status: 524 })));
    const env = envWith({ VIDEO_FINISH_URL: "https://video-finish.example" });
    const tick = await tickVideoFinishAssemble(
      env,
      payload,
      encodeAssemblePoll({ jobId: "slow", submittedAt: Date.now(), notFoundStreak: 3 }),
    );
    expect(tick.kind).toBe("pending");
    if (tick.kind === "pending") expect(tick.poll.notFoundStreak).toBe(0);
  });
});

describe("assemble poll token", () => {
  it("round-trips", () => {
    const raw = encodeAssemblePoll({ jobId: "abc", submittedAt: 9, notFoundStreak: 2 });
    expect(decodeAssemblePoll(raw)).toEqual({ jobId: "abc", submittedAt: 9, notFoundStreak: 2 });
  });
});
