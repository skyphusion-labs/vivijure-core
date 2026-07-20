import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { CastMember } from "../src/cast-db.js";

// Override only pollRenderJob; keep the real submit/payload builders (importOriginal spread).
// vi.hoisted so the mock exists before vi.mock's hoisted factory references it.
const { pollMock } = vi.hoisted(() => ({ pollMock: vi.fn() }));
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return { ...actual, pollRenderJob: pollMock };
});

import { refreshTrainingLora } from "../src/cast-lora-train.js";
import {
  buildTrainWanLoraPayload,
  buildTrainLoraPayload,
  submitTrainWanLoraJob,
} from "../src/runpod-submit.js";

// A fake D1 that RECORDS the SQL each mark* helper runs, so we can assert WHICH terminal write the
// shape-dispatch chose without a real database. first() returns a valid CastRow so rowToCast works.
function recordingEnv() {
  const sqls: string[] = [];
  const FAKE_ROW = {
    id: 1, public_id: "p", slug: "s", name: "n", bible: null,
    portrait_key: null, portrait_mime: null, ref_keys_json: "[]", source_keys_json: null,
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
    lora_key: null, lora_status: "ready", lora_job_id: null, lora_error: null,
    lora_trained_at: null, voice_id: null, wan_lora_key_high: null, wan_lora_key_low: null,
  };
  const env = {
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        return { bind: () => ({ first: async () => FAKE_ROW, run: async () => ({}) }) };
      },
    },
  };
  return { env: env as unknown as Env, sqls };
}

function trainingCast(): CastMember {
  return {
    id: 1, public_id: "p", slug: "s", name: "n", bible: null,
    portrait_key: "cast/1/portrait.jpg", portrait_mime: "image/jpeg",
    ref_keys: [], source_keys: [],
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
    lora_key: null, lora_status: "training", lora_job_id: "job-1", lora_error: null,
    lora_trained_at: null, voice_id: null,
    wan_lora_key_high: null, wan_lora_key_low: null,
  };
}

function completedWith(output: unknown) {
  return { ok: true, view: { jobId: "job-1", status: "COMPLETED", statusRaw: "COMPLETED", output } };
}

beforeEach(() => pollMock.mockReset());

describe("buildTrainWanLoraPayload", () => {
  it("adds model_family:'wan' to the train_lora payload", () => {
    const { input } = buildTrainWanLoraPayload({ project: "p", bundleKey: "bundles/p.tar.gz" });
    expect(input.action).toBe("train_lora");
    expect(input.model_family).toBe("wan");
  });
  it("the SDXL payload carries NO model_family (control)", () => {
    expect(buildTrainLoraPayload({ project: "p", bundleKey: "b" }).input.model_family).toBeUndefined();
  });
});

describe("submitTrainWanLoraJob endpoint binding", () => {
  it("fails closed on a missing RUNPOD_WAN_TRAIN_ENDPOINT_ID (does not fall back to the render endpoint)", async () => {
    const res = await submitTrainWanLoraJob({ RUNPOD_ENDPOINT_ID: "render-ep" } as unknown as Env, {
      project: "p", bundleKey: "bundles/p.tar.gz",
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("RUNPOD_WAN_TRAIN_ENDPOINT_ID");
  });
});

describe("refreshTrainingLora shape-dispatch on COMPLETED (all three branches)", () => {
  it("wan two-expert envelope -> markWanLoraReady (writes both wan keys)", async () => {
    pollMock.mockResolvedValue(
      completedWith({ lora: { A: { lora_id_high: "loras/cast-1/h.safetensors", lora_id_low: "loras/cast-1/l.safetensors", family: "wan" } } }),
    );
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast());
    expect(sqls.some((s) => s.includes("wan_lora_key_high = ?"))).toBe(true);
    expect(sqls.some((s) => s.includes("lora_status = 'failed'"))).toBe(false);
  });

  it("sdxl single-file envelope -> markLoraReady (writes lora_key, not wan)", async () => {
    pollMock.mockResolvedValue(completedWith({ lora: { A: { lora_id: "loras/cast-1/one.safetensors" } } }));
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast());
    expect(sqls.some((s) => s.includes("lora_key = ?"))).toBe(true);
    expect(sqls.some((s) => s.includes("wan_lora_key_high = ?"))).toBe(false);
    expect(sqls.some((s) => s.includes("lora_status = 'failed'"))).toBe(false);
  });

  it("COMPLETED but NEITHER shape -> markLoraFailed (never marks ready with null keys)", async () => {
    pollMock.mockResolvedValue(completedWith({ project: "p" })); // no lora at all
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast());
    expect(sqls.some((s) => s.includes("lora_status = 'failed'"))).toBe(true);
    expect(sqls.some((s) => s.includes("wan_lora_key_high = ?"))).toBe(false);
    expect(sqls.some((s) => s.includes("lora_key = ?"))).toBe(false);
  });

  it("a partial wan result (only high) does NOT mark ready -- falls through to failure", async () => {
    pollMock.mockResolvedValue(completedWith({ lora: { A: { lora_id_high: "loras/cast-1/h.safetensors" } } }));
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast());
    expect(sqls.some((s) => s.includes("wan_lora_key_high = ?"))).toBe(false);
    expect(sqls.some((s) => s.includes("lora_status = 'failed'"))).toBe(true);
  });
});
