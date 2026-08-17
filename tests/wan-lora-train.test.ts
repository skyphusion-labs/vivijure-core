import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { CastMember } from "../src/cast-db.js";

// Override only pollCastLoraJob; keep the real submit/payload builders (importOriginal spread).
// vi.hoisted so the mock exists before vi.mock's hoisted factory references it.
const { pollMock } = vi.hoisted(() => ({ pollMock: vi.fn() }));
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return { ...actual, pollCastLoraJob: pollMock };
});

import { refreshTrainingLora } from "../src/cast-lora-train.js";
import {
  buildTrainWanLoraPayload,
  buildTrainLoraPayload,
  submitTrainWanLoraJob,
  clampTrainOverrides,
} from "../src/runpod-submit.js";
import { parseCastTrainBodyFields } from "../src/cast-lora-train.js";

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

const TENANT_R2 = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  access_key_id: "tok-1",
  secret_access_key: "tenant-r2-secret-value-never-log",
  bucket: "vivijure-tenant-hero",
};

function jsonFetchRecording(capture: { body?: unknown }): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "job-w", status: "IN_QUEUE" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("buildTrainWanLoraPayload", () => {
  it("adds model_family:'wan' to the train_lora payload", () => {
    const { input } = buildTrainWanLoraPayload({ project: "p", bundleKey: "bundles/p.tar.gz" });
    expect(input.action).toBe("train_lora");
    expect(input.model_family).toBe("wan");
  });
  it("the SDXL payload carries NO model_family (control)", () => {
    expect(buildTrainLoraPayload({ project: "p", bundleKey: "b" }).input.model_family).toBeUndefined();
  });
  it("puts the tenant r2 block on input.r2 (same four fields as render)", () => {
    const { input } = buildTrainWanLoraPayload({
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      r2: TENANT_R2,
    });
    expect(input.r2).toEqual(TENANT_R2);
    expect(input.r2).not.toBe(TENANT_R2);
  });
  it("omits r2 when not provided (never null on the wire)", () => {
    const { input } = buildTrainWanLoraPayload({ project: "p", bundleKey: "bundles/p.tar.gz" });
    expect("r2" in input).toBe(false);
    const wire = JSON.parse(JSON.stringify({ input })) as { input: Record<string, unknown> };
    expect("r2" in wire.input).toBe(false);
  });
  it("the SDXL payload does not carry r2 even if args include it", () => {
    const { input } = buildTrainLoraPayload({ project: "p", bundleKey: "b", r2: TENANT_R2 });
    expect("r2" in input).toBe(false);
  });

  it("emits train_overrides with only the wan-train allow-list (wan-train#37)", () => {
    const { input } = buildTrainWanLoraPayload({
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      trainOverrides: { batch_size: 2, resolution: 512, steps: 1800 },
    });
    expect(input.train_overrides).toEqual({ batch_size: 2, resolution: 512, steps: 1800 });
  });

  it("drops unknown train_overrides keys so a typo cannot fail a train", () => {
    const { input } = buildTrainWanLoraPayload({
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      trainOverrides: { steps: 800, vivijure_probe_unknown_key: 1, batch_size: "nope" } as never,
    });
    expect(input.train_overrides).toEqual({ steps: 800 });
    expect(input.train_overrides && "vivijure_probe_unknown_key" in input.train_overrides).toBe(false);
  });

  it("omits train_overrides when nothing allowed remains", () => {
    const { input } = buildTrainWanLoraPayload({
      project: "p",
      bundleKey: "bundles/p.tar.gz",
      trainOverrides: { vivijure_probe_unknown_key: 1 } as never,
    });
    expect("train_overrides" in input).toBe(false);
  });

  it("the SDXL payload does not carry train_overrides", () => {
    const { input } = buildTrainLoraPayload({
      project: "p",
      bundleKey: "b",
      trainOverrides: { steps: 800 },
    });
    expect("train_overrides" in input).toBe(false);
  });
});

describe("clampTrainOverrides / parseCastTrainBodyFields (wan-train#37)", () => {
  it("clamp drops non-finite and unknown keys", () => {
    expect(clampTrainOverrides({ steps: 1200, batch_size: Number.NaN, extra: 1 })).toEqual({ steps: 1200 });
    expect(clampTrainOverrides(null)).toBeUndefined();
    expect(clampTrainOverrides({ extra: 1 })).toBeUndefined();
  });

  it("the train route accepts train_overrides and trainOverrides", () => {
    expect(parseCastTrainBodyFields({ train_overrides: { steps: 900 } }, true).trainOverrides)
      .toEqual({ steps: 900 });
    expect(parseCastTrainBodyFields({ trainOverrides: { batch_size: 1 } }, true).trainOverrides)
      .toEqual({ batch_size: 1 });
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

describe("submitTrainWanLoraJob tenant R2", () => {
  it("attaches tenantR2FromEnv onto the RunPod body when R2_S3_* is set", async () => {
    const capture: { body?: unknown } = {};
    const env = {
      RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep",
      RUNPOD_API_KEY: "k",
      R2_S3_ENDPOINT: TENANT_R2.endpoint,
      R2_S3_ACCESS_KEY_ID: TENANT_R2.access_key_id,
      R2_S3_SECRET_ACCESS_KEY: TENANT_R2.secret_access_key,
      R2_S3_BUCKET: TENANT_R2.bucket,
    };
    const res = await submitTrainWanLoraJob(env as unknown as Env, {
      project: "p",
      bundleKey: "bundles/p.tar.gz",
    }, { fetchImpl: jsonFetchRecording(capture) });
    expect(res.ok).toBe(true);
    const body = capture.body as { input: { r2?: typeof TENANT_R2; model_family?: string } };
    expect(body.input.model_family).toBe("wan");
    expect(body.input.r2).toEqual(TENANT_R2);
  });

  it("omits the block when the studio env has no tenant R2 (operator / dedicated EP)", async () => {
    const capture: { body?: unknown } = {};
    const res = await submitTrainWanLoraJob(
      { RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep", RUNPOD_API_KEY: "k" } as unknown as Env,
      { project: "p", bundleKey: "bundles/p.tar.gz" },
      { fetchImpl: jsonFetchRecording(capture) },
    );
    expect(res.ok).toBe(true);
    const body = capture.body as { input: Record<string, unknown> };
    expect("r2" in body.input).toBe(false);
    const wire = JSON.parse(JSON.stringify(body)) as { input: Record<string, unknown> };
    expect("r2" in wire.input).toBe(false);
  });

  it("never logs the tenant secret (console or result envelope)", async () => {
    const capture: { body?: unknown } = {};
    const logs: string[] = [];
    const sink = (...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(sink),
    );
    try {
      const env = {
        RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep",
        RUNPOD_API_KEY: "k",
        R2_S3_ENDPOINT: TENANT_R2.endpoint,
        R2_S3_ACCESS_KEY_ID: TENANT_R2.access_key_id,
        R2_S3_SECRET_ACCESS_KEY: TENANT_R2.secret_access_key,
        R2_S3_BUCKET: TENANT_R2.bucket,
      };
      const res = await submitTrainWanLoraJob(env as unknown as Env, {
        project: "p",
        bundleKey: "bundles/p.tar.gz",
      }, { fetchImpl: jsonFetchRecording(capture) });
      expect(res.ok).toBe(true);
      // The secret MUST travel on the RunPod hop (that is the point of the block)
      // and MUST NOT appear in logs or the returned view.
      expect(JSON.stringify(capture.body)).toContain(TENANT_R2.secret_access_key);
      expect(JSON.stringify(res)).not.toContain(TENANT_R2.secret_access_key);
      expect(logs.join("\n")).not.toContain(TENANT_R2.secret_access_key);
    } finally {
      for (const s of spies) s.mockRestore();
    }
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
