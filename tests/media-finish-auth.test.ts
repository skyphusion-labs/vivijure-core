import { describe, expect, it, vi } from "vitest";
import { mediaFinishHeaders, mediaFinishToken } from "../src/media-finish-auth.js";
import { callAudioMix, callVideoFinish } from "../src/film-orchestrator.js";
import { callVideoFinishInspect } from "../src/clip-content-validate.js";
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
  it("omits Authorization when no token is bound", async () => {
    expect(await mediaFinishHeaders(envWith({}))).toEqual({ "content-type": "application/json" });
  });

  it("adds Bearer when a token is bound", async () => {
    expect(await mediaFinishHeaders(envWith({ MEDIA_FINISH_TOKEN: "abc" }))).toEqual({
      "content-type": "application/json",
      authorization: "Bearer abc",
    });
  });
});

describe("callVideoFinish / callAudioMix / callVideoFinishInspect send the bearer", () => {
  it("callVideoFinish attaches Authorization when the token is set", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await callVideoFinish(
      envWith({
        VIDEO_FINISH_VPC: { fetch },
        MEDIA_FINISH_TOKEN: "abc",
      }),
      { clips: [], outputUrl: "u", outputKey: "k" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer abc");
  });

  it("callVideoFinish sends no Authorization when the token is unset", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await callVideoFinish(envWith({ VIDEO_FINISH_VPC: { fetch } }), {
      clips: [],
      outputUrl: "u",
      outputKey: "k",
    });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("callAudioMix attaches Authorization when the token is set", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await callAudioMix(
      envWith({ AUDIO_MIX_VPC: { fetch }, MEDIA_FINISH_TOKEN: "mix-tok" }),
      { tracks: [], outputUrl: "u", outputKey: "k" },
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer mix-tok");
  });

  it("callVideoFinishInspect attaches Authorization when the token is set", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await callVideoFinishInspect(
      envWith({ VIDEO_FINISH_VPC: { fetch }, MEDIA_FINISH_TOKEN: "ins" }),
      { clipUrl: "https://example/clip.mp4" },
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ins");
  });
});
