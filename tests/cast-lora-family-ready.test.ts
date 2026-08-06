import { describe, expect, it } from "vitest";
import {
  isSdxlLoraReady,
  isWanLoraReady,
  toPublicCast,
  type CastMember,
} from "../src/cast-db.js";

// cf#383: lora_status alone cannot express two adapter families. Public cast rows expose
// sdxl_lora_ready / wan_lora_ready derived from key presence so a caller never binds a
// "ready" character that has no SDXL identity LoRA (or no Wan pair).

function baseCast(over: Partial<CastMember> = {}): CastMember {
  return {
    id: 7,
    public_id: "7b899c7a-4209-4a98-9295-e35ef75f0aec",
    slug: "strummer-cf278-vale",
    name: "Strummer CF278 Vale",
    bible: null,
    portrait_key: "cast/7/p.jpg",
    portrait_mime: "image/jpeg",
    ref_keys: [],
    source_keys: [],
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    lora_key: null,
    lora_status: "ready",
    lora_job_id: null,
    lora_error: null,
    lora_trained_at: "2026-01-01 00:00:00",
    voice_id: null,
    wan_lora_key_high: null,
    wan_lora_key_low: null,
    ...over,
  };
}

describe("isSdxlLoraReady / isWanLoraReady (key-presence)", () => {
  it("sdxl ready only when lora_key is under loras/", () => {
    expect(isSdxlLoraReady(baseCast())).toBe(false);
    expect(isSdxlLoraReady(baseCast({ lora_key: "not-loras/x.safetensors" }))).toBe(false);
    expect(isSdxlLoraReady(baseCast({ lora_key: "loras/cast-7/one.safetensors" }))).toBe(true);
  });

  it("wan ready only when BOTH experts are under loras/", () => {
    expect(isWanLoraReady(baseCast())).toBe(false);
    expect(
      isWanLoraReady(
        baseCast({ wan_lora_key_high: "loras/cast-7/h.safetensors" }),
      ),
    ).toBe(false);
    expect(
      isWanLoraReady(
        baseCast({
          wan_lora_key_high: "loras/cast-7/h.safetensors",
          wan_lora_key_low: "other/l.safetensors",
        }),
      ),
    ).toBe(false);
    expect(
      isWanLoraReady(
        baseCast({
          wan_lora_key_high: "loras/cast-7/h.safetensors",
          wan_lora_key_low: "loras/cast-7/l.safetensors",
        }),
      ),
    ).toBe(true);
  });
});

describe("toPublicCast additive family readiness (cf#383)", () => {
  it("Wan-only ready row: lora_status ready, sdxl false, wan true (the live Vale shape)", () => {
    const pub = toPublicCast(
      baseCast({
        lora_status: "ready",
        lora_key: null,
        wan_lora_key_high:
          "loras/lora-strummer-cf278-vale-1785586586/A/wan_high_noise.safetensors",
        wan_lora_key_low:
          "loras/lora-strummer-cf278-vale-1785586586/A/wan_low_noise.safetensors",
      }),
    );
    expect(pub.id).toBe("7b899c7a-4209-4a98-9295-e35ef75f0aec");
    expect(pub.lora_status).toBe("ready"); // legacy field retained
    expect(pub.sdxl_lora_ready).toBe(false);
    expect(pub.wan_lora_ready).toBe(true);
    expect(pub.lora_key).toBeNull();
  });

  it("SDXL-only ready row: sdxl true, wan false", () => {
    const pub = toPublicCast(
      baseCast({
        lora_status: "ready",
        lora_key: "loras/cast-7/one.safetensors",
      }),
    );
    expect(pub.sdxl_lora_ready).toBe(true);
    expect(pub.wan_lora_ready).toBe(false);
  });

  it("both families present (Mara shape): both ready booleans true", () => {
    const pub = toPublicCast(
      baseCast({
        lora_status: "ready",
        lora_key: "loras/cast-mara/one.safetensors",
        wan_lora_key_high: "loras/cast-mara/h.safetensors",
        wan_lora_key_low: "loras/cast-mara/l.safetensors",
        voice_id: "athena",
      }),
    );
    expect(pub.sdxl_lora_ready).toBe(true);
    expect(pub.wan_lora_ready).toBe(true);
    expect(pub.voice_id).toBe("athena");
  });

  it("idle / keyless: both ready booleans false regardless of lora_status", () => {
    const idle = toPublicCast(baseCast({ lora_status: "idle" }));
    expect(idle.sdxl_lora_ready).toBe(false);
    expect(idle.wan_lora_ready).toBe(false);

    // Status ready with no keys must not claim either family (defensive)
    const readyKeyless = toPublicCast(baseCast({ lora_status: "ready" }));
    expect(readyKeyless.sdxl_lora_ready).toBe(false);
    expect(readyKeyless.wan_lora_ready).toBe(false);
  });

  it("does not expose the internal integer id", () => {
    const pub = toPublicCast(baseCast());
    expect(pub).not.toHaveProperty("public_id");
    expect(typeof pub.id).toBe("string");
    expect((pub as { id: unknown }).id).not.toBe(7);
  });
});
