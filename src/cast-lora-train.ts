// Cast LoRA training: submit a single-slot bundle, poll RunPod, harvest the key.

import type { Env } from "./platform/orchestrator-context.js";
import {
  getCastById,
  toPublicCast,
  markLoraFailed,
  markLoraReady,
  markWanLoraReady,
  setLoraJob,
  type CastMember,
} from "./cast-db.js";
import { assembleBundle } from "./bundle-assembler.js";
import {
  pollCastLoraJob,
  submitTrainLoraJob,
  submitTrainWanLoraJob,
  type RunpodJobBackend,
  type RunpodResult,
} from "./runpod-submit.js";
import {
  parseRunpodErrorType,
  recordRunpodJob,
  terminalOutcomeFromRunpodStatus,
} from "./runpod-job-log.js";
import { secretValue, type SecretsStoreSecret } from "./secret-store.js";
import {
  buildLoraTrainingBundleArgs,
  deriveLoraDestKey,
  deriveWanLoraDestKeys,
  extractTrainedLoraKey,
  extractTrainedWanLoraKeys,
  type WanLoraDestKeys,
} from "./lora-bundle.js";

const MIN_TRAINING_REFS = 4;

// -------------------------------------------------------------------------------------------------
// JOB-LOG ATTRIBUTION FOR CAST LoRA TRAINING (cf#475).
//
// THE GAP THIS CLOSES. Every RunPod job a MODULE WORKER submits has written a runpod_job_log row
// since cf#279. Cast LoRA training is submitted from HERE instead -- studio-side, through
// runpod-submit.ts -- and wrote nothing at all. Measured on the money rather than inferred: the
// vivijure-wan-train endpoint billed 14.5% of GPU spend on 2026-08-01 and 21.9% on 2026-08-02 with
// ZERO rows on either day. Not mis-attributed; absent, and absent in the flattering direction, since
// every row that IS in the table is correct.
//
// It matters more than telemetry tidiness because cf#394 rules cast-LoRA training in scope for the
// hosted door: without a row there is nothing that says which tenant caused an hour and three
// quarters of an 80GB card, TENANT_SPEND_DAILY_CEILING is unenforceable on the single most expensive
// operation in the product, and there is no basis to bill it.
//
// SAME RECORDER, NOT A SECOND ONE. recordRunpodJob is the identical function the 97 module call
// sites use; it moved into core in this change precisely so this path could reach it (see
// runpod-job-log.ts for why, and for the drift that had already happened between the two copies that
// existed before). Nothing here re-implements the upsert, the bounds, the timeout or the retry.
//
// WHAT IS DELIBERATELY NOT RECORDED, so an absence here is not read as an oversight:
//
//   LOCAL-DOOR TRAINS. An SDXL train on the homelab door is our own iron and carries no marginal
//   vendor cost, which is the standing ruling on what the meter is for. It is not RunPod spend and a
//   runpod_job_log row for it would be a fabricated one.
//
//   FAILED SUBMITS. No job id means nothing to key the upsert on, and nothing was billed. This
//   matches the module path exactly, which also records only once an id exists.
//
//   JOBS WE NEVER OBSERVED TERMINAL. The terminal write happens when a poll SEES a terminal status.
//   A job that ages out of RunPod retention (~30 min) before any poll catches it leaves its row at
//   `submitted` with no seconds -- honest, and visibly open, rather than guessed. reconcileOpenRunpodJobs
//   in runpod-job-log.ts is the mechanism that closes those and is now reachable from core; wiring a
//   cast-train pass through it is follow-on work, not something this change silently claims.
// -------------------------------------------------------------------------------------------------

/** Job-log `module` label for a Wan cast train. Maps to the RUNPOD_WAN_TRAIN_ENDPOINT_ID endpoint,
 *  which bills as `vivijure-wan-train` in RunPod serverless. */
export const CAST_TRAIN_WAN_JOB_LOG_MODULE = "cast-train-wan";

/** Job-log `module` label for a cloud SDXL cast train, which shares the render endpoint. */
export const CAST_TRAIN_SDXL_JOB_LOG_MODULE = "cast-train-sdxl";

/**
 * The job-log label for a result, or null when this job is not RunPod GPU spend on our account.
 *
 * Null for `local-door` (own iron) and for an UNTAGGED result. Untagged returning null is the point:
 * a caller that forgets to tag records nothing, rather than recording a job against a guessed
 * endpoint. A gap is findable; an invented row is not.
 */
export function castTrainJobLogModule(backend: RunpodJobBackend | undefined): string | null {
  if (backend === "runpod-wan-train") return CAST_TRAIN_WAN_JOB_LOG_MODULE;
  if (backend === "runpod-render") return CAST_TRAIN_SDXL_JOB_LOG_MODULE;
  return null;
}

/** Open the row the moment a training job exists on a RunPod endpoint. */
async function recordCastTrainSubmit(
  env: Env,
  submit: RunpodResult,
  submittedAtMs: number,
): Promise<void> {
  if (!submit.ok) return;
  const moduleLabel = castTrainJobLogModule(submit.backend);
  if (!moduleLabel) return;
  await recordRunpodJob(env.DB, {
    jobId: submit.view.jobId,
    module: moduleLabel,
    outcome: "submitted",
    submittedAtMs,
  });
}

/**
 * Close the row when a poll OBSERVES a terminal status, carrying RunPod's own execution and delay
 * times so the seconds are attributable rather than merely counted.
 *
 * Self-gating on purpose: callers hand it every successful poll and it writes only on a terminal
 * one. That keeps the two poll paths (refreshTrainingLora and handleCastLoraStatus) from each
 * growing their own copy of the terminal-status list, which is the same duplication this whole
 * change is about.
 *
 * submittedAtMs is NOT passed. The submit write already set it, the upsert never overwrites it, and
 * the only value available here is the cast row's updated_at, which moves. An unknown submit time
 * must stay distinguishable from a known one, so on the (rare) path where the submit write was lost
 * this INSERTs with submitted_at NULL rather than with a plausible-looking guess.
 */
async function recordCastTrainTerminal(env: Env, poll: RunpodResult): Promise<void> {
  if (!poll.ok) return;
  const moduleLabel = castTrainJobLogModule(poll.backend);
  if (!moduleLabel) return;
  const view = poll.view;
  const outcome = terminalOutcomeFromRunpodStatus(view.statusRaw);
  if (!outcome) return;
  await recordRunpodJob(env.DB, {
    jobId: view.jobId,
    module: moduleLabel,
    outcome,
    detail: outcome === "completed" ? undefined : view.error || "runpod status " + view.statusRaw,
    errorType: parseRunpodErrorType(view.error),
    // NULL-not-zero: normalizeRunpodResponse leaves these undefined when RunPod did not report
    // them, and recordRunpodJob turns undefined into NULL. A 0 would read as a real measurement of
    // a job that took no time.
    executionMs: view.executionTimeMs ?? null,
    delayMs: view.delayTimeMs ?? null,
  });
}

export type CastTrainModelFamily = "sdxl" | "wan";

export interface CastTrainRequestBody {
  renderOverrides?: Record<string, unknown>;
  modelFamily?: CastTrainModelFamily;
  trainOverrides?: Record<string, unknown>;
}

// True when the host wired RUNPOD_WAN_TRAIN_ENDPOINT_ID (the dedicated Wan train endpoint).
export async function wanTrainEndpointConfigured(env: Env): Promise<boolean> {
  const endpointId = await secretValue(
    (env as { RUNPOD_WAN_TRAIN_ENDPOINT_ID?: unknown }).RUNPOD_WAN_TRAIN_ENDPOINT_ID as
      SecretsStoreSecret | string | undefined,
  );
  return Boolean(endpointId.trim());
}

// Resolves the cast train family from an OPTIONAL caller preference plus the host's wiring. It
// answers two different questions and must never answer one with the other (core#174):
//
//   EXPLICIT -- the caller named a family. Honour it verbatim. An explicit "wan" returns "wan"
//   whatever the host state; if RUNPOD_WAN_TRAIN_ENDPOINT_ID is unwired, executeCastTrain refuses
//   with its shipped 501 and trains nothing. We do NOT substitute a different model family for a
//   request the user actually made: a Wan cast train is a different job at a different duration
//   and a different price, and the panel has already shown the user those numbers. Silently
//   training SDXL instead returns 200 for a job they did not consent to.
//
//   ABSENT -- the caller expressed no preference, so we pick the host-appropriate default: Wan
//   when the dedicated endpoint is wired (cf#29 Phase E), SDXL otherwise. Choosing on behalf of
//   someone who did not choose is legitimate and stays silent.
//
// An UNRECOGNISED value is not a preference we can honour, so it takes the ABSENT path rather
// than being waved through to a refusal it never asked for.
//
// Both branches previously returned `wanConfigured ? "wan" : "sdxl"`, which collapsed EXPLICIT
// into ABSENT and made `model_family: "wan"` byte-identical to sending nothing. Note that the
// wanConfigured argument is now consulted by the ABSENT path only; the refusal for an unwired
// host lives in executeCastTrain, which re-reads the binding itself.
export function resolveCastTrainFamily(
  wanConfigured: boolean,
  explicit?: string | null,
): CastTrainModelFamily {
  const norm = String(explicit ?? "").trim().toLowerCase();
  if (norm === "sdxl") return "sdxl";
  if (norm === "wan") return "wan";
  return wanConfigured ? "wan" : "sdxl";
}

export function parseCastTrainBodyFields(
  parsed: {
    renderOverrides?: unknown;
    model_family?: unknown;
    modelFamily?: unknown;
    train_overrides?: unknown;
    trainOverrides?: unknown;
  } | null | undefined,
  wanConfigured: boolean,
): CastTrainRequestBody {
  let renderOverrides: Record<string, unknown> | undefined;
  let modelFamily: CastTrainModelFamily | undefined;
  let trainOverrides: Record<string, unknown> | undefined;
  if (
    parsed?.renderOverrides &&
    typeof parsed.renderOverrides === "object" &&
    !Array.isArray(parsed.renderOverrides)
  ) {
    renderOverrides = parsed.renderOverrides as Record<string, unknown>;
    const roFamily = renderOverrides.model_family ?? renderOverrides.modelFamily;
    if (typeof roFamily === "string") {
      modelFamily = resolveCastTrainFamily(wanConfigured, roFamily);
    }
  }
  const topFamily = parsed?.model_family ?? parsed?.modelFamily;
  if (typeof topFamily === "string") {
    modelFamily = resolveCastTrainFamily(wanConfigured, topFamily);
  }
  const rawTrain = parsed?.train_overrides ?? parsed?.trainOverrides;
  if (rawTrain && typeof rawTrain === "object" && !Array.isArray(rawTrain)) {
    trainOverrides = rawTrain as Record<string, unknown>;
  }
  return { renderOverrides, modelFamily, trainOverrides };
}

async function parseCastTrainRequestBody(
  request: Request,
  wanConfigured: boolean,
): Promise<CastTrainRequestBody> {
  try {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const parsed = (await request.json()) as {
        renderOverrides?: unknown;
        model_family?: unknown;
        modelFamily?: unknown;
        train_overrides?: unknown;
        trainOverrides?: unknown;
      };
      return parseCastTrainBodyFields(parsed, wanConfigured);
    }
  } catch {
    /* empty body is fine */
  }
  return {};
}

// --- Stuck-training reconciler (#295) ---------------------------------------------------------
// A cast LoRA training row transitions off `training` only when a poll observes a TERMINAL RunPod
// status. If the backing job ages out of RunPod's retention window before any poll catches a terminal
// state, the poll keeps returning not-found/non-terminal and the row wedges in `training` forever --
// and the train-lora route then 409s, so the character can never be retrained without a manual D1
// edit. The reconciler closes that hole: a not-found (404) past a grace window, or a row older than a
// hard ceiling, is force-failed (an HONEST degrade with a clear lora_error, never a silent reset) so
// the user can re-fire.

// Ignore a 404 within this window of the row's last write: a just-submitted job can briefly 404 before
// RunPod registers it (mirrors the GC-grace discipline on the status path).
export const LORA_TRAIN_404_GRACE_SECONDS = 120;
// Hard ceiling for an UNOBSERVABLE row -- a poll that could NOT read a live status (transport error,
// or a non-404 not-ok result): a row sitting in `training` this long was never observed terminal and
// is treated as failed (the backstop for a vanished job). This is an SDXL-era number (cast trains were
// ~10-15 min); it must NOT judge an OBSERVED-running job (see LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS, #92).
export const LORA_TRAIN_MAX_AGE_SECONDS = 60 * 60;
// Hard ceiling for an OBSERVED non-terminal row -- poll.ok, RunPod reporting IN_QUEUE / IN_PROGRESS. A
// live-reporting job must never be declared dead by a wall clock tuned to a different model family: a
// Wan A14B two-expert train legitimately runs 1-2h, and RunPod flips the job TIMED_OUT at its own 2h
// endpoint timeout, which then takes the honest FAILED path on the next poll. This ceiling (3h) only
// backstops a status that froze past even that endpoint timeout plus margin (#92). The measured Wan
// wall-clock lands on vivijure-cf#177.
export const LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS = 3 * 60 * 60;

export interface StuckTrainingDecision {
  reconcile: boolean;
  reason?: string;
}

// SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone. Parse it as a UTC epoch
// in ms; returns null for a missing/unparseable value (the caller then declines to reconcile, never
// false-failing a row whose age it cannot establish).
export function sqliteUtcToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(t) ? t : t + "Z";
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

// How long a row has sat in `training`, measured from its last write (updated_at -- set by setLoraJob
// when the job was submitted). null when the timestamp can't be parsed.
export function trainingAgeSeconds(cast: CastMember, now: number): number | null {
  const ms = sqliteUtcToMs(cast.updated_at);
  if (ms === null) return null;
  return (now - ms) / 1000;
}

// Pure decision: should a `training` row whose backing job we just polled be force-failed? `poll` is
// the pollCastLoraJob result; ageSeconds is trainingAgeSeconds (null => unknown, never reconcile). A 404
// past the grace window means the job is gone from RunPod retention; the max-age ceiling is the
// backstop for a job that simply never reported terminal.
export function decideStuckTraining(
  poll: { ok: boolean; status?: number },
  ageSeconds: number | null,
): StuckTrainingDecision {
  if (ageSeconds === null) return { reconcile: false };
  const notFound = poll.ok === false && poll.status === 404;
  if (notFound && ageSeconds >= LORA_TRAIN_404_GRACE_SECONDS) {
    return {
      reconcile: true,
      reason:
        `backing RunPod job not found (HTTP 404; aged out of retention) after ` +
        `${Math.round(ageSeconds)}s in training -- it cannot complete; re-fire training`,
    };
  }
  // #92 observability split: an OBSERVED non-terminal poll (poll.ok -- RunPod is reporting a live
  // IN_QUEUE / IN_PROGRESS status) may only be aged out by a ceiling covering the endpoint OWN timeout
  // (RunPod flips TIMED_OUT at 2h, taking the honest FAILED path on the next poll). An UNOBSERVABLE
  // poll (transport error / non-404 not-ok) keeps the original SDXL-era backstop for a vanished job.
  // This stops a cast-status poll or resolveCastLoras refresh past T+60min from false-failing an
  // actively-training Wan row while the GPU job is still running.
  const ceiling = poll.ok ? LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS : LORA_TRAIN_MAX_AGE_SECONDS;
  if (ageSeconds >= ceiling) {
    return {
      reconcile: true,
      reason:
        `training exceeded max age (${Math.round(ageSeconds)}s >= ${ceiling}s); ` +
        `backing job not observed terminal -- re-fire training`,
    };
  }
  return { reconcile: false };
}

async function harvestCompletedLora(
  env: Env,
  cast: CastMember,
  output: unknown,
): Promise<CastMember | null> {
  const wanKeys = extractTrainedWanLoraKeys(output);
  if (wanKeys) return (await markWanLoraReady(env, cast.id, wanKeys.high, wanKeys.low)) || cast;
  const loraKey = extractTrainedLoraKey(output);
  if (loraKey) return (await markLoraReady(env, cast.id, loraKey)) || cast;
  return (
    (await markLoraFailed(
      env,
      cast.id,
      "GPU job completed but envelope carried no harvestable LoRA key (neither SDXL nor Wan experts)",
    )) || cast
  );
}

// When RunPod retention drops the job before any poll catches COMPLETED, the dual Wan expert keys may
// still exist in R2 under loras/lora-{slug}-{timestamp}/A/. Safe only when BOTH experts are present
// for the same project prefix; picks the newest pair by upload time.
async function discoverWanLoraKeysInR2(env: Env, cast: CastMember): Promise<WanLoraDestKeys | null> {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const prefix = `loras/lora-${safeSlug}-`;
  const highSuffix = "/A/wan_high_noise.safetensors";
  const lowSuffix = "/A/wan_low_noise.safetensors";
  let cursor: string | undefined;
  let best: { high: string; low: string; uploaded: number } | null = null;

  do {
    const page = await env.R2_RENDERS.list({ prefix, cursor, limit: 100 });
    for (const obj of page.objects) {
      if (!obj.key.endsWith(highSuffix)) continue;
      const base = obj.key.slice(0, -highSuffix.length);
      const lowKey = `${base}${lowSuffix}`;
      const lowListed = page.objects.some((o) => o.key === lowKey);
      if (!lowListed && (await env.R2_RENDERS.head(lowKey)) === null) continue;
      const uploaded = obj.uploaded?.getTime() ?? 0;
      if (!best || uploaded > best.uploaded) {
        best = { high: obj.key, low: lowKey, uploaded };
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return best ? { high: best.high, low: best.low } : null;
}

async function tryReconcileWanLoraFromR2(
  env: Env,
  cast: CastMember,
): Promise<CastMember | null> {
  if (cast.wan_lora_key_high || cast.wan_lora_key_low) return null;
  let keys: WanLoraDestKeys | null;
  try {
    keys = await discoverWanLoraKeysInR2(env, cast);
  } catch {
    return null;
  }
  if (!keys) return null;
  return (await markWanLoraReady(env, cast.id, keys.high, keys.low)) || cast;
}

export async function refreshTrainingLora(
  env: Env,
  cast: CastMember | null,
  now: number = Date.now(),
): Promise<CastMember | null> {
  if (!cast || cast.lora_status !== "training" || !cast.lora_job_id) return cast;
  const ageSeconds = trainingAgeSeconds(cast, now);
  let poll: RunpodResult;
  try {
    poll = await pollCastLoraJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }
  // cf#475: record BEFORE acting on the status. The recorder is best-effort by contract (it never
  // throws and never outlives its own timeout), so it cannot affect what happens next; putting it
  // first means every RETURN path below is already covered and a future branch cannot be added past
  // the recording without noticing.
  await recordCastTrainTerminal(env, poll);
  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      return harvestCompletedLora(env, cast, view.output);
    }
    if (
      view.status === "FAILED" ||
      view.status === "TIMED_OUT" ||
      view.status === "CANCELLED"
    ) {
      return (
        (await markLoraFailed(
          env,
          cast.id,
          view.error || `training ${view.status.toLowerCase()}`,
        )) || cast
      );
    }
  }
  // Not terminal (poll 404 / transport error / a non-terminal-but-wedged view): reconcile a row whose
  // backing job is gone past the grace window, or that has simply aged out. #295 -- never leave it
  // wedged in `training` (that 409s every retry).
  const decision = decideStuckTraining(poll, ageSeconds);
  if (decision.reconcile) {
    const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
    if (fromR2) return fromR2;
    return (await markLoraFailed(env, cast.id, decision.reason as string)) || cast;
  }
  if (!poll.ok && poll.status === 404) {
    const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
    if (fromR2) return fromR2;
  }
  return cast;
}

export async function handleCastTrainLora(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const wanConfigured = await wanTrainEndpointConfigured(env);
  const body = await parseCastTrainRequestBody(request, wanConfigured);
  const family = body.modelFamily ?? resolveCastTrainFamily(wanConfigured);
  return executeCastTrain(env, id, body.renderOverrides, family, body.trainOverrides);
}

// Explicit Wan route (cf#29): always submits to RUNPOD_WAN_TRAIN_ENDPOINT_ID. Kept as a stable alias
// for callers that already POST /train-wan-lora; /train-lora defaults to Wan when the endpoint is wired.
export async function handleCastTrainWanLora(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const wanConfigured = await wanTrainEndpointConfigured(env);
  const body = await parseCastTrainRequestBody(request, wanConfigured);
  return executeCastTrain(env, id, body.renderOverrides, "wan", body.trainOverrides);
}

async function executeCastTrain(
  env: Env,
  id: number,
  bodyRenderOverrides: Record<string, unknown> | undefined,
  family: CastTrainModelFamily,
  bodyTrainOverrides?: Record<string, unknown>,
): Promise<Response> {
  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);
  if (cast.lora_status === "training") {
    return json(
      {
        error: "a LoRA training job is already in flight for this cast member",
        jobId: cast.lora_job_id,
      },
      409,
    );
  }
  if (!cast.portrait_key) {
    return json(
      { error: "cast member needs a portrait before training (set one via /cast)" },
      400,
    );
  }
  if (cast.ref_keys.length < MIN_TRAINING_REFS) {
    return json(
      {
        error: `cast member has only ${cast.ref_keys.length} training refs; need at least ${MIN_TRAINING_REFS}. Use the training-set generator on /cast.`,
      },
      400,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const args = buildLoraTrainingBundleArgs(cast, String(timestamp));

  let bundleResult;
  try {
    bundleResult = await assembleBundle(env, args);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `bundle assembly failed: ${m}` }, 500);
  }
  if (!bundleResult.ok) {
    return json(
      { error: "bundle assembly failed", details: bundleResult.errors },
      500,
    );
  }

  if (family === "wan") {
    if (!(await wanTrainEndpointConfigured(env))) {
      return json(
        { error: "Wan cast LoRA training is not configured on this host (wire RUNPOD_WAN_TRAIN_ENDPOINT_ID)" },
        501,
      );
    }
    const loraDestKeys = deriveWanLoraDestKeys(cast.id, timestamp);
    const submit = await submitTrainWanLoraJob(env, {
      project: args.storyboard.projectName,
      bundleKey: bundleResult.bundleKey,
      renderOverrides: bodyRenderOverrides,
      trainOverrides: bodyTrainOverrides,
    });
    if (!submit.ok) {
      return json({ error: submit.error }, 502);
    }
    // cf#475: the job now exists on a RunPod endpoint and is accruing GPU-seconds. Open its row.
    await recordCastTrainSubmit(env, submit, timestamp * 1000);
    const updated = await setLoraJob(env, cast.id, submit.view.jobId);
    return json({
      ok: true,
      jobId: submit.view.jobId,
      status: submit.view.status,
      statusRaw: submit.view.statusRaw,
      bundleKey: bundleResult.bundleKey,
      loraDestKeys,
      modelFamily: "wan",
      cast: toPublicCast(updated || cast),
    });
  }

  const loraDestKey = deriveLoraDestKey(cast.id, timestamp);
  const submit = await submitTrainLoraJob(env, {
    project: args.storyboard.projectName,
    bundleKey: bundleResult.bundleKey,
    renderOverrides: bodyRenderOverrides,
  });
  if (!submit.ok) {
    return json({ error: submit.error }, 502);
  }

  // cf#475. A local-door train is tagged `local-door` and records nothing (see castTrainJobLogModule).
  await recordCastTrainSubmit(env, submit, timestamp * 1000);
  const updated = await setLoraJob(env, cast.id, submit.view.jobId);
  return json({
    ok: true,
    jobId: submit.view.jobId,
    status: submit.view.status,
    statusRaw: submit.view.statusRaw,
    bundleKey: bundleResult.bundleKey,
    loraDestKey,
    modelFamily: "sdxl",
    cast: toPublicCast(updated || cast),
  });
}

export async function handleCastLoraStatus(
  env: Env,
  id: number,
): Promise<Response> {
  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);
  if (!cast.lora_job_id) {
    return json({ cast: toPublicCast(cast), view: null });
  }

  const ageSeconds = trainingAgeSeconds(cast, Date.now());
  let poll: RunpodResult;
  try {
    poll = await pollCastLoraJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }

  // cf#475, same reasoning as refreshTrainingLora: record the observation before branching on it.
  await recordCastTrainTerminal(env, poll);
  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      const updated = await harvestCompletedLora(env, cast, view.output);
      return json({ cast: toPublicCast(updated || cast), view });
    }
    if (view.status === "FAILED" || view.status === "TIMED_OUT" || view.status === "CANCELLED") {
      const msg = view.error || `training ${view.status.toLowerCase()}`;
      const updated = await markLoraFailed(env, cast.id, msg);
      return json({ cast: toPublicCast(updated || cast), view });
    }
    return json({ cast: toPublicCast(cast), view });
  }

  // poll failed (404 / transport): reconcile a wedged `training` row (#295) before surfacing the
  // error, so an aged-out job can't keep the row stuck (which 409s every retry). A 404 inside the
  // grace window, or any non-training row, falls through to the honest 502.
  if (cast.lora_status === "training") {
    const decision = decideStuckTraining(poll, ageSeconds);
    if (decision.reconcile) {
      const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
      if (fromR2) {
        return json({ cast: toPublicCast(fromR2), view: null, reconciledFromR2: true });
      }
      const updated = await markLoraFailed(env, cast.id, decision.reason as string);
      return json({ cast: toPublicCast(updated || cast), view: null, reconciled: true });
    }
    if (!poll.ok && poll.status === 404) {
      const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
      if (fromR2) {
        return json({ cast: toPublicCast(fromR2), view: null, reconciledFromR2: true });
      }
    }
  }
  return json({ error: poll.error, cast: toPublicCast(cast) }, 502);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
