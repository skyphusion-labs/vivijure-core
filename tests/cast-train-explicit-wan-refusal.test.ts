import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";

// core#174, the END-TO-END half. The resolver fix is only correct if the refusal it defers to
// actually fires, and NOTHING in this suite had ever driven handleCastTrainLora or observed a 501
// (measured: zero hits for `handleCastTrainLora` across tests/, against a control that finds
// `refreshTrainingLora`). A fix justified by naming another control needs that control measured,
// not described -- so these tests exercise the whole path: panel body -> parse -> resolve ->
// executeCastTrain -> refusal.
//
// The consent defect this closes: on a host with no Wan endpoint, POST /train-lora with
// model_family "wan" used to return 200 having trained SDXL. It now returns 501 and trains nothing.

const { submitSdxlMock, submitWanMock } = vi.hoisted(() => ({
  submitSdxlMock: vi.fn(),
  submitWanMock: vi.fn(),
}));
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return { ...actual, submitTrainLoraJob: submitSdxlMock, submitTrainWanLoraJob: submitWanMock };
});

const { getCastByIdMock } = vi.hoisted(() => ({ getCastByIdMock: vi.fn() }));
vi.mock("../src/cast-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cast-db.js")>();
  return {
    ...actual,
    getCastById: getCastByIdMock,
    setLoraJob: vi.fn(async () => null),
  };
});

vi.mock("../src/bundle-assembler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bundle-assembler.js")>();
  return {
    ...actual,
    // Bundle assembly runs BEFORE the family refusal in executeCastTrain, so it must succeed for
    // the test to reach the branch under test at all.
    assembleBundle: vi.fn(async () => ({ ok: true, bundleKey: "bundles/test.zip", errors: [] })),
  };
});

import { handleCastTrainLora } from "../src/cast-lora-train.js";

function trainableCast() {
  return {
    id: 1, public_id: "p", slug: "s", name: "n", bible: null,
    portrait_key: "cast/1/portrait.jpg", portrait_mime: "image/jpeg",
    ref_keys: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"], source_keys: [],
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
    lora_key: null, lora_status: "idle", lora_job_id: null, lora_error: null,
    lora_trained_at: null, voice_id: null,
    wan_lora_key_high: null, wan_lora_key_low: null,
  };
}

function trainRequest(body: unknown): Request {
  return new Request("https://example.invalid/api/cast/1/train-lora", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// No RUNPOD_WAN_TRAIN_ENDPOINT_ID binding => wanTrainEndpointConfigured() is false.
const UNWIRED = {} as unknown as Env;
const WIRED = { RUNPOD_WAN_TRAIN_ENDPOINT_ID: "8kjcn5sz6k8p1n" } as unknown as Env;

beforeEach(() => {
  submitSdxlMock.mockReset();
  submitWanMock.mockReset();
  getCastByIdMock.mockReset();
  getCastByIdMock.mockResolvedValue(trainableCast());
  submitWanMock.mockResolvedValue({
    ok: true,
    view: { jobId: "job-wan", status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
  });
  submitSdxlMock.mockResolvedValue({
    ok: true,
    view: { jobId: "job-sdxl", status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
  });
});

describe("POST /train-lora with an explicit wan family on an UNWIRED host (core#174)", () => {
  it("REFUSES with 501 and names the missing binding, instead of returning 200 for an SDXL job", async () => {
    const res = await handleCastTrainLora(trainRequest({ model_family: "wan" }), UNWIRED, 1);
    // Assert WHICH refusal fired, not merely that something failed (a bare non-200 would also be
    // produced by cast-not-found, the 409, the ref-count 400 and two 500s on this path).
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Wan cast LoRA training is not configured on this host");
    expect(body.error).toContain("RUNPOD_WAN_TRAIN_ENDPOINT_ID");
  });

  it("submits NOTHING -- neither a Wan job nor the substituted SDXL job", async () => {
    // This is the assertion that distinguishes "refused" from "refused after doing the work",
    // and it is the one that would have caught the original defect: before the fix this request
    // called submitTrainLoraJob and returned 200.
    await handleCastTrainLora(trainRequest({ model_family: "wan" }), UNWIRED, 1);
    expect(submitWanMock).not.toHaveBeenCalled();
    expect(submitSdxlMock).not.toHaveBeenCalled();
  });

  it("refuses identically when the family arrives via renderOverrides", async () => {
    const res = await handleCastTrainLora(
      trainRequest({ renderOverrides: { model_family: "wan" } }),
      UNWIRED,
      1,
    );
    expect(res.status).toBe(501);
    expect(submitSdxlMock).not.toHaveBeenCalled();
  });
});

describe("the refusal is NARROW -- sibling-green controls (core#174)", () => {
  // Each of these must stay green through the core#174 change. If a mutation reddens these AND
  // the 501 tests above, it has broken training generally rather than fixed the substitution.
  it("an explicit SDXL request on an unwired host still trains SDXL and returns 200", async () => {
    const res = await handleCastTrainLora(trainRequest({ model_family: "sdxl" }), UNWIRED, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, modelFamily: "sdxl" });
    expect(submitSdxlMock).toHaveBeenCalledTimes(1);
    expect(submitWanMock).not.toHaveBeenCalled();
  });

  it("NO family on an unwired host still defaults to SDXL and returns 200", async () => {
    // The default path is untouched: a caller who expressed no preference still gets the
    // host-appropriate family, silently and correctly.
    const res = await handleCastTrainLora(trainRequest({}), UNWIRED, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, modelFamily: "sdxl" });
    expect(submitSdxlMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit wan request on a WIRED host trains Wan and returns 200", async () => {
    const res = await handleCastTrainLora(trainRequest({ model_family: "wan" }), WIRED, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, modelFamily: "wan" });
    expect(submitWanMock).toHaveBeenCalledTimes(1);
    expect(submitSdxlMock).not.toHaveBeenCalled();
  });
});
