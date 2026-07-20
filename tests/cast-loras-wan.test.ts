import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { CastMember } from "../src/cast-db.js";

// Mock the cast-db lookups + the training refresh so resolveCastLoras runs without a real D1.
const { getCastByIdMock, getCastIdByPublicIdMock } = vi.hoisted(() => ({
  getCastByIdMock: vi.fn(),
  getCastIdByPublicIdMock: vi.fn(),
}));
vi.mock("../src/cast-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cast-db.js")>();
  return { ...actual, getCastById: getCastByIdMock, getCastIdByPublicId: getCastIdByPublicIdMock };
});
vi.mock("../src/cast-lora-train.js", () => ({ refreshTrainingLora: async (_e: unknown, c: unknown) => c }));

import { resolveCastLoras } from "../src/cast-loras.js";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"; // a valid public id (passes isPublicId)

function readyCast(over: Partial<CastMember>): CastMember {
  return {
    id: 7, public_id: UUID, slug: "s", name: "Vesper", bible: null,
    portrait_key: "cast/7/p.jpg", portrait_mime: "image/jpeg", ref_keys: [], source_keys: [],
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
    lora_key: null, lora_status: "ready", lora_job_id: null, lora_error: null,
    lora_trained_at: null, voice_id: null, wan_lora_key_high: null, wan_lora_key_low: null,
    ...over,
  };
}

beforeEach(() => {
  getCastIdByPublicIdMock.mockReset().mockResolvedValue(7);
  getCastByIdMock.mockReset();
});

describe("resolveCastLoras family disjointness (cross-wire control)", () => {
  it("a Wan-ready cast lands ONLY in wanPretrained, NEVER in pretrained", async () => {
    getCastByIdMock.mockResolvedValue(readyCast({
      wan_lora_key_high: "loras/cast-7/h.safetensors",
      wan_lora_key_low: "loras/cast-7/l.safetensors",
    }));
    const r = await resolveCastLoras({} as Env, { A: UUID });
    expect(r.wanPretrained.A).toEqual({ high: "loras/cast-7/h.safetensors", low: "loras/cast-7/l.safetensors" });
    expect(r.pretrained.A).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  it("an SDXL-ready cast lands ONLY in pretrained, NEVER in wanPretrained", async () => {
    getCastByIdMock.mockResolvedValue(readyCast({ lora_key: "loras/cast-7/one.safetensors" }));
    const r = await resolveCastLoras({} as Env, { A: UUID });
    expect(r.pretrained.A).toBe("loras/cast-7/one.safetensors");
    expect(r.wanPretrained.A).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  it("SDXL wins if a row somehow carries both (never double-projected)", async () => {
    getCastByIdMock.mockResolvedValue(readyCast({
      lora_key: "loras/cast-7/one.safetensors",
      wan_lora_key_high: "loras/cast-7/h.safetensors",
      wan_lora_key_low: "loras/cast-7/l.safetensors",
    }));
    const r = await resolveCastLoras({} as Env, { A: UUID });
    expect(r.pretrained.A).toBe("loras/cast-7/one.safetensors");
    expect(r.wanPretrained.A).toBeUndefined();
  });

  it("a ready cast with NEITHER key (or only one wan expert) is skipped, not resolved", async () => {
    getCastByIdMock.mockResolvedValue(readyCast({ wan_lora_key_high: "loras/cast-7/h.safetensors" })); // low missing
    const r = await resolveCastLoras({} as Env, { A: UUID });
    expect(r.pretrained.A).toBeUndefined();
    expect(r.wanPretrained.A).toBeUndefined();
    expect(r.skipped).toContain("A");
    expect(r.skippedDetail[0].reason).toBe("no trained LoRA");
  });
});
