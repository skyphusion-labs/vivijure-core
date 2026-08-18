// local#92 (vivijure-core): the stuck-training reconciler must not false-fail an OBSERVED-running Wan
// train. decideStuckTraining splits by observability -- an observed non-terminal poll gets a 3h
// ceiling (covers the RunPod 2h endpoint timeout + margin); an unobservable poll keeps the SDXL-era
// 1h backstop for a vanished job.
import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { CastMember } from "../src/cast-db.js";

const { pollMock } = vi.hoisted(() => ({ pollMock: vi.fn() }));
vi.mock("../src/runpod-submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runpod-submit.js")>();
  return { ...actual, pollCastLoraJob: pollMock };
});

import {
  decideStuckTraining,
  refreshTrainingLora,
  LORA_TRAIN_MAX_AGE_SECONDS,
  LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS,
  LORA_TRAIN_404_GRACE_SECONDS,
} from "../src/cast-lora-train.js";

describe("decideStuckTraining observability split (#92)", () => {
  it("OBSERVED non-terminal (poll.ok) does NOT age-fail at the old 1h ceiling", () => {
    // acceptance row 1: IN_PROGRESS at T+61min stays training
    expect(decideStuckTraining({ ok: true }, 61 * 60).reconcile).toBe(false);
    expect(decideStuckTraining({ ok: true }, LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS - 1).reconcile).toBe(false);
  });

  it("OBSERVED non-terminal DOES fail past the 3h ceiling (positive control: the ceiling exists)", () => {
    expect(decideStuckTraining({ ok: true }, LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS).reconcile).toBe(true);
  });

  it("UNOBSERVABLE (transport error) keeps the 1h backstop -- the contrast that proves the split", () => {
    // same T+61min age as the observed case above, but unobserved => still reconciles (vanished job)
    expect(decideStuckTraining({ ok: false }, 61 * 60).reconcile).toBe(true);
    expect(decideStuckTraining({ ok: false }, LORA_TRAIN_MAX_AGE_SECONDS - 1).reconcile).toBe(false);
  });

  it("404 past grace reconciles exactly as today (acceptance row 2); within grace does not", () => {
    expect(decideStuckTraining({ ok: false, status: 404 }, LORA_TRAIN_404_GRACE_SECONDS + 1).reconcile).toBe(true);
    expect(decideStuckTraining({ ok: false, status: 404 }, LORA_TRAIN_404_GRACE_SECONDS - 1).reconcile).toBe(false);
  });

  it("unknown age never reconciles (cannot establish age => never false-fail)", () => {
    expect(decideStuckTraining({ ok: true }, null).reconcile).toBe(false);
    expect(decideStuckTraining({ ok: false, status: 404 }, null).reconcile).toBe(false);
  });

  it("the observed ceiling covers the RunPod 2h endpoint timeout plus margin", () => {
    expect(LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS).toBe(3 * 3600);
    expect(LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS).toBeGreaterThan(2 * 3600);
    expect(LORA_TRAIN_MAX_AGE_SECONDS).toBe(3600);
  });
});

// A fake D1 that RECORDS each SQL so we can assert WHICH terminal write (if any) ran, no real database.
function recordingEnv() {
  const sqls: string[] = [];
  const FAKE_ROW = {
    id: 1, public_id: "p", slug: "s", name: "n", bible: null,
    portrait_key: null, portrait_mime: null, ref_keys_json: "[]", source_keys_json: null,
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
    lora_key: null, lora_status: "training", lora_job_id: "job-1", lora_error: null,
    lora_trained_at: null, voice_id: null, voice_ref_key: null, wan_lora_key_high: null, wan_lora_key_low: null,
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
    lora_trained_at: null, voice_id: null, voice_ref_key: null, wan_lora_key_high: null, wan_lora_key_low: null,
  };
}

const BASE_MS = Date.parse("2026-01-01T00:00:00Z"); // trainingCast.updated_at as epoch ms
const markedFailed = (sqls: string[]) => sqls.some((s) => s.includes("lora_status") && s.includes("failed"));

describe("refreshTrainingLora: an actively-training row survives past T+60min (#92)", () => {
  it("observed IN_PROGRESS at T+61min -> NOT marked failed (row stays training, harvests later)", async () => {
    pollMock.mockResolvedValue({ ok: true, view: { jobId: "job-1", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" } });
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast(), BASE_MS + 61 * 60 * 1000);
    expect(markedFailed(sqls)).toBe(false);
  });

  it("positive control: observed IN_PROGRESS past 3h -> marked failed (the ceiling still fires)", async () => {
    pollMock.mockResolvedValue({ ok: true, view: { jobId: "job-1", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" } });
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast(), BASE_MS + (3 * 3600 + 60) * 1000);
    expect(markedFailed(sqls)).toBe(true);
  });

  it("regression guard: an unobservable poll (transport) at T+61min DOES fail (vanished-job backstop)", async () => {
    pollMock.mockResolvedValue({ ok: false, error: "poll threw" });
    const { env, sqls } = recordingEnv();
    await refreshTrainingLora(env, trainingCast(), BASE_MS + 61 * 60 * 1000);
    expect(markedFailed(sqls)).toBe(true);
  });
});
