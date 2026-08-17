// RunPod serverless submit / poll helpers (v0.32.0).
//
// Pure URL + payload builders + response normalizer plus a thin dispatcher
// that calls fetch. The dispatcher is not unit-tested (it would require
// mocking the fetch global); the pure helpers are tested in their own file
// and the dispatcher mirrors them. Reuses the project's "no zod / ajv at
// runtime, hand-authored types" convention from src/env.ts.
//
// The vivijure-serverless GPU worker is a RunPod queue-based endpoint. The
// job input shape is fixed in rp_handler.py:
//
//   { "project": "<name>", "bundle_key": "bundles/<name>.tar.gz",
//     "quality_tier": "draft|standard|final",
//     "render_overrides": { "keyframe": {...}, "i2v": {...}, "lora": {...} } }
//
// RunPod wraps this in `{ "input": {...} }` on submit. Polling returns an
// envelope { id, status, output?, error?, executionTime?, delayTime? }.

import type { Env } from "./platform/orchestrator-context.js";
import type { TenantR2Config } from "./modules/types.js";
import { tenantR2FromEnv } from "./modules/tenant-r2.js";
import { secretValue, type SecretsStoreSecret } from "./secret-store.js";
import { reconcileRunpodEndpointWorkersMax } from "./runpod-endpoint-reconcile.js";
import {
  RUNPOD_DIRECT_BASE,
  planeRefusalError,
  planeRefusalReason,
  runpodCredentialName,
  runpodEndpointUrl,
  runpodHeaders,
  runpodRoute,
  type RunpodRoute,
  type RunpodRouteEnv,
} from "./runpod-route.js";

// Quality tier normalizer / validator (v0.156.3). The render tiers are keyframe (a
// separate keyframesOnly flag) plus three real generation tiers the pod's `for_tier`
// genuinely distinguishes: draft (4-step distilled), standard (8-step keyframe + 20-step
// EasyCache i2v, the middle), and final (30-step keyframe + 40-step MixCache i2v). v0.156.1
// wrongly dropped standard on the belief for_tier only branched draft/final; it does not
// (config.py KeyframeConfig.for_tier and I2VConfig.for_tier each branch all three), so
// standard is restored here. Returns undefined for an invalid tier the caller should hear about.
export function coerceQualityTier(t: unknown): "draft" | "standard" | "final" | undefined {
  if (t === "draft") return "draft";
  if (t === "standard") return "standard";
  if (t === "final") return "final";
  return undefined;
}

// What the planner / UI sends to /api/storyboard/render.
export interface RenderSubmitArgs {
  // Project slug; if omitted, derived from bundleKey by stripping prefix.
  project?: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  // The namespaced generation-override contract the clean-room backend reads
  // (config.py RenderConfig.from_request): { keyframe, i2v, lora } layered over
  // the quality-tier baseline, plus the one routing flag it reads off the raw
  // dict (finish_offloaded; keyframes-only is the `preview` action now, not a
  // flag). normalizeRenderOverrides drops anything else; the pod re-clamps. See
  // docs/render-api.md.
  renderOverrides?: Record<string, unknown>;
  // v0.40.0: skip Wan I2V + silent-MP4 assembly; produce only SDXL
  // keyframes so the user can preview shots before committing to the
  // full render. v0.160.0: this now selects the first-class
  // action="preview" on the wire (vivijure-backend Action.PREVIEW), not
  // a render_overrides.keyframes_only flag. The retired vivijure-
  // serverless read that flag and short-circuited after the SDXL pass;
  // the clean-room backend dispatches on `action` only, so the flag was
  // silently ignored and every "preview" ran a full render.
  keyframesOnly?: boolean;
  // v0.52.0: optional R2 key for an audio bed to mux onto the final
  // video. Vivijure-serverless 0.4.11+ downloads from R2_BUCKET and
  // muxes via export_film(with_audio=True). Caller (handleRenderSubmit)
  // is responsible for ensuring the key lives in R2_RENDERS (audio/
  // prefix); MiniMax-generated artifacts (out/<uuid>.<ext> in env.R2)
  // get cross-bucket-copied before this builder sees them.
  audioKey?: string;
  // v0.58.0: pretrained-LoRA passthrough. Resolved by the route from a
  // body-side {slot: cast_id} map; keys are R2 paths under loras/...
  pretrainedLoras?: Record<string, string>;
  // v0.161.0: restrict a fresh render to a subset of shots (scatter shards).
  // The backend orchestrator.plan() scopes scenes to process_shot_ids for ANY
  // action (not finalize-only); a scatter shard is a finish-offloaded render
  // over its slice. Empty / undefined => the full storyboard.
  processShotIds?: string[];
}

// What the vivijure-serverless rp_handler.py reads off the job input. Field
// names mirror the Python side (snake_case) so any change there propagates
// here without a layer of remapping.
export interface RenderJobInput {
  // v0.160.0: "preview" selects the keyframes-only render (train + SDXL
  // keyframes, no Wan i2v, no MP4) via vivijure-backend Action.PREVIEW.
  // Absent = full render (the backend's default "render"). A first-class
  // action like finalize/train_lora, not a render_overrides flag.
  action?: "preview";
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  audio_key?: string;
  // v0.58.0: {slot: r2_key} of pretrained LoRAs the worker should
  // stage to skip Stage 1 training. Resolved server-side from cast
  // bindings against cast_members rows the user owns.
  pretrained_loras?: Record<string, string>;
  // v0.161.0: subset of shots for a scatter shard (mirrors finalize's field).
  // The backend plan() scopes scenes to it for the render action too.
  process_shot_ids?: string[];
}

// Per-shot SDXL keyframe regeneration. The backend scopes to the shot via
// process_shot_ids (the field its orchestrator actually reads) and writes the
// keyframe to its stable convention key keys.keyframe_key(project, shot_id) --
// the SAME key as before, so a cache-bust on the <img> src picks up the new
// pixels with no parent-job tracking needed.
export interface RegenShotArgs {
  project: string;
  bundleKey: string;
  shotId: string;
}

export interface RegenShotJobInput {
  action: "regen_shot";
  project: string;
  bundle_key: string;
  process_shot_ids: string[];
}

// v0.42.0: finalize. Runs Wan I2V over the keyframes already on the
// volume from a prior keyframes-only preview, then assembles the
// silent MP4. Same wire shape as RenderSubmitArgs (qualityTier +
// renderOverrides pass through to the GPU); only the action field
// distinguishes it from a fresh render at the dispatcher.
export interface FinalizeArgs {
  project: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  renderOverrides?: Record<string, unknown>;
  // v0.45.0: optional shot_id list to restrict the I2V pass + final
  // assembly to. When non-empty the GPU (vivijure-serverless 0.4.5+)
  // processes ONLY these shots and assembles the silent MP4 from a
  // temp manifest filtered to them. When undefined / empty, the GPU
  // runs the full all-scenes flow (v0.4.4 behavior). Sourced from
  // the originating row's locked_shots column in the handler.
  processShotIds?: string[];
  // v0.52.0: same audio-mux opt-in as RenderSubmitArgs.audioKey.
  audioKey?: string;
  // v0.58.0: same pretrained-LoRA passthrough as RenderSubmitArgs.
  pretrainedLoras?: Record<string, string>;
}

export interface FinalizeJobInput {
  action: "finalize";
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  process_shot_ids?: string[];
  audio_key?: string;
  pretrained_loras?: Record<string, string>;
}

// Standalone LoRA training. The cast manager UI submits this; the backend
// dispatches on action=="train_lora", pulls the synthesized single-slot bundle,
// trains, and uploads the .safetensors to its OWN convention key
// (vivijure-backend keys.lora_key(project, slot)) -- the caller does not pick
// the destination.
export interface TrainLoraArgs {
  project: string;
  bundleKey: string;
  // The namespaced override contract (same as the render path). Training
  // hyperparams ride render_overrides.lora (rank / max_steps / learning_rate /
  // ...), parsed by config.py RenderConfig.from_request on the pod. Lets the
  // cast manager's "train LoRA" button iterate without an image rebuild.
  renderOverrides?: Record<string, unknown>;
  // Per-job tenant R2 for a pooled Wan-train endpoint. Same four-field shape as
  // the render invoke envelope. Omitted (never null) when the host has no
  // R2_S3_* set -- dedicated EP / env R2 still works. Only buildTrainWanLoraPayload
  // puts this on the wire.
  r2?: TenantR2Config;
  // wan-train knobs.py allow-list. Unknown keys are dropped so a typo cannot
  // fail a train (the worker refuses unknown keys). Only the Wan payload emits this.
  trainOverrides?: TrainOverrides;
}

/** Keys wan-train accepts on train_overrides (batch_size, resolution, steps). */
export interface TrainOverrides {
  batch_size?: number;
  resolution?: number;
  steps?: number;
}

const TRAIN_OVERRIDE_KEYS = ["batch_size", "resolution", "steps"] as const;

/** Keep only the wan-train allow-list. Unknown keys dropped; non-finite numbers dropped. */
export function clampTrainOverrides(raw: unknown): TrainOverrides | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const out: TrainOverrides = {};
  for (const k of TRAIN_OVERRIDE_KEYS) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface TrainLoraJobInput {
  action: "train_lora";
  project: string;
  bundle_key: string;
  render_overrides?: Record<string, unknown>;
  // Which LoRA family the GPU trains. Omitted on /train-lora defaults to Wan when
  // RUNPOD_WAN_TRAIN_ENDPOINT_ID is wired (cf#29 Phase E); explicit "sdxl" keeps the render-endpoint
  // escape hatch. submitTrainWanLoraJob always sets "wan".
  model_family?: "sdxl" | "wan";
  // Tenant destination for a pooled Wan-train job. Absent = use the endpoint
  // template env (operator studio / dedicated EP).
  r2?: TenantR2Config;
  train_overrides?: TrainOverrides;
}

// RunPod queue-based job status. The platform uses these literal strings
// across submit / poll / cancel responses. Anything else surfaces as the
// raw string in `statusRaw` so the UI can show it without us silently
// dropping a new RunPod-side state.
export type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

// Normalized response shape returned by both submit and poll. `output` /
// `error` populate per RunPod's envelope; `executionTime` and `delayTime`
// are pass-throughs (milliseconds, integers) when RunPod returns them.
export interface RunpodJobView {
  jobId: string;
  status: RunpodStatus;
  statusRaw: string;
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

// The DIRECT route: RunPod itself, no credential resolved yet. Every URL builder below defaults to
// it, so a caller that has not resolved a route gets byte-for-byte the URLs this file has always
// produced (`https://api.runpod.ai/v2/<endpoint>/...`). The credential is empty here on purpose --
// these builders produce URLs and must never carry a secret. See src/runpod-route.ts for why the
// branch is on RUNPOD_PROXY_BASE being BOUND and is never a failover.
const DIRECT_ROUTE: RunpodRoute = { base: RUNPOD_DIRECT_BASE, credential: "", proxied: false };

// Bundle key shape (mirrors bundle-assembler.assembleBundle's output):
//   bundles/<projectName>.tar.gz
// Extracts <projectName> for the rp_handler `project` field when the caller
// did not provide one explicitly. Falls back to the full bundleKey when the
// shape does not match, which lets a caller stage a custom-keyed bundle
// outside the assembler and still submit it.
export function deriveProjectFromBundleKey(bundleKey: string): string {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

export function buildSubmitPayload(args: RenderSubmitArgs): { input: RenderJobInput } {
  const project =
    args.project && args.project.trim().length > 0
      ? args.project.trim()
      : deriveProjectFromBundleKey(args.bundleKey);
  const input: RenderJobInput = {
    project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  // v0.160.0: keyframes-only is a first-class action (Action.PREVIEW), not a
  // render_overrides.keyframes_only flag the backend has to remember to read.
  // The retired vivijure-serverless honored the flag; the clean-room backend
  // dispatches on `action` only, so the flag was a dead passenger and every
  // preview ran the full train -> keyframes -> i2v -> MP4 path.
  if (args.keyframesOnly) input.action = "preview";
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  // v0.52.0: pass through the audio bed key. Already-empty values stay
  // off the wire so 0.4.10 and earlier workers (which ignore unknown
  // fields anyway) see no diff.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  // v0.68.0 hot-fix: buildSubmitPayload was missing the pretrained_loras
  // pass-through that buildFinalizePayload already had. That meant the
  // v0.58.0 castLoras feature populated the route's response envelope
  // (pretrainedSlots) but the wire body never carried the actual
  // {slot: r2_key} map, so the GPU never staged the LoRAs and Stage 1
  // re-trained from scratch every time. Identified during the post-
  // 0.4.16 smoke-test investigation - we were chasing
  // _stage_pretrained_loras silently failing on the GPU when the bug
  // was that the field never reached it.
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  // v0.161.0: subset render for a scatter shard. Same empty-array-is-undefined
  // semantic as finalize: an empty list means "the full storyboard".
  if (Array.isArray(args.processShotIds) && args.processShotIds.length > 0) {
    input.process_shot_ids = [...args.processShotIds];
  }
  return { input };
}

// v0.42.0: pure builder for the finalize RunPod payload. Action gates
// the GPU dispatcher into the Wan-I2V-only + assemble branch (no
// fresh SDXL). Identical wire fields to buildSubmitPayload otherwise.
export function buildFinalizePayload(args: FinalizeArgs): { input: FinalizeJobInput } {
  const input: FinalizeJobInput = {
    action: "finalize",
    project: args.project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  // v0.45.0: only include the shot list when there is at least one
  // shot to process. An empty array stripped to undefined means "run
  // the full all-scenes flow" on the GPU side; that matches the
  // semantic the Worker route surfaces ("if nothing is locked, run
  // everything").
  if (Array.isArray(args.processShotIds) && args.processShotIds.length > 0) {
    input.process_shot_ids = [...args.processShotIds];
  }
  // v0.52.0: same audio_key passthrough as buildSubmitPayload.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  return { input };
}

// v0.57.0: pure builder for the standalone LoRA training payload.
// Same wire shape as the render/finalize/regen actions; the GPU
// dispatcher routes on the `action` field.
export function buildTrainLoraPayload(args: TrainLoraArgs): { input: TrainLoraJobInput } {
  const input: TrainLoraJobInput = {
    action: "train_lora",
    project: args.project,
    bundle_key: args.bundleKey,
  };
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  return { input };
}

// A Wan train is the same train_lora action + payload, plus model_family:"wan" so the backend
// routes to the ai-toolkit two-expert trainer. Submitted to the dedicated Wan-training endpoint.
export function buildTrainWanLoraPayload(args: TrainLoraArgs): { input: TrainLoraJobInput } {
  const { input } = buildTrainLoraPayload(args);
  input.model_family = "wan";
  // OMIT, never null: the backend refuses an explicit `"r2": null`. Copy the
  // four fields so a caller cannot alias the credential object after we build.
  if (args.r2) {
    input.r2 = {
      endpoint: args.r2.endpoint,
      access_key_id: args.r2.access_key_id,
      secret_access_key: args.r2.secret_access_key,
      bucket: args.r2.bucket,
    };
  }
  const trainOverrides = clampTrainOverrides(args.trainOverrides);
  if (trainOverrides) input.train_overrides = trainOverrides;
  return { input };
}

// The namespaced render-override contract the clean-room vivijure-backend reads
// (config.py RenderConfig.from_request): a { keyframe, i2v, lora } object layered
// over the quality-tier baseline, plus the one routing flag the backend reads off
// the raw overrides dict (finish_offloaded; keyframes-only is the `preview` action
// now). Anything outside these
// known sections / flags is DROPPED here -- the planner historically sent ~24
// vivijure-serverless *_overrides blocks (multi_character, wan_diffusion, ...) that
// the clean-room backend never reads, so every advanced knob was silently lost
// (the contract-completeness audit, ~/vivijure-audit-F-contract.md). Sections pass
// through verbatim (keyframe nests multi_char); the pod re-clamps every value, so a
// stray key wastes no GPU. Advanced users now send the namespaced shape directly
// (docs/render-api.md).
const _OVERRIDE_SECTIONS = ["keyframe", "i2v", "lora"] as const;
// v0.160.0: keyframes_only is no longer a wire flag -- it is the `preview` action
// now (buildSubmitPayload sets input.action). finish_offloaded stays the one
// routing flag the backend reads off the raw overrides dict.
const _OVERRIDE_FLAGS = ["finish_offloaded"] as const;

export function normalizeRenderOverrides(
  raw: unknown,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    for (const sec of _OVERRIDE_SECTIONS) {
      const v = r[sec];
      if (v && typeof v === "object" && !Array.isArray(v)) out[sec] = v;
    }
    for (const f of _OVERRIDE_FLAGS) {
      if (typeof r[f] === "boolean") out[f] = r[f];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.41.0: pure builder for the per-shot regen RunPod payload. Mirrors
// buildSubmitPayload's shape so the dispatcher can use the same fetch
// surface. The GPU side dispatches by `action` and ignores fields
// irrelevant to its branch.
export function buildRegenShotPayload(args: RegenShotArgs): { input: RegenShotJobInput } {
  const input: RegenShotJobInput = {
    action: "regen_shot",
    project: args.project,
    bundle_key: args.bundleKey,
    process_shot_ids: [args.shotId],
  };
  return { input };
}

// The three verb URLs. `route` is OPTIONAL and defaults to the direct route, which keeps every
// existing caller (including vivijure-cf's transport tests, which pass a hand-written direct URL)
// byte-identical. The proxy is mounted at RunPod's own suffixes, so the only thing that changes
// between the two routes is the base.
export function buildSubmitUrl(endpointId: string, route: RunpodRoute = DIRECT_ROUTE): string {
  return `${runpodEndpointUrl(route, endpointId)}/run`;
}

export function buildStatusUrl(
  endpointId: string,
  jobId: string,
  route: RunpodRoute = DIRECT_ROUTE,
): string {
  return `${runpodEndpointUrl(route, endpointId)}/status/${jobId}`;
}

export function buildCancelUrl(
  endpointId: string,
  jobId: string,
  route: RunpodRoute = DIRECT_ROUTE,
): string {
  return `${runpodEndpointUrl(route, endpointId)}/cancel/${jobId}`;
}

// Validate a job id at the route boundary so a malformed id does not
// produce a RunPod 404 we have to translate back. RunPod ids are
// alphanumeric with hyphens / underscores; the cap is generous since the
// platform has not published an exact format.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

// Map RunPod's envelope to RunpodJobView. Tolerates missing fields and
// surfaces unknown status strings via `statusRaw`. Does not throw; the
// dispatcher decides how to translate transport errors to HTTP semantics.
export function normalizeRunpodResponse(raw: unknown): RunpodJobView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const jobId = typeof r.id === "string" ? r.id : "";
  const statusRaw = typeof r.status === "string" ? r.status : "";
  if (!jobId || !statusRaw) return null;
  const knownStatuses: RunpodStatus[] = [
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ];
  const status: RunpodStatus = knownStatuses.includes(statusRaw as RunpodStatus)
    ? (statusRaw as RunpodStatus)
    : "IN_PROGRESS"; // best-effort: keep the UI polling on unknown states
  const view: RunpodJobView = { jobId, status, statusRaw };
  if (r.output !== undefined) view.output = r.output;
  if (typeof r.error === "string" && r.error.length > 0) view.error = r.error;
  if (typeof r.executionTime === "number") view.executionTimeMs = r.executionTime;
  if (typeof r.delayTime === "number") view.delayTimeMs = r.delayTime;
  return view;
}

// ---------- Shared RunPod transport (retry + timeout) ----------
//
// All six RunPod call-sites (the four submitters + cancel + poll) used to be
// byte-identical fetch dispatchers differing only in method/payload and an
// error prefix -- exactly the copy-paste surface the v0.68.0 pretrained_loras
// divergence slipped through (issue #13). They share ONE transport now, so a
// reliability fix lands in a single place instead of six.
//
// Reliability: a transient failure (network error, per-attempt timeout, 429,
// or 5xx) is retried with bounded, jittered exponential backoff; a terminal
// 4xx is never retried (a malformed request will not get better). Each attempt
// is bounded by AbortSignal.timeout so a hung call cannot burn the Worker
// subrequest budget. Otherwise behavior is identical to the old per-call
// dispatchers: never throws, returns the normalized view or { ok:false, ... }.

// Default tunables. Three attempts total (two retries); 250ms base backoff
// doubling per attempt with full jitter; 30s per-attempt timeout.
const RUNPOD_MAX_ATTEMPTS = 3;
const RUNPOD_BACKOFF_BASE_MS = 250;
const RUNPOD_TIMEOUT_MS = 30_000;

// Injection seam for tests: the defaults bind the Worker globals. Tests pass a
// mock fetch + a no-op sleep (and a deterministic random) so the retry/backoff
// logic runs without real network or wall-clock delay. Also lets a caller tune
// attempts/timeout per call if it ever needs to.
export interface RunpodTransportOpts {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

/**
 * WHICH BACKEND ACTUALLY SERVED THE CALL (cf#475).
 *
 * A cast LoRA train can land on three different places -- the dedicated Wan training endpoint, the
 * homelab local door, or the cloud render endpoint -- and only two of those are RunPod GPU spend on
 * our account. Anything that records a RunPod job has to know which one it was.
 *
 * IT IS SET BY THE FUNCTION THAT MADE THE ROUTING CHOICE, AND NEVER RE-DERIVED BY A CALLER. Reading
 * the bindings a second time to work out where a job went is a second implementation of the routing
 * rule, which is cf#403 / cp#321 exactly: the two copies agree in the test and drift in production.
 * The submitter and the poller each know, at the moment they choose; they say so here.
 *
 * OPTIONAL ON PURPOSE, AND ABSENT MEANS DO NOT RECORD. Every other RunPod call site in the estate
 * (render submit, finalize, regen, cancel, the module workers driving runpodRequest directly) leaves
 * it undefined, and a recorder gated on a KNOWN backend therefore records nothing for a path nobody
 * has tagged. That is the safe default: a missing row is a gap someone can find, and a row invented
 * for a job that never ran on our account is a wrong number nobody can find.
 */
export type RunpodJobBackend = "runpod-wan-train" | "runpod-render" | "local-door";

export type RunpodResult =
  | { ok: true; view: RunpodJobView; backend?: RunpodJobBackend }
  | { ok: false; error: string; status?: number; backend?: RunpodJobBackend };

/** Stamp a result with the backend that produced it. Rebuilt field-by-field rather than spread, so
 *  the discriminated union survives and a future arm cannot be silently widened past it. */
function onBackend(result: RunpodResult, backend: RunpodJobBackend): RunpodResult {
  return result.ok
    ? { ok: true, view: result.view, backend }
    : { ok: false, error: result.error, status: result.status, backend };
}

interface RunpodRequestSpec {
  method: "GET" | "POST";
  url: string;
  // The route this URL was built from. Callers inside this file resolve it ONCE and pass it here,
  // so the base in `url` and the bearer in the headers can never come from two different reads of
  // the environment. Omitted by external callers (vivijure-cf drives this transport directly), in
  // which case it is resolved here and the URL is checked against it rather than trusted.
  route?: RunpodRoute;
  // Attribution only: becomes the plane's `x-vivijure-module` metering label on the proxied route
  // and is dropped on the direct route. Core does not invent a value for its own studio-side
  // submits -- the plane reads the header nullable -- so this exists for hosts and modules that
  // genuinely have a module name to assert.
  moduleName?: string;
  // JSON body for the POST submitters; omitted for cancel (POST, no body) and
  // poll (GET). Its presence also gates the content-type header.
  body?: string;
  // Error-message prefix, e.g. "submit", "finalize submit", "poll" -- preserves
  // the exact strings the old per-call dispatchers produced.
  label: string;
}

// 429 (rate limited) and 5xx (server error) are worth retrying; everything
// else (4xx) is the caller's fault and will not improve on retry.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with full jitter: a random point in [0, base * 2^(n-1)]
// for 1-based attempt n. Full jitter de-synchronizes a herd of retrying
// Workers better than a fixed delay.
function backoffDelayMs(attempt: number, baseMs: number, random: () => number): number {
  const ceil = baseMs * 2 ** (attempt - 1);
  return Math.floor(random() * ceil);
}

// The one transport every RunPod call goes through. Never throws: an env-config
// miss, a network/timeout error, a non-JSON body, or an HTTP error all come
// back as { ok:false, error, status? } for the route to translate. Retries a
// transient failure up to maxAttempts with jittered backoff; returns a terminal
// 4xx immediately.
export async function runpodRequest(
  env: Env,
  spec: RunpodRequestSpec,
  opts: RunpodTransportOpts = {},
): Promise<RunpodResult> {
  const route = spec.route ?? (await runpodRoute(env as RunpodRouteEnv));
  const credentialErr = runpodMissingCredential(route);
  if (credentialErr) return credentialErr;
  const originErr = runpodRouteOriginMismatch(route, spec.url);
  if (originErr) return originErr;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? RUNPOD_MAX_ATTEMPTS;
  const backoffBaseMs = opts.backoffBaseMs ?? RUNPOD_BACKOFF_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? RUNPOD_TIMEOUT_MS;

  const headers: Record<string, string> = runpodHeaders(route, spec.moduleName);
  if (spec.body !== undefined) headers["content-type"] = "application/json";

  // Carried across attempts so a final transient HTTP failure surfaces the
  // status the route maps to an HTTP code (not just a bare message).
  let lastTransientError = `RunPod ${spec.label} failed`;
  let lastTransientStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetchImpl(spec.url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or a per-attempt timeout (AbortSignal fires a
      // TimeoutError) -- both transient.
      const m = err instanceof Error ? err.message : String(err);
      lastTransientError = `RunPod ${spec.label} network error: ${m}`;
      lastTransientStatus = undefined;
      if (attempt < maxAttempts) {
        await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
        continue;
      }
      return { ok: false, error: lastTransientError };
    }

    // Retry a transient HTTP status (when attempts remain) without reading the
    // body. On the final attempt fall through so the real error envelope is
    // parsed and returned.
    if (!resp.ok && isTransientStatus(resp.status) && attempt < maxAttempts) {
      lastTransientError = `RunPod ${spec.label} failed: HTTP ${resp.status}`;
      lastTransientStatus = resp.status;
      await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
      continue;
    }

    let raw: unknown;
    try {
      raw = await resp.json();
    } catch {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `RunPod ${spec.label} returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
        status: resp.status,
      };
    }
    if (!resp.ok) {
      // OUR plane refusing is not RunPod failing, and only the header separates them (cp#288). A
      // proxy 502 -- the plane could not REACH RunPod -- deliberately carries no header and so
      // falls through to the vendor wording below, because relabelling a vendor hiccup as our
      // outage is a different wrong answer rather than a fix. Gated on `route.proxied` inside
      // planeRefusalReason, so a header arriving from api.runpod.ai can never change a
      // self-hoster's outcome.
      const refusal = planeRefusalReason(route, resp);
      if (refusal) {
        return {
          ok: false,
          error: planeRefusalError("vivijure-core", refusal, spec.label),
          status: resp.status,
        };
      }
      const errStr =
        raw && typeof raw === "object" && "error" in raw
          ? String((raw as Record<string, unknown>).error)
          : `HTTP ${resp.status}`;
      return { ok: false, error: `RunPod ${spec.label} failed: ${errStr}`, status: resp.status };
    }
    const view = normalizeRunpodResponse(raw);
    if (!view) {
      return { ok: false, error: `RunPod ${spec.label} returned an unrecognized envelope` };
    }
    return { ok: true, view };
  }

  // Unreachable in practice (the loop always returns on its last iteration);
  // present to satisfy the compiler and as a defensive fallback.
  return { ok: false, error: lastTransientError, status: lastTransientStatus };
}

// A missing RUNPOD_ENDPOINT_ID is a fail-closed config error, surfaced in the SAME { ok:false }
// shape as the transport RUNPOD_API_KEY guard so a route translates one contract. #238.
function runpodMissingEndpoint(): RunpodResult {
  return {
    ok: false,
    error: "RUNPOD_ENDPOINT_ID must be set on the Worker (Secrets Store binding or npx wrangler secret put)",
  };
}

/**
 * A missing CREDENTIAL, named as the binding this route actually reads.
 *
 * On the direct route this returns the exact sentence this file has always returned, because a
 * self-hoster's diagnostic must not change. On the proxied route naming RUNPOD_API_KEY would send
 * an operator hunting a key that MUST NOT exist on that Worker -- the noun comes from
 * runpodCredentialName so the two can never drift apart. Returns null when the credential is
 * present, so the call site reads as a guard rather than as a boolean.
 */
function runpodMissingCredential(route: RunpodRoute): RunpodResult | null {
  if (route.credential) return null;
  if (route.proxied) {
    return {
      ok: false,
      error:
        `${runpodCredentialName(route)} must be set on the Worker (the control plane installs it ` +
        `after upload; this Worker is proxied and must not hold a RunPod key)`,
    };
  }
  return {
    ok: false,
    error:
      `${runpodCredentialName(route)} must be set on the Worker (Secrets Store binding or npx wrangler secret put)`,
  };
}

/**
 * REFUSE a URL that does not belong to the route whose credential we are about to present.
 *
 * This is the one failure a route-carrying transport can have that nothing downstream would
 * report: a caller that built its URL against api.runpod.ai on a Worker whose environment is
 * proxied would send the PLANE token to RunPod. It fails closed and names the condition, rather
 * than producing a 401 from a vendor that the caller then reads as a credential problem.
 *
 * It cannot fire on the direct route with a URL from the builders above (same base, byte for
 * byte), which is why the existing external callers are unaffected -- and it is negative-tested
 * with a proxied route against a direct URL, because a guard nobody has watched refuse is not a
 * guard.
 */
function runpodRouteOriginMismatch(route: RunpodRoute, url: string): RunpodResult | null {
  if (url.startsWith(`${route.base}/`)) return null;
  return {
    ok: false,
    error:
      `RunPod route mismatch: this Worker resolves to ${route.proxied ? "the control-plane proxy" : "RunPod directly"} ` +
      `(${route.base}) and the request URL does not start there. Refusing rather than presenting ` +
      `this route's credential to another origin.`,
  };
}

/** Parse optional RUNPOD_WORKERS_MAX (cf#61 idle reconcile spec). Unset/invalid => skip reconcile. */
function parseWorkersMaxSpec(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

async function reconcileEndpointIfConfigured(
  env: Env,
  apiKey: string,
  endpointId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult | null> {
  const specRaw =
    (env as { RUNPOD_WORKERS_MAX?: unknown }).RUNPOD_WORKERS_MAX ??
    (env as { RUNPOD_ENDPOINT_WORKERS_MAX?: unknown }).RUNPOD_ENDPOINT_WORKERS_MAX;
  const resolved =
    specRaw instanceof Promise || (specRaw && typeof specRaw === "object" && "get" in (specRaw as object))
      ? await secretValue(specRaw as SecretsStoreSecret | string | undefined)
      : specRaw;
  const workersMax = parseWorkersMaxSpec(resolved);
  if (workersMax == null) return null;
  const rec = await reconcileRunpodEndpointWorkersMax({
    apiKey,
    endpointId,
    spec: { workersMax },
    fetchImpl: opts?.fetchImpl,
  });
  if (rec.ok) return null;
  const msg = rec.guidance ? `${rec.error}. ${rec.guidance}` : rec.error;
  return { ok: false, error: msg, status: rec.status };
}

async function submitToRunpodEndpoint(
  env: Env,
  endpointId: string,
  body: string,
  label: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const route = await runpodRoute(env as RunpodRouteEnv);
  const credentialErr = runpodMissingCredential(route);
  if (credentialErr) return credentialErr;
  // The workers-max reconcile is an ACCOUNT-level call to rest.runpod.io (see
  // runpod-endpoint-reconcile.ts), not one of the four verbs the plane proxy serves, and a
  // proxied tenant holds no RunPod key by design. Presenting the plane token to rest.runpod.io
  // would 401; routing it through the proxy is impossible because the proxy has no such verb --
  // deliberately, since endpoint configuration on a SHARED pool endpoint is ours to own and not a
  // tenant's to set. So it is SKIPPED, not attempted and swallowed, and the skip is silent
  // because there is nothing for a tenant operator to do about it.
  if (!route.proxied) {
    const reconcileErr = await reconcileEndpointIfConfigured(env, route.credential, endpointId, opts);
    if (reconcileErr) return reconcileErr;
  }
  return runpodRequest(
    env,
    { method: "POST", url: buildSubmitUrl(endpointId, route), body, label, route },
    opts,
  );
}

// Submit a job to the vivijure-serverless RunPod endpoint. Returns the
// normalized view or a transport error. Does not throw on HTTP 4xx / 5xx; the
// caller decides how to translate to a Worker response. Optional opts inject a
// mock transport in tests.
export async function submitRenderJob(
  env: Env,
  args: RenderSubmitArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) return runpodMissingEndpoint();
  return submitToRunpodEndpoint(
    env,
    endpointId,
    JSON.stringify(buildSubmitPayload(args)),
    "submit",
    opts,
  );
}

// v0.42.0: submit a finalize job. Same transport contract as submitRenderJob.
export async function submitFinalizeJob(
  env: Env,
  args: FinalizeArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) return runpodMissingEndpoint();
  return submitToRunpodEndpoint(
    env,
    endpointId,
    JSON.stringify(buildFinalizePayload(args)),
    "finalize submit",
    opts,
  );
}

// v0.41.0: submit a per-shot regen job. Hits the same /v2/<endpointId>/run;
// the GPU side dispatches by action.
export async function submitRegenShotJob(
  env: Env,
  args: RegenShotArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) return runpodMissingEndpoint();
  return submitToRunpodEndpoint(
    env,
    endpointId,
    JSON.stringify(buildRegenShotPayload(args)),
    "regen submit",
    opts,
  );
}

// ---------- Local-door SDXL train (homelab; no RunPod) ----------
//
// vivijure-local-12gb / 16gb accept action:train_lora on the same /run + /status
// surface as i2v_clip. Prefer LOCAL_BACKEND_URL when set so cast train stays on
// own silicon; fall back to RUNPOD_ENDPOINT_ID only when the door is not wired.

/** Strip trailing ASCII '/' without a regex (CodeQL: ReDoS on /\/+$/ over env input). */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/** Absolute http(s) door URL, no userinfo / metadata hosts. Null when unset/invalid. */
export function normalizeLocalBackendUrl(raw: string): string | null {
  const trimmed = stripTrailingSlashes(raw.trim());
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  let hostname = u.hostname.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "metadata.google.internal" || hostname.endsWith(".metadata.google.internal")) {
    return null;
  }
  if (hostname === "169.254.169.254" || hostname.startsWith("169.254.")) return null;
  if (u.pathname.includes("..")) return null;
  const path = u.pathname === "/" ? "" : stripTrailingSlashes(u.pathname);
  return `${u.protocol}//${u.host}${path}`;
}

export async function resolveLocalBackendUrl(env: Env): Promise<string | null> {
  const raw = await secretValue(
    (env as { LOCAL_BACKEND_URL?: unknown }).LOCAL_BACKEND_URL as
      SecretsStoreSecret | string | undefined,
  );
  return normalizeLocalBackendUrl(raw);
}

export async function resolveLocalBackendToken(env: Env): Promise<string> {
  return (
    await secretValue(
      (env as { LOCAL_BACKEND_TOKEN?: unknown }).LOCAL_BACKEND_TOKEN as
        SecretsStoreSecret | string | undefined,
    )
  ).trim();
}

export async function localDoorConfigured(env: Env): Promise<boolean> {
  return Boolean(await resolveLocalBackendUrl(env));
}

async function submitToLocalDoor(
  env: Env,
  body: string,
  label: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const baseUrl = await resolveLocalBackendUrl(env);
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "LOCAL_BACKEND_URL must be set (homelab door for SDXL cast train) or wire RUNPOD_ENDPOINT_ID",
    };
  }
  const token = await resolveLocalBackendToken(env);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? RUNPOD_TIMEOUT_MS;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const resp = await fetchImpl(`${baseUrl}/run`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let raw: unknown;
    try {
      raw = await resp.json();
    } catch {
      return {
        ok: false,
        error: `local-door ${label} returned non-JSON (HTTP ${resp.status})`,
        status: resp.status,
      };
    }
    if (!resp.ok) {
      const err =
        raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
          ? (raw as { error: string }).error
          : `local-door ${label} failed (HTTP ${resp.status})`;
      return { ok: false, error: err, status: resp.status };
    }
    const id =
      raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : "";
    if (!id || !isValidJobId(id)) {
      return { ok: false, error: `local-door ${label} returned no job id` };
    }
    // Door /run only returns { id }; status is IN_QUEUE until the serial worker picks it up.
    return {
      ok: true,
      view: { jobId: id, status: "IN_QUEUE", statusRaw: "IN_QUEUE" },
    };
  } catch (e) {
    return {
      ok: false,
      error: `local-door ${label} transport failed: ${(e as Error).message}`,
    };
  }
}

export async function pollLocalDoorJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  if (!isValidJobId(jobId)) {
    return { ok: false, error: "invalid job id", status: 400 };
  }
  const baseUrl = await resolveLocalBackendUrl(env);
  if (!baseUrl) {
    return { ok: false, error: "LOCAL_BACKEND_URL not configured", status: 404 };
  }
  const token = await resolveLocalBackendToken(env);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? RUNPOD_TIMEOUT_MS;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const resp = await fetchImpl(`${baseUrl}/status/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let raw: unknown;
    try {
      raw = await resp.json();
    } catch {
      return {
        ok: false,
        error: `local-door poll returned non-JSON (HTTP ${resp.status})`,
        status: resp.status,
      };
    }
    if (resp.status === 404) {
      return { ok: false, error: "local-door job not found", status: 404 };
    }
    if (!resp.ok) {
      const err =
        raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
          ? (raw as { error: string }).error
          : `local-door poll failed (HTTP ${resp.status})`;
      return { ok: false, error: err, status: resp.status };
    }
    // Door status envelope is RunPod-compatible: { id, status, output?, error? }.
    const view = normalizeRunpodResponse(raw);
    if (!view) {
      return { ok: false, error: "local-door poll returned unparseable status envelope" };
    }
    return { ok: true, view };
  } catch (e) {
    return {
      ok: false,
      error: `local-door poll transport failed: ${(e as Error).message}`,
    };
  }
}

// v0.57.0: submit a standalone LoRA training job. Prefers the local door when
// LOCAL_BACKEND_URL is set (homelab SDXL train on own silicon); otherwise the
// RunPod render endpoint.
export async function submitTrainLoraJob(
  env: Env,
  args: TrainLoraArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const body = JSON.stringify(buildTrainLoraPayload(args));
  if (await localDoorConfigured(env)) {
    return onBackend(await submitToLocalDoor(env, body, "train-lora submit", opts), "local-door");
  }
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) {
    return {
      ok: false,
      error:
        "SDXL cast train needs LOCAL_BACKEND_URL (homelab door) or RUNPOD_ENDPOINT_ID (cloud render EP)",
    };
  }
  return onBackend(
    await submitToRunpodEndpoint(env, endpointId, body, "train-lora submit", opts),
    "runpod-render",
  );
}

// Submit a Wan 2.2 A14B LoRA training job to the DEDICATED Wan-training endpoint (the lead's
// deploy-shape call, cf#29): its 80GB-card GPU-hours are isolated from the render endpoint's
// billing, and the training card class is decoupled from render. Differs from submitTrainLoraJob
// only in the endpoint binding (RUNPOD_WAN_TRAIN_ENDPOINT_ID) and the model_family:"wan" payload.
export async function submitTrainWanLoraJob(
  env: Env,
  args: TrainLoraArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(
    (env as { RUNPOD_WAN_TRAIN_ENDPOINT_ID?: unknown }).RUNPOD_WAN_TRAIN_ENDPOINT_ID as
      SecretsStoreSecret | string | undefined,
  );
  if (!endpointId) return runpodMissingWanEndpoint();
  // Env is authoritative: hosted studio has R2_S3_* so the block is present;
  // operator studio without those vars omits it (dedicated EP / env R2).
  const r2 = await tenantR2FromEnv(env);
  const { r2: _ignored, ...rest } = args;
  return onBackend(
    await submitToRunpodEndpoint(
      env,
      endpointId,
      JSON.stringify(buildTrainWanLoraPayload(r2 ? { ...rest, r2 } : rest)),
      "train-wan-lora submit",
      opts,
    ),
    "runpod-wan-train",
  );
}

function runpodMissingWanEndpoint(): RunpodResult {
  return {
    ok: false,
    error:
      "RUNPOD_WAN_TRAIN_ENDPOINT_ID must be set on the Worker (the dedicated Wan-training endpoint; " +
      "Secrets Store binding or npx wrangler secret put)",
  };
}

// Cancel one job. RunPod's cancel endpoint is POST /v2/<id>/cancel/<job>; we
// expose it under our DELETE /api/storyboard/render/<jobId> route. Calling
// cancel on a job that is already terminal (or never existed) returns RunPod's
// error envelope, which we surface verbatim.
export async function cancelRenderJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) return runpodMissingEndpoint();
  const route = await runpodRoute(env as RunpodRouteEnv);
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildCancelUrl(endpointId, jobId, route),
      label: "cancel",
      route,
    },
    opts,
  );
}

// Poll one job on a specific RunPod endpoint (shared by render + Wan-train status checks).
export async function pollRunpodJob(
  env: Env,
  endpointId: string,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const route = await runpodRoute(env as RunpodRouteEnv);
  return runpodRequest(
    env,
    {
      method: "GET",
      url: buildStatusUrl(endpointId, jobId, route),
      label: "poll",
      route,
    },
    opts,
  );
}

// Poll one job's status on the render endpoint.
export async function pollRenderJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) return runpodMissingEndpoint();
  return pollRunpodJob(env, endpointId, jobId, opts);
}

// Merge Wan-train + render poll results for cast LoRA status. Exported for unit tests.
export function mergeCastLoraPollResults(
  wanPoll: RunpodResult | undefined,
  renderPoll: RunpodResult,
): RunpodResult {
  if (wanPoll?.ok) return wanPoll;
  if (wanPoll && !wanPoll.ok && wanPoll.status !== 404) return wanPoll;
  return renderPoll;
}

// Poll a cast LoRA training job. Order:
//   1. Wan train EP (when wired) -- dual-expert A14B jobs live only there
//   2. Local door (when LOCAL_BACKEND_URL wired) -- homelab SDXL train
//   3. RunPod render EP -- cloud SDXL train
// Job ids are scoped per backend, so a 404 means "not this backend" and we fall through.
// Any non-404 from a tried backend is authoritative.
export async function pollCastLoraJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  const wanEndpointId = await secretValue(
    (env as { RUNPOD_WAN_TRAIN_ENDPOINT_ID?: unknown }).RUNPOD_WAN_TRAIN_ENDPOINT_ID as
      SecretsStoreSecret | string | undefined,
  );
  let wanPoll: RunpodResult | undefined;
  if (wanEndpointId) {
    wanPoll = onBackend(await pollRunpodJob(env, wanEndpointId, jobId, opts), "runpod-wan-train");
    if (wanPoll.ok) return wanPoll;
    if (wanPoll.status !== 404) return wanPoll;
  }

  let localPoll: RunpodResult | undefined;
  if (await localDoorConfigured(env)) {
    localPoll = onBackend(await pollLocalDoorJob(env, jobId, opts), "local-door");
    if (localPoll.ok) return localPoll;
    if (localPoll.status !== 404) return localPoll;
  }

  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID as SecretsStoreSecret | string | undefined);
  if (!endpointId) {
    // No cloud render EP: surface local 404 (or wan) rather than "missing endpoint" if we tried door.
    if (localPoll) return localPoll;
    if (wanPoll) return wanPoll;
    return runpodMissingEndpoint();
  }
  const renderPoll = onBackend(await pollRenderJob(env, jobId, opts), "runpod-render");
  return mergeCastLoraPollResults(wanPoll ?? localPoll, renderPoll);
}

// ---------- Audio beat-sync (CPU Cloudflare Container) ----------
//
// Beat analysis runs on the AUDIO_BEAT_SYNC container (librosa), called
// synchronously from src/index.ts handleAudioAnalyze; the GPU pod
// `analyze_audio` action was reverted in vivijure-serverless 0.4.60. These
// types + parseAudioBeatPlan are shared: the request shape the route validates,
// and the snake_case plan the container emits (normalized to camelCase here).
// See docs/containers.md.

// Worker-facing request (camelCase); the route handler builds the container
// body from this. Defaults below are applied at the call site / in the
// container, not here.
export interface AudioAnalyzeRequest {
  audioKey: string;                    // required; R2 key
  clipSeconds?: number;                // default 8.0
  mode?: "beat" | "duration";          // default "beat"
  minSceneS?: number;                  // default 2.5 (beat mode)
  maxSceneS?: number;                  // default 12.0 (beat mode)
  forceShots?: number;                 // duration mode only; override slice count
}

export interface TimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}

export interface AudioBeatPlan {
  mode: "beat" | "duration";
  audioKey: string;
  durationSeconds: number;
  bpm?: number;                        // beat mode only
  beatCount?: number;                  // beat mode only
  suggestedShots: number;
  clipSeconds: number;
  filmSeconds: number;
  remainderSeconds: number;
  timedScenes: TimedScene[];
  note: string;
}

// Pod returns snake_case; normalize to the camelCase Worker shape. Returns
// null on a shape that is not a recognizable beat plan (no valid `mode`).
export function parseAudioBeatPlan(raw: unknown): AudioBeatPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "beat" || r.mode === "duration" ? r.mode : null;
  if (!mode) return null;
  return {
    mode,
    audioKey: String(r.audio_key ?? ""),
    durationSeconds: Number(r.duration_seconds ?? 0),
    bpm: typeof r.bpm === "number" ? r.bpm : undefined,
    beatCount: typeof r.beat_count === "number" ? r.beat_count : undefined,
    suggestedShots: Number(r.suggested_shots ?? 0),
    clipSeconds: Number(r.clip_seconds ?? 0),
    filmSeconds: Number(r.film_seconds ?? 0),
    remainderSeconds: Number(r.remainder_seconds ?? 0),
    timedScenes: Array.isArray(r.timed_scenes)
      ? r.timed_scenes
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            index: Number(s.index ?? 0),
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            targetSeconds: Number(s.target_seconds ?? 0),
          }))
      : [],
    note: String(r.note ?? ""),
  };
}
