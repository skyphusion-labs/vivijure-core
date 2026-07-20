import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { CastMember } from "../src/cast-db.js";

const { pollMock } = vi.hoisted(() => ({ pollMock: vi.fn() }));
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return { ...actual, pollCastLoraJob: pollMock };
});

import { handleCastLoraStatus } from "../src/cast-lora-train.js";

const HIGH = "loras/lora-wren-1784581417/A/wan_high_noise.safetensors";
const LOW = "loras/lora-wren-1784581417/A/wan_low_noise.safetensors";

function wrenCast(): CastMember {
  return {
    id: 7,
    public_id: "77b5942b-9257-49be-b093-23f700ab0772",
    slug: "wren",
    name: "Wren",
    bible: null,
    portrait_key: "cast/7/portrait.jpg",
    portrait_mime: "image/jpeg",
    ref_keys: [],
    source_keys: [],
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    lora_key: null,
    lora_status: "training",
    lora_job_id: "f64bbe7f-639b-420d-addb-83cb86ebdf40-u2",
    lora_error: null,
    lora_trained_at: null,
    voice_id: null,
    wan_lora_key_high: null,
    wan_lora_key_low: null,
  };
}

function envWithR2(cast: CastMember) {
  const sqls: string[] = [];
  const row = {
    ...cast,
    ref_keys_json: "[]",
    source_keys_json: null,
    lora_status: "ready" as const,
    lora_job_id: null,
    wan_lora_key_high: HIGH,
    wan_lora_key_low: LOW,
  };
  const listMock = vi.fn(async ({ prefix }: { prefix: string }) => {
    expect(prefix).toBe("loras/lora-wren-");
    return {
      objects: [
        { key: HIGH, uploaded: new Date("2026-07-20T18:00:00Z") },
        { key: LOW, uploaded: new Date("2026-07-20T18:00:00Z") },
      ],
      truncated: false,
    };
  });
  const env = {
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (sql.includes("WHERE id = ?") && sql.includes("FROM cast_members")) {
                return {
                  ...cast,
                  ref_keys_json: "[]",
                  source_keys_json: null,
                };
              }
              return row;
            },
          }),
        };
      },
    },
    R2_RENDERS: { list: listMock, head: vi.fn(async () => ({ size: 1 })) },
  };
  return { env: env as unknown as Env, sqls, listMock };
}

beforeEach(() => pollMock.mockReset());

describe("handleCastLoraStatus R2 reconcile (cf#29 backfill)", () => {
  it("writes wan_lora_key_* from R2 when both endpoints 404 but the expert pair exists", async () => {
    pollMock.mockResolvedValue({ ok: false, status: 404, error: "not found" });
    const cast = wrenCast();
    const { env, sqls } = envWithR2(cast);
    const res = await handleCastLoraStatus(env, cast.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reconciledFromR2?: boolean;
      cast: { wan_lora_key_high: string; wan_lora_key_low: string; lora_status: string };
    };
    expect(body.reconciledFromR2).toBe(true);
    expect(body.cast.wan_lora_key_high).toBe(HIGH);
    expect(body.cast.wan_lora_key_low).toBe(LOW);
    expect(body.cast.lora_status).toBe("ready");
    expect(sqls.some((s) => s.includes("wan_lora_key_high = ?"))).toBe(true);
  });
});
