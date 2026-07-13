import { describe, expect, it } from "vitest";
import {
  canonicalClipKeyframeKey,
  ensureClipKeyframeInR2,
  isRendersKeyframeKey,
} from "../src/stage-clip-keyframe.js";
import type { Env } from "../src/platform/orchestrator-context.js";

describe("stage-clip-keyframe", () => {
  it("canonicalClipKeyframeKey matches prod layout", () => {
    expect(canonicalClipKeyframeKey("the_upright_cat-1947f0aa09229646", "shot_01")).toBe(
      "renders/the_upright_cat-1947f0aa09229646/keyframes/shot_01.png",
    );
  });

  it("isRendersKeyframeKey accepts renders/.../keyframes/*.png only", () => {
    expect(isRendersKeyframeKey("renders/p/keyframes/shot_01.png")).toBe(true);
    expect(isRendersKeyframeKey("uploads/foo.jpg")).toBe(false);
  });

  it("copies uploads/ bytes into renders/<project>/keyframes/<shot>.png", async () => {
    const uploadKey = "uploads/smoke-test.jpg";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const stored = new Map<string, { body: Uint8Array; contentType?: string }>();
    stored.set(uploadKey, { body: bytes, contentType: "image/jpeg" });

    const env = {
      R2_RENDERS: {
        get: async (k: string) => {
          const hit = stored.get(k);
          if (!hit) return null;
          return {
            arrayBuffer: async () => hit.body.buffer.slice(hit.body.byteOffset, hit.body.byteOffset + hit.body.byteLength),
            httpMetadata: { contentType: hit.contentType },
          };
        },
        head: async (k: string) => (stored.has(k) ? {} : null),
        put: async (k: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
          const b = body instanceof Uint8Array ? body : new Uint8Array(body);
          stored.set(k, { body: b, contentType: opts?.httpMetadata?.contentType });
        },
      },
      PRESIGNER: {
        presignGet: async (key: string) => `https://bucket.example/${key}?sig=1`,
        presignPut: async () => "https://bucket.example/put",
      },
    } as unknown as Env;

    const out = await ensureClipKeyframeInR2(env, "exhaustive_own_gpu", {
      shot_id: "shot_01",
      keyframe_url: "https://ignored",
      keyframe_key: uploadKey,
      prompt: "x",
      seconds: 4,
    });

    const canonical = canonicalClipKeyframeKey("exhaustive_own_gpu", "shot_01");
    expect(out.keyframe_key).toBe(canonical);
    expect(stored.has(canonical)).toBe(true);
    expect(out.keyframe_url).toContain(canonical);
  });
});
