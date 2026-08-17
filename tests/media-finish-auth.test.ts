import { describe, expect, it, vi } from "vitest";
import {
  mediaDoorFetch,
  mediaDoorUrl,
  mediaFinishHeaders,
  mediaFinishToken,
  MediaFinishAuthError,
  videoFinishReachable,
  videoFinishUrl,
} from "../src/media-finish-auth.js";
import { tickVideoFinishAssemble } from "../src/video-finish-assemble.js";
import { callAudioMix, callVideoFinish, shouldMultiTrackMix } from "../src/film-orchestrator.js";
import { callVideoFinishInspect } from "../src/clip-content-validate.js";
import { callImagePrep } from "../src/bundle-assembler.js";
import { analyzeAudioBeats } from "../src/beat-analyze.js";
import type { FilmJob } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

function envWith(over: Record<string, unknown>): Env {
  return over as unknown as Env;
}

describe("mediaFinishToken", () => {
  it("returns empty when nothing is bound (fail-open)", async () => {
    expect(await mediaFinishToken(envWith({}))).toBe("");
  });

  it("uses MEDIA_FINISH_TOKEN when it is a string", async () => {
    expect(await mediaFinishToken(envWith({ MEDIA_FINISH_TOKEN: "  tok  " }))).toBe("tok");
  });

  it("falls back to FINISH_DOOR_TOKEN", async () => {
    expect(await mediaFinishToken(envWith({ FINISH_DOOR_TOKEN: "door" }))).toBe("door");
  });

  it("prefers MEDIA_FINISH_TOKEN over FINISH_DOOR_TOKEN", async () => {
    expect(
      await mediaFinishToken(envWith({ MEDIA_FINISH_TOKEN: "media", FINISH_DOOR_TOKEN: "door" })),
    ).toBe("media");
  });

  it("resolves a Secrets Store handle via get()", async () => {
    expect(
      await mediaFinishToken(envWith({ MEDIA_FINISH_TOKEN: { get: async () => "from-store" } })),
    ).toBe("from-store");
  });

  it("treats a failed get() as absent, not a throw", async () => {
    expect(
      await mediaFinishToken(
        envWith({
          MEDIA_FINISH_TOKEN: {
            get: async () => {
              throw new Error("store down");
            },
          },
        }),
      ),
    ).toBe("");
  });
});

describe("mediaFinishHeaders", () => {
  it("omits Authorization when no token is bound and no door URL is set", async () => {
    expect(await mediaFinishHeaders(envWith({}))).toEqual({ "content-type": "application/json" });
  });

  it("adds Bearer when a token is bound", async () => {
    expect(await mediaFinishHeaders(envWith({ MEDIA_FINISH_TOKEN: "abc" }))).toEqual({
      "content-type": "application/json",
      authorization: "Bearer abc",
    });
  });

  it("throws when a door URL is set and the token is empty", async () => {
    await expect(
      mediaFinishHeaders(envWith({ VIDEO_FINISH_URL: "https://video-finish.example" })),
    ).rejects.toBeInstanceOf(MediaFinishAuthError);
  });
});

describe("mediaDoorFetch fail-closed", () => {
  it("returns null when the door URL is unset (self-host off)", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      expect(await mediaDoorFetch(envWith({}), "VIDEO_FINISH_URL", "/finish", { method: "POST" })).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("throws and does not fetch when the URL is set and the token is empty", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await expect(
        mediaDoorFetch(
          envWith({ VIDEO_FINISH_URL: "https://video-finish.example" }),
          "VIDEO_FINISH_URL",
          "/finish",
          { method: "POST" },
        ),
      ).rejects.toBeInstanceOf(MediaFinishAuthError);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });
});

function stubFetch() {
  return vi.fn<(url: RequestInfo, init?: RequestInit) => Promise<Response>>(
    async () => new Response("{}", { status: 200 }),
  );
}

function authOf(fetch: ReturnType<typeof stubFetch>): string | undefined {
  const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
  return headers?.authorization;
}

describe("callVideoFinish / callAudioMix / callVideoFinishInspect send the bearer", () => {
  it("callVideoFinish attaches Authorization when the token is set", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await callVideoFinish(
        envWith({
          VIDEO_FINISH_URL: "https://video-finish.example",
          MEDIA_FINISH_TOKEN: "abc",
        }),
        { clips: [], outputUrl: "u", outputKey: "k" },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://video-finish.example/finish");
      expect(authOf(fetch)).toBe("Bearer abc");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callVideoFinish refuses when the URL is set and the token is empty", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await expect(
        callVideoFinish(envWith({ VIDEO_FINISH_URL: "https://video-finish.example" }), {
          clips: [],
          outputUrl: "u",
          outputKey: "k",
        }),
      ).rejects.toBeInstanceOf(MediaFinishAuthError);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("assemble treats a configured door without a token as a hard fail", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const tick = await tickVideoFinishAssemble(
        envWith({ VIDEO_FINISH_URL: "https://video-finish.example" }),
        { clips: [], outputUrl: "u", outputKey: "k" },
        undefined,
      );
      expect(tick.kind).toBe("failed");
      if (tick.kind === "failed") expect(tick.error).toMatch(/MEDIA_FINISH_TOKEN is empty/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callAudioMix attaches Authorization when the token is set", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await callAudioMix(
        envWith({ AUDIO_MIX_URL: "https://audio-mix.test", MEDIA_FINISH_TOKEN: "mix-tok" }),
        { tracks: [], outputUrl: "u", outputKey: "k" },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://audio-mix.test/mix");
      expect(authOf(fetch)).toBe("Bearer mix-tok");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callAudioMix returns null when AUDIO_MIX_URL is unset", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const resp = await callAudioMix(envWith({ MEDIA_FINISH_TOKEN: "mix-tok" }), {
        tracks: [],
        outputUrl: "u",
        outputKey: "k",
      });
      expect(resp).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callVideoFinish ignores a leftover VIDEO_FINISH_VPC Fetcher", async () => {
    const vpc = { fetch: vi.fn(async () => new Response("vpc", { status: 200 })) };
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await callVideoFinish(
        envWith({
          VIDEO_FINISH_URL: "https://video-finish.example",
          VIDEO_FINISH_VPC: vpc,
          MEDIA_FINISH_TOKEN: "abc",
        }),
        { clips: [], outputUrl: "u", outputKey: "k" },
      );
      expect(vpc.fetch).not.toHaveBeenCalled();
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://video-finish.example/finish");
      expect(authOf(fetch)).toBe("Bearer abc");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callVideoFinishInspect attaches Authorization when the token is set", async () => {
    const fetch = vi.fn<(url: RequestInfo, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await callVideoFinishInspect(
        envWith({ VIDEO_FINISH_URL: "https://video-finish.example", MEDIA_FINISH_TOKEN: "ins" }),
        { clipUrl: "https://example/clip.mp4" },
      );
      expect(authOf(fetch)).toBe("Bearer ins");
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("media doors have no default origin", () => {
  it("empty env is unreachable and has no video-finish URL", () => {
    const env = envWith({});
    expect(videoFinishUrl(env)).toBe("");
    expect(videoFinishReachable(env)).toBe(false);
    expect(mediaDoorUrl(env, "VIDEO_FINISH_URL")).toBe("");
    expect(mediaDoorUrl(env, "AUDIO_MIX_URL")).toBe("");
    expect(mediaDoorUrl(env, "AUDIO_BEAT_SYNC_URL")).toBe("");
    expect(mediaDoorUrl(env, "IMAGE_PREP_URL")).toBe("");
  });

  it("reads only the host-set string, stripping a trailing slash", () => {
    expect(videoFinishUrl(envWith({ VIDEO_FINISH_URL: "https://video-finish.test/" }))).toBe(
      "https://video-finish.test",
    );
    expect(mediaDoorUrl(envWith({ AUDIO_MIX_URL: "https://audio-mix.test/" }), "AUDIO_MIX_URL")).toBe(
      "https://audio-mix.test",
    );
  });
});

function mixJob(over: Partial<FilmJob> = {}): FilmJob {
  return {
    dialogue_audio: { shot_01: { audio_key: "dlg.wav" } },
    audio_key: "bed.mp3",
    silent_film_key: "silent.mp4",
    ...over,
  } as FilmJob;
}

describe("shouldMultiTrackMix / callImagePrep / analyzeAudioBeats use host URLs", () => {
  it("shouldMultiTrackMix is false when AUDIO_MIX_URL is unset", () => {
    expect(shouldMultiTrackMix(mixJob(), envWith({}))).toBe(false);
  });

  it("shouldMultiTrackMix is true when AUDIO_MIX_URL is set and the film has both tracks", () => {
    expect(shouldMultiTrackMix(mixJob(), envWith({ AUDIO_MIX_URL: "https://audio-mix.test" }))).toBe(true);
  });

  it("callImagePrep returns null when IMAGE_PREP_URL is unset", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      expect(
        await callImagePrep(envWith({}), {
          inputUrl: "in",
          outputUrl: "out",
          outputKey: "k",
          background: "alpha",
        }),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callImagePrep posts /portrait/prep when IMAGE_PREP_URL is set", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const resp = await callImagePrep(
        envWith({ IMAGE_PREP_URL: "https://image-prep.test", MEDIA_FINISH_TOKEN: "prep-tok" }),
        { inputUrl: "in", outputUrl: "out", outputKey: "k", background: "alpha" },
        { retries: 1 },
      );
      expect(resp?.status).toBe(200);
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://image-prep.test/portrait/prep");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("callImagePrep attaches Authorization when the token is set", async () => {
    const fetch = stubFetch();
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await callImagePrep(
        envWith({ IMAGE_PREP_URL: "https://image-prep.test", MEDIA_FINISH_TOKEN: "prep-tok" }),
        { inputUrl: "in", outputUrl: "out", outputKey: "k", background: "alpha" },
        { retries: 1 },
      );
      expect(authOf(fetch)).toBe("Bearer prep-tok");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("analyzeAudioBeats reports AUDIO_BEAT_SYNC_URL unset when the door is off", async () => {
    const r = await analyzeAudioBeats(
      envWith({ PRESIGNER: { presignGet: async () => "https://r2.test/audio.wav" } }),
      { audioKey: "audio.wav" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("AUDIO_BEAT_SYNC_URL unset");
  });

  it("analyzeAudioBeats fetches AUDIO_BEAT_SYNC_URL /analyze when set", async () => {
    const fetch = vi.fn<(url: RequestInfo, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ mode: "beat", audio_key: "audio.wav" }), { status: 200 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const r = await analyzeAudioBeats(
        envWith({
          AUDIO_BEAT_SYNC_URL: "https://audio-beat-sync.test",
          MEDIA_FINISH_TOKEN: "beat-tok",
          PRESIGNER: { presignGet: async () => "https://r2.test/audio.wav" },
        }),
        { audioKey: "audio.wav" },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.module).toBe("core-url");
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://audio-beat-sync.test/analyze");
    } finally {
      globalThis.fetch = prev;
    }
  });
});
