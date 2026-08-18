// cf#475 -- cast LoRA training must write a runpod_job_log row, like every other GPU path.
//
// WHAT MAKES THIS SUITE GO RED. Each recording call site is asserted through the REAL upsert
// statement and its REAL bound arguments, not through a spy on our own helper: a test that asserts
// "recordCastTrainSubmit was called" would still pass if the recorder wrote nothing. The fake
// database captures { sql, args }, and the assertions are on the row that would land.
//
// EVERY ZERO IS PAIRED WITH A CONTROL. The two "records nothing" cases (a local-door train, a
// non-terminal poll) sit next to cases that DO record through the same fake, so an empty capture
// cannot come from a database that was never reachable in the first place.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";

const { submitWanMock, submitSdxlMock, pollMock } = vi.hoisted(() => ({
  submitWanMock: vi.fn(),
  submitSdxlMock: vi.fn(),
  pollMock: vi.fn(),
}));

// Only the three RunPod-touching functions are replaced; the payload builders, the backend tagging
// and everything else stay real (importOriginal spread).
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return {
    ...actual,
    submitTrainWanLoraJob: submitWanMock,
    submitTrainLoraJob: submitSdxlMock,
    pollCastLoraJob: pollMock,
  };
});

vi.mock("../src/bundle-assembler.js", () => ({
  assembleBundle: vi.fn(async () => ({ ok: true, bundleKey: "bundles/p.tar.gz", errors: [] })),
}));

import {
  castTrainJobLogModule,
  CAST_TRAIN_SDXL_JOB_LOG_MODULE,
  CAST_TRAIN_WAN_JOB_LOG_MODULE,
  handleCastLoraStatus,
  handleCastTrainLora,
  handleCastTrainWanLora,
  refreshTrainingLora,
} from "../src/cast-lora-train.js";
import { RUNPOD_JOB_LOG_UPSERT } from "../src/runpod-job-log.js";
import { type RunpodResult } from "../src/runpod-submit.js";
import type { CastMember } from "../src/cast-db.js";

interface Captured {
  sql: string;
  args: unknown[];
}

// Cast row shaped for a train to be ALLOWED: a portrait plus four refs, and not already training.
const TRAINABLE_ROW = {
  id: 7,
  public_id: "cast_p",
  slug: "vera",
  name: "Vera",
  bible: null,
  portrait_key: "cast/7/portrait.jpg",
  portrait_mime: "image/jpeg",
  ref_keys_json: JSON.stringify(
    ["a", "b", "c", "d"].map((k) => ({ key: "cast/7/ref-" + k + ".png", mime: "image/png" })),
  ),
  source_keys_json: null,
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
  lora_key: null,
  lora_status: "idle",
  // Set so handleCastLoraStatus has a job to poll. Harmless to the submit path, which gates on
  // lora_status === 'training' and not on the presence of an id.
  lora_job_id: "job-wan-1",
  lora_error: null,
  lora_trained_at: null,
  voice_id: null, voice_ref_key: null,
  wan_lora_key_high: null,
  wan_lora_key_low: null,
};

function capturingEnv(extra: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          captured.push({ sql, args });
          return {
            first: async () => TRAINABLE_ROW,
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
          };
        },
        first: async () => TRAINABLE_ROW,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    },
    R2_RENDERS: { list: async () => ({ objects: [], truncated: false }), head: async () => null },
    ...extra,
  };
  return { env: env as unknown as Env, captured };
}

/** Every job-log row this call would land. Keyed on the REAL upsert statement. */
function jobLogRows(captured: Captured[]): unknown[][] {
  return captured.filter((c) => c.sql === RUNPOD_JOB_LOG_UPSERT).map((c) => c.args);
}

function trainingCast(): CastMember {
  return {
    id: 7,
    public_id: "cast_p",
    slug: "vera",
    name: "Vera",
    bible: null,
    portrait_key: "cast/7/portrait.jpg",
    portrait_mime: "image/jpeg",
    ref_keys: ["a", "b", "c", "d"].map((k) => ({ key: "cast/7/ref-" + k + ".png", mime: "image/png" })),
    source_keys: [],
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    lora_key: null,
    lora_status: "training",
    lora_job_id: "job-wan-1",
    lora_error: null,
    lora_trained_at: null,
    voice_id: null, voice_ref_key: null,
    wan_lora_key_high: null,
    wan_lora_key_low: null,
  };
}

const req = () => new Request("https://studio.test/api/cast/7/train-wan-lora", { method: "POST" });

beforeEach(() => {
  submitWanMock.mockReset();
  submitSdxlMock.mockReset();
  pollMock.mockReset();
});

// -------------------------------------------------------------------------------------------------
// The submit write. THIS is the row whose absence made a fifth of GPU spend invisible.
// -------------------------------------------------------------------------------------------------
describe("cf#475 a cast-train submit opens a runpod_job_log row", () => {
  it("a Wan train records module=cast-train-wan, outcome=submitted, terminal_at NULL", async () => {
    submitWanMock.mockResolvedValue({
      ok: true,
      view: { jobId: "job-wan-1", status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep" });

    const res = await handleCastTrainWanLora(req(), env, 7);
    expect(res.status).toBe(200);

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    const [jobId, moduleLabel, outcome, detail, submittedAt, terminalAt] = rows[0];
    expect(jobId).toBe("job-wan-1");
    expect(moduleLabel).toBe(CAST_TRAIN_WAN_JOB_LOG_MODULE);
    expect(outcome).toBe("submitted");
    expect(detail).toBeNull();
    expect(typeof submittedAt).toBe("number");
    expect(terminalAt).toBeNull();
  });

  it("a cloud SDXL train records module=cast-train-sdxl (the label follows the endpoint)", async () => {
    submitSdxlMock.mockResolvedValue({
      ok: true,
      view: { jobId: "job-sdxl-1", status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
      backend: "runpod-render",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    const res = await handleCastTrainLora(req(), env, 7);
    expect(res.status).toBe(200);

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe(CAST_TRAIN_SDXL_JOB_LOG_MODULE);
  });

  it("a LOCAL-DOOR train records NOTHING (own iron is not RunPod spend)", async () => {
    submitSdxlMock.mockResolvedValue({
      ok: true,
      view: { jobId: "job-door-1", status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
      backend: "local-door",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    const res = await handleCastTrainLora(req(), env, 7);
    // CONTROL on the zero: the call SUCCEEDED and the fake database WAS reached (setLoraJob ran),
    // so an empty job-log capture is the guard working, not a database that was never touched.
    expect(res.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    expect(jobLogRows(captured)).toHaveLength(0);
  });

  it("a FAILED submit records nothing: no job id means nothing was billed and nothing to key on", async () => {
    submitSdxlMock.mockResolvedValue({ ok: false, error: "boom" } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    const res = await handleCastTrainLora(req(), env, 7);
    expect(res.status).toBe(502);
    expect(jobLogRows(captured)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// The terminal write. This is what makes the seconds ATTRIBUTABLE rather than merely counted.
// -------------------------------------------------------------------------------------------------
describe("cf#475 an observed terminal poll closes the row with RunPod's own timing", () => {
  it("COMPLETED writes outcome=completed with execution_ms and delay_ms from the envelope", async () => {
    pollMock.mockResolvedValue({
      ok: true,
      view: {
        jobId: "job-wan-1",
        status: "COMPLETED",
        statusRaw: "COMPLETED",
        output: { lora_key_high: "loras/h.safetensors", lora_key_low: "loras/l.safetensors" },
        executionTimeMs: 6_312_000,
        delayTimeMs: 41_000,
      },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    await refreshTrainingLora(env, trainingCast());

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    const [jobId, moduleLabel, outcome, , , terminalAt, , executionMs, delayMs] = rows[0];
    expect(jobId).toBe("job-wan-1");
    expect(moduleLabel).toBe(CAST_TRAIN_WAN_JOB_LOG_MODULE);
    expect(outcome).toBe("completed");
    expect(typeof terminalAt).toBe("number");
    expect(executionMs).toBe(6_312_000);
    expect(delayMs).toBe(41_000);
  });

  it("FAILED writes outcome=failed and carries the backend error text", async () => {
    pollMock.mockResolvedValue({
      ok: true,
      view: {
        jobId: "job-wan-1",
        status: "FAILED",
        statusRaw: "FAILED",
        error: "{\"error_type\": \"<class 'vivijure_backend.harness.handler.HarnessError'>\"}",
      },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    await refreshTrainingLora(env, trainingCast());

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe("failed");
    expect(String(rows[0][3])).toContain("error_type");
    expect(rows[0][6]).toBe("HarnessError");
  });

  it("TIMED_OUT is terminal and is recorded, rather than walked past as still-running", async () => {
    pollMock.mockResolvedValue({
      ok: true,
      view: { jobId: "job-wan-1", status: "TIMED_OUT", statusRaw: "TIMED_OUT" },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    await refreshTrainingLora(env, trainingCast());

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe("failed");
  });

  it("a NON-terminal poll writes no terminal row (control: the same fake DB records above)", async () => {
    pollMock.mockResolvedValue({
      ok: true,
      view: { jobId: "job-wan-1", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    await refreshTrainingLora(env, trainingCast());

    expect(jobLogRows(captured)).toHaveLength(0);
  });

  // THE SECOND POLL PATH. refreshTrainingLora and handleCastLoraStatus each observe terminal states
  // independently, and either one alone leaves the other silent. Without this case the mutation
  // verdict on the handleCastLoraStatus call site is rc=0 UNCOVERED, which reads exactly like a
  // recorder that is not needed there.
  it("the operator status route records its own terminal observation, not only refreshTrainingLora", async () => {
    pollMock.mockResolvedValue({
      ok: true,
      view: {
        jobId: "job-wan-1",
        status: "COMPLETED",
        statusRaw: "COMPLETED",
        output: { lora_key_high: "loras/h.safetensors", lora_key_low: "loras/l.safetensors" },
        executionTimeMs: 5_000,
        delayTimeMs: 10,
      },
      backend: "runpod-wan-train",
    } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    const res = await handleCastLoraStatus(env, 7);
    expect(res.status).toBe(200);

    const rows = jobLogRows(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe("completed");
    expect(rows[0][7]).toBe(5_000);
  });

  it("a poll that could not read a status writes nothing (we observed no outcome)", async () => {
    pollMock.mockResolvedValue({ ok: false, error: "transport", status: 500 } satisfies RunpodResult);
    const { env, captured } = capturingEnv();

    await refreshTrainingLora(env, trainingCast());

    expect(jobLogRows(captured)).toHaveLength(0);
  });
});
