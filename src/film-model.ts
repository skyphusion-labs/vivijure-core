// Film model: the PURE half of the film orchestrator (S6 god-file split). Everything here is
// data shapes + synchronous logic with NO Env and NO I/O -- the doc-key builders, phase/summary
// projections, finish-step retry/adoption/convention logic, assemble transport classification,
// master-chain state helpers, and the stall math. The orchestrator (film-orchestrator.ts) owns
// every await; it re-exports this module, so importers and tests keep their one entry point.

import type { ConfigSchema, DialogueLine, FinishOutput, HookSelection, MasterOutput, RegisteredModule, SpeechOutput } from "./modules/types.js";
import { validateConfig } from "./modules/registry.js";
import { summarizeJob, type ClipJob, type JobSummary } from "./clip-job-model.js";
import { classifyTransientFailure } from "./render-orchestrator.js";
import { coerceShotId } from "./storyboard-ids.js";
import { defaultFilmOutputKey } from "./film-output-key.js";
import { voiceLockHint } from "./voices.js";
import { assertProjectKey } from "./key-safety.js";

/** Defense-in-depth cap on look/voice lock fields prepended to every motion prompt. */
export const MOTION_LOCK_FIELD_MAX_CHARS = 500;

function clipLockField(s: string): string {
  return s.length <= MOTION_LOCK_FIELD_MAX_CHARS ? s : s.slice(0, MOTION_LOCK_FIELD_MAX_CHARS);
}

export interface FilmScene { shot_id: string; prompt: string; seconds: number; }

/** Same look + same speaker on every motion call. Native AV (Flux/Seedance)
 *  invents a new voice per shot unless this is prepended. */
export function composeMotionPrompt(
  scenePrompt: string,
  lock: { style_prefix?: string; voice_lock?: string; spoken_line?: string; speaker?: string },
): string {
  const parts: string[] = [];
  const style = clipLockField((lock.style_prefix || "").trim());
  const voice = clipLockField((lock.voice_lock || "").trim());
  if (style) parts.push(style);
  if (voice) {
    parts.push(
      "VOCAL IDENTITY LOCK (every shot of this film): " + voice
      + " Same speaker, same timbre, same accent, same cadence. Do not invent a new voice. Do not change age or gender.",
    );
  }
  const line = clipLockField((lock.spoken_line || "").trim());
  if (line) {
    const who = clipLockField((lock.speaker || "").trim());
    parts.push(who
      ? "SPOKEN LINE (" + who + "): \"" + line + "\" Say these words. Do not invent other dialogue."
      : "SPOKEN LINE: \"" + line + "\" Say these words. Do not invent other dialogue.");
  }
  const scene = (scenePrompt || "").trim();
  if (scene) parts.push(scene);
  return parts.join(" ");
}

/** Storyboard line for one shot, for composeMotionPrompt. Speaker is the
 *  Cast voice lock hint when we have a voice_id. */
export function spokenLineForShot(
  lines: DialogueLine[] | undefined,
  shotId: string,
): { spoken_line?: string; speaker?: string } {
  const line = (lines || []).find((l) => l.shot_id === shotId && (l.text || "").trim());
  if (!line) return {};
  const hint = voiceLockHint(line.voice_id);
  return { spoken_line: line.text.trim(), speaker: hint || undefined };
}

export interface VoiceLockSpeaker {
  name: string;
  voice_id?: string | null;
}

/** Build the film-level lock from Cast speakers + optional free-text.
 *  Empty speakers and empty extra -> empty string (caller must refuse
 *  native AV rather than invent a speaker). */
export function buildVoiceLock(speakers: VoiceLockSpeaker[], extra?: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of speakers || []) {
    const name = (s.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = voiceLockHint(s.voice_id);
    lines.push(hint
      ? name + ": " + hint + ". Same speaker every shot."
      : name + ": same speaking voice every shot.");
  }
  const extraT = (extra || "").trim();
  if (extraT && !lines.some((l) => l === extraT)) lines.push(extraT);
  if (seen.size > 1) {
    lines.push("When a named character speaks, use only that character's locked voice. Never invent a new speaker.");
  }
  return clipLockField(lines.join(" "));
}

/** Film-level lock from resolveCastLoras maps. Extra (planner textarea) wins
 *  as an add-on, never a replacement of the named speakers. */
export function voiceLockFromCast(
  speakerNames: Record<string, string> | undefined,
  voices: Record<string, string> | undefined,
  extra?: string,
): string {
  const speakers: VoiceLockSpeaker[] = Object.entries(speakerNames || {}).map(([slot, name]) => ({
    name,
    voice_id: voices?.[slot],
  }));
  return buildVoiceLock(speakers, extra);
}

/** Deterministic seed from the lock so Seedance (and any door with a
 *  seed knob) does not roll a new speaker per shot. -1 = no lock. */
export function seedFromVoiceLock(lock: string | undefined): number {
  const s = (lock || "").trim();
  if (!s) return -1;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = h >>> 0;
  return n === 0 ? 1 : n;
}

/** Pin motion_config.seed from the voice lock when the caller left it
 *  unset or at -1 (random). Unknown-schema doors drop the key later. */
export function applyVoiceSeed(
  config: Record<string, unknown> | undefined,
  lock: string | undefined,
): Record<string, unknown> | undefined {
  const seed = seedFromVoiceLock(lock);
  if (seed < 0) return config;
  const cfg = { ...(config || {}) };
  const existing = cfg.seed;
  if (existing === undefined || existing === -1 || existing === "") {
    cfg.seed = seed;
  }
  return cfg;
}

/** One clip moving through the `finish` chain (post-clips). `chain` is the finish module bindings in
 *  ui.order; `idx` walks through them, each consuming the previous module's output clip. `configs` is
 *  the validated config for each chain step (parallel to `chain`), so each module gets its
 *  config_schema defaults -- without it a module receives `{}` and no-ops (see issue #75). */
/** #662: one finish CHAIN STEP's honest outcome, recorded as the step resolves. `binding` is the chain
 *  ref (chain[idx]); `tags` is what the step contributed to the output clip (the module's applied markers
 *  on a run, the reconstructed marker on a reuse); `reused` is true when the step was adopted from an R2
 *  artifact (#583) rather than run this pass. The ordered list of these reconciles 1:1 to the shot chain. */
export interface FinishStepRecord { binding: string; tags: string[]; reused: boolean; }

export interface FinishShot {
  shot_id: string;
  clip_key: string;   // current clip key (updated as each finish module completes)
  chain: string[];    // finish module transport refs (MODULE_* service or dispatch:<script>), in ui.order
  configs?: Record<string, unknown>[]; // validated config per chain step, parallel to `chain`
  idx: number;
  status: "pending" | "done" | "failed";
  poll?: string;
  applied: string[];
  // #583 honesty: the step markers this shot REUSED from R2 this pass (adopted, NOT run this pass).
  // Parallel to `applied` (steps actually RUN this pass); the union is the transforms present in the
  // output clip. An adopted step never fabricates an `applied`-run tag -- the reuse is disclosed here.
  adopted?: string[];
  // #662 honesty reconciliation: ONE record per chain step as it resolves (run OR reused-from-R2), in
  // chain order. For a `done` shot ledger.length === chain.length and ledger[i].binding === chain[i], so
  // the per-shot ledger reconciles 1:1 to the chain. A reused step is PRESENT here (reused:true), never
  // dropped -- so reading the ledger never looks like a missing step the way `applied` alone can (a reused
  // step's tag lives in `adopted`, not `applied`). Optional: pre-#662 job docs predate it.
  ledger?: FinishStepRecord[];
  error?: string;
  // Transient-retry counter for the CURRENT chain step (reset when the step advances). A transient
  // invocation blip (the module worker momentarily unreachable / 5xx -- the musetalk cold-start race
  // that silenced shot_02) re-dispatches the step up to FINISH_STEP_MAX_ATTEMPTS instead of going
  // failed; a deterministic reject or the cap exhausted fails loud. Mirrors scatter assemble_attempts.
  attempts?: number;
  // #226: per-step FinishOutput.degraded reasons, in chain order. The tag on `applied` is often the
  // generic `passthrough:backend-soft-degrade`; this is the field that tells "no face" from
  // "door timed out". Optional: job docs written before #226 have only the tag.
  degraded?: string[];
}

/** One shot's dialogue audio moving through the `speech` chain (post-dialogue, pre-finish). `chain` is
 *  the speech module bindings in ui.order; `idx` walks them, each consuming the previous module's
 *  enhanced audio. `configs` is the validated config per step (parallel to `chain`). Mirrors FinishShot,
 *  but threads AUDIO (audio_key) instead of the video clip. A speech step is a POLISH step: a hard
 *  failure DEGRADES the shot (keeps its current audio) rather than failing the render. */
export interface SpeechShot {
  shot_id: string;
  audio_key: string;   // current dialogue-audio key (updated as each speech module completes)
  chain: string[];     // speech module transport refs (MODULE_* service or dispatch:<script>), in ui.order
  configs?: Record<string, unknown>[];
  idx: number;
  status: "pending" | "done" | "failed";
  poll?: string;
  applied: string[];
  degraded?: string;   // last soft-degrade reason on this shot (honest, never a fake applied tag)
  error?: string;
  attempts?: number;   // transient-retry counter for the current step (reset on advance)
}

export interface FilmKeyframeRef {
  shot_id: string;
  keyframe_key: string;
}

export interface FilmJob {
  /** cf#507b: THE DELIVERY TARGET for this film -- a DECISION, not a measurement.
   *
   *  Absent today on every job: populated from DEFAULT_DELIVERY_WIDTH/HEIGHT via
   *  resolveDeliveryResolution, which reports `decided:false` for that case so a consumer can tell
   *  a defaulted target from a chosen one. The field exists now so a per-film or per-tier target
   *  later is a populate-it-differently change rather than a contract change.
   *
   *  NOT to be confused with ClipShot.delivered_width/height, which are a MEASUREMENT of what the
   *  motion/finish chain produced and whose only job is choosing an upscale factor. Threading the
   *  measurement where this decision belongs assembles the film at the clips' size, which is the
   *  opposite of the 1080p ruling. */
  delivery_width?: number;
  delivery_height?: number;
  delivery_fps?: number;
  /** cf#518: RESPONSE-ONLY. Set to `true` on the job a submit gets back when that submit was
   *  DEDUPLICATED against a live claim -- i.e. the caller's inputs matched an in-flight submit
   *  inside the idempotency window and no second film was started.
   *
   *  NON-OPTIONAL by ruling, and the reason is worth keeping at the field: a 201-that-is-really-a-200
   *  with no marker is an absence rendering as a value. Without it the caller cannot distinguish
   *  "your film started" from "you got an existing film's id", and neither can a log, a test, or a
   *  load test counting submissions.
   *
   *  NEVER PERSISTED, and that is structural rather than a convention: the only code that sets it is
   *  the dedup return path, which reads the existing doc and writes nothing at all. There is no path
   *  on which a job carrying this field reaches putFilm. A test asserts the persisted docs never
   *  carry it. */
  deduplicated?: true;
  film_id: string;
  project: string;
  bundle_key: string;
  scenes: FilmScene[];
  style_prefix?: string;
  voice_lock?: string;
  motion_backend: string | null;
  motion_config: Record<string, unknown>;
  // cf#393: RESOLVED keyframe module name at submit (e.g. "keyframe", "cloud-keyframe"). Distinct from
  // keyframe_binding (service-binding id). Absent on legacy job docs and on from-keyframes jobs that
  // never ran a keyframe module. Mirrored onto the renders row so "which keyframe backend?" is answerable.
  keyframe_backend?: string | null;
  // #767: the validated keyframe config, persisted so the R2-presence keyframe reclaim can fingerprint
  // (keyframeProvenanceHash) which config produced a keyframe and refuse to adopt one a DIFFERENT-config
  // render of the same project wrote. Backend-agnostic (SDXL), so the motion backend is NOT part of it --
  // two renders that differ only in motion backend legitimately share keyframes. Absent on legacy job docs.
  keyframe_config?: Record<string, unknown>;
  finish_config: Record<string, Record<string, unknown>>; // per finish module (keyed by module name), validated at enterFinishPhase
  // cf#537: the caller's per-render finish participation. ABSENT on every legacy job doc and on any
  // caller that sends none, which resolves to the default-participation set (every serving finish
  // module that does not declare participation:"opt_in"). Its own field, NEVER derived from
  // finish_config -- a Record cannot tell "no config" from "not requested" after a JSON round trip.
  finish_select?: HookSelection;
  speech_config?: Record<string, Record<string, unknown>>; // per speech module (keyed by module name), validated at enterSpeechOrFinish
  film_finish_config?: Record<string, Record<string, unknown>>; // per film.finish module (by name), validated in applyFilmFinish
  master_config?: Record<string, Record<string, unknown>>; // per master module (by name), validated at enterMasterOrMux
  keyframe_binding: string | null;
  phase: "keyframe" | "clips" | "dialogue" | "speech" | "finish" | "assemble" | "master" | "mux" | "done" | "failed";
  keyframe_poll?: string;
  // The keyframe module's backend RunPod job id (#318), surfaced on its async-accept envelope. Lets
  // the poll handler read that job's progress snapshot (counts.keyframe_done) for keyframe sub-progress.
  keyframe_job_id?: string;
  // cf#307: last module `/poll` wait phase while keyframe is still pending. Backend-neutral
  // (`accepted` = not started / cold start; `running` = compute underway). Absent when the module
  // does not report wait (pre-cf#307 modules) -- host must not invent a queue state.
  keyframe_wait?: "accepted" | "running";
  clip_job_id?: string;
  finish_shots?: FinishShot[];
  speech_shots?: SpeechShot[]; // per-shot speech (dialogue-audio enhance) chain, run between dialogue and finish
  // Talking characters: per-shot dialogue lines (resolved at submission: authored text + cast voice),
  // synthesized to per-shot audio by the `dialogue` module in a phase between clips and finish. The
  // resulting audio_key per shot is injected into that shot's FinishInput for lip-sync. Absent/empty
  // => a silent film (no dialogue phase). dialogue_poll holds the in-flight batch job's poll token.
  dialogue_lines?: DialogueLine[];
  dialogue_poll?: string;
  dialogue_audio?: Record<string, string>; // shot_id -> dialogue audio R2 key
  // slot -> cast_member id (from the render's castLoras). At keyframe completion the orchestrator
  // banks any freshly-trained adapter back onto the cast member (markLoraReady) so a character's LoRA
  // is trained ONCE and reused across every project -- instead of retrained every render. (#xxx)
  cast_loras?: Record<string, number>;
  // #762: the render's requested quality tier (draft/standard/final), carried so the renders-table
  // row LABEL is honest. Absent -> the row defaults "final". The ACTUAL render tier rides the baked
  // keyframe_config.quality_tier + motion_config, not this field.
  quality_tier?: "draft" | "standard" | "final";
  film_key?: string; // R2 key of the assembled film (mp4), set when phase reaches "done"
  silent_film_key?: string; // silent concat output before optional audio mux
  // #697/#698: ACTUAL per-shot assembled clip seconds, probed by the video-finish container at assemble
  // and mapped onto shot_id (finalClips order). Drives the per-shot duration honesty gate (#697) at
  // assemble and, persisted here, the caption-cue timeline (#698) in the later film.finish chain -- one
  // probe, both uses. Absent when the container reported none (older build): the gate no-ops and captions
  // fall back to the bundle plan.
  actual_clip_durations?: Record<string, number>;
  audio_key?: string; // staged R2_RENDERS audio bed to mux after assemble (the `master` chain polishes
                      // THIS key in place: each master step rewrites it to the mastered bed before mux)
  // Film-level audio mastering (the `master` chain): polish the assembled film's audio BED -- music
  // upscale (soxr) + LUFS loudness -- AFTER the mix is built (assemble) and BEFORE the final mux. Set
  // only when there IS an audio_key AND a master module is installed; absent => the bed is muxed as-is.
  // FAIL-SAFE, like film.finish: a step that fails / degrades passes the CURRENT bed through (records a
  // reason in `degraded`), never failing the render -- a polish miss must never drop a fully-rendered
  // film (the #249 / #77 discipline). `chain` is the master module bindings in ui.order; `idx` walks
  // them; `poll` holds the in-flight step's token; `attempts` is its bounded transient-retry counter.
  master?: {
    chain: string[];     // master module transport refs (MODULE_* service or dispatch:<script>), in ui.order
    idx: number;         // current chain step
    poll?: string;       // in-flight step poll token
    attempts?: number;   // transient-retry counter for the CURRENT step (reset when the step advances)
    applied: string[];   // accumulated applied tags across the chain (e.g. ["music-upscale:soxr48k"])
    degraded: string[];  // per-step soft-degrade reasons ("<binding>: <reason>"); a passthrough is never silent
    configs?: Record<string, unknown>[]; // per-step clamped planner config, aligned to `chain` order (enterMasterOrMux)
  };
  // Opening title + end-credit text for the film.finish chain (title / credit cards). Absent -> no
  // cards; the film.finish module passes the film through unchanged. (#190)
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  // Observable outcome of the film.finish chain (title / credit cards). The chain is FAIL-SAFE -- the
  // assembled film always survives -- so a degraded run (e.g. the video-finish container unreachable)
  // still reaches phase="done", just WITHOUT cards. Recording the outcome makes that observable instead
  // of a silent green: which modules ran, any chain errors, the per-step detail, and a `degraded` reason
  // set when cards were requested but could not be applied. (#207 follow-up)
  film_finish?: {
    applied: string[];   // module names whose invoke returned ok (ChainResult.applied)
    errors: string[];    // chain-level errors: a skipped (unbound) or failed (ok:false) module
    steps?: string[];    // last output detail: ["film-titles"] applied, or ["passthrough:..."]/["noop:no-cards"] degraded
    degraded?: string;   // set when the film was passed through UNCARDED; the reason (cards NOT applied)
    // #600: film.finish steps write DETERMINISTIC per-step keys (renders/<film>-ff<n>.mp4), so a step
    // that completed inside a request that then timed out is ADOPTED from R2 on the next tick instead of
    // re-encoded. Before this the keys were random per attempt, so a big film re-burned ~8 min of
    // media-stack CPU every cron tick and never finished. R2 presence IS the persisted progress
    // (#122/#141); the existing idempotent assemble re-entry drives the per-tick resume.
    adopted?: string[];  // steps folded from a pre-existing R2 artifact (reuse, never a fake applied run, #583)
    // #663: R2 key of the FINAL .srt subtitle sidecar (re-timed for any title-card prepend, named next to
    // the final film). Surfaced on FilmSummary so the sidecar is discoverable via the API, not only by key
    // convention. Absent when no sidecar was written (burn-only, or a silent / dialogue-free film).
    sidecar_key?: string;
  };
  // #600 in-flight guard: deterministic film.finish step key -> the ts it was dispatched (persisted
  // BEFORE the dispatch, crash-safe). A step still inside the in-flight window (key not yet in R2) is
  // NOT re-dispatched, so a killed leaseholder + the 300s advance-lease TTL (shorter than an ~8-min
  // encode) + the fail-open advance path cannot fire a DUPLICATE encode of the same step each tick.
  film_finish_dispatched?: Record<string, number>;
  // #602 async job+poll: a film.finish module can return { pending, poll } when its work outlasts a
  // request budget (a long subtitle burn / card concat). The core drives submit+poll ACROSS TICKS with
  // the persisted token, so no single request holds the encode open. film_finish_polls maps the step`s
  // deterministic output key -> that step`s in-flight module poll token; film_finish_attempts counts a
  // step`s TERMINAL poll/submit failures, bounding re-dispatch before the step soft-degrades (ships the
  // film UNCARDED, #190 fail-safe -- a card miss never fails a fully-rendered film). R2 presence at the
  // step key stays authoritative on completion (adopt), exactly as the #600 synchronous path.
  film_finish_polls?: Record<string, string>;
  film_finish_attempts?: Record<string, number>;
  // #663: deterministic film.finish step key -> seconds a title card prepended at that step. Persisted so
  // the post-chain .srt sidecar re-time recovers the offset even when the prepending step is adopted (not
  // re-folded) on a later poll tick.
  film_finish_prepend?: Record<string, number>;
  // Film ARTIFACT KEY -> the ffprobe-measured seconds of that artifact. Written by every stage that
  // produces a film (assemble, mux, each film.finish step), so the length of the DELIVERED film is
  // simply the entry for the final film_key -- "we bill on the last writer" (Conrad, 2026-08-02)
  // expressed structurally instead of as an ordering rule someone has to remember. Persisted for the
  // same reason film_finish_prepend is: a step that is ADOPTED on a later tick (its artifact already
  // in R2, #600) is never re-folded, so a value read only from a live dispatch result is lost exactly
  // on the films that took long enough to span ticks -- i.e. the expensive ones.
  film_output_seconds?: Record<string, number>;
  // cf#268: running sum of CPU finish container wall-clock ms (assemble, mux, mix, film.finish, ...)
  // observed on this job. Written once to renders.finish_elapsed_ms at markFinishDone. Capacity
  // planning only -- not billing, not GPU time. Absent => not measured on any step.
  finish_elapsed_ms?: number;
  // Loud, structured degrade when the video-finish tier (VIDEO_FINISH_URL) is UNAVAILABLE at
  // assemble/mux -- the URL is unset, or the container/tunnel was unreachable after the bounded
  // retry. The film COMPLETES (never hard-fails after the GPU spend, #519) delivering what was rendered:
  // the per-shot clips (assemble degrade, no single concatenated film) or the SILENT assembled film (mux
  // degrade, the audio bed could not be muxed). This is the UNAVAILABILITY path ONLY; a genuine per-shot
  // finish / container ERROR (the container ran and reported a real failure) still fails the render loud
  // (#245/#249). Surfaced on FilmSummary + a `film.finish_unavailable` structured event so the UI and
  // smoke tests can assert on it, never a silent green.
  finish_unavailable?: {
    at: "assemble" | "mux";      // which delegated step could not run
    reason: string;              // the honest cause (VIDEO_FINISH_URL unset, or unreachable-after-retry)
    delivered: "clips" | "silent_film"; // what shipped instead of the finished film
    clips?: { shot_id: string; clip_key: string }[]; // per-shot clips (assemble degrade), the deliverable
  };
  // Loud, structured degrade when the keyframe stall recovery hit the phase ceiling with only a
  // PARTIAL keyframe set in R2 (#619): keyframes upload progressively, so a stall mid-batch leaves
  // some scenes unrendered. Below the ceiling the recovery HOLDS for the rest; at the ceiling it
  // advances delivering the scenes that DID render, but records the drop here so the film NEVER
  // reports a clean complete over the rebased (smaller) shot total. Surfaced on FilmSummary + the
  // poll view + a `film.keyframes_incomplete` structured event (#245/#249). Absent on a normal render
  // (a full set, or a below-ceiling partial that simply waits for the rest).
  keyframes_incomplete?: {
    adopted: number;    // scenes whose keyframe landed in R2 and were carried forward
    expected: number;   // scenes the storyboard asked for
    dropped: string[];  // shot_ids with no keyframe at the ceiling (never rendered)
  };
  mux_output_key?: string; // deterministic mux destination for idempotent retries
  mix_audio_key?: string; // #231: multi-track mixed audio (dialogue + ducked music + loudnorm) destination
  mux_attempts?: number;
  // keyframes-only preview: stop after the keyframe module, no i2v / assemble.
  keyframes_only?: boolean;
  /** Scatter shard: stop after finish (per-shot clips in R2), skip assemble. */
  clips_only?: boolean;
  keyframes?: FilmKeyframeRef[];
  cancelled?: boolean;
  /** Child animation from a keyframes-only preview (finalize / cloud / hybrid). */
  derive_mode?: "finalized" | "cloud-finalized";
  parent_render_id?: number;
  // Bounded counter for transient assemble retries (issue #82). A cold or slow video-finish concat can
  // 504 (or be briefly unreachable) on the last CPU-only step; rather than failing a fully-rendered
  // film, enterAssemblePhase keeps phase="assemble" so the next poll re-attempts (the re-PUT to the same
  // film key is idempotent), capped by MAX_ASSEMBLE_ATTEMPTS. Absent on pre-#82 jobs (reads as 0).
  assemble_attempts?: number;
  // Async /finish job token (jobId + streak). A 17-shot concat outlives the
  // Worker fetch; the next poll tick reads this instead of re-POSTing /finish.
  assemble_poll?: string;
  // Wall-clock the job entered its CURRENT phase (issue #129). advanceFilmJob stamps this on every
  // phase transition; the stall recovery measures how long a pollable phase has been stuck against it.
  // Absent on pre-#129 jobs -> recovery falls back to created_at (still bounded, just more generous).
  phase_started_at?: number;
  // Set once the keyframe stall recovery has adopted orphaned keyframes from R2, so the (idempotent)
  // adoption is never retried in a loop -- after one adoption the job has moved to clips anyway.
  keyframe_recovered?: boolean;
  // Set once the clips stall recovery has adopted orphaned clips from R2 (issue #139). Same idea as
  // keyframe_recovered: the motion.backend (own-gpu) poll can return pending forever on a GC'd RunPod
  // job while the finished clip already sits in R2; recovery collects them by shot name and advances.
  clips_recovered?: boolean;
  // Wall-clock of the last REAL per-shot progress (#136): re-stamped by advanceFilmJob when the
  // current phase's done-count advances (a clip/finish/speech shot completed) OR on a phase
  // transition. The UI stall signal measures against THIS, not phase_started_at, so a healthy
  // multi-shot clips/finish phase (10 i2v shots at ~3min each = 30+min in ONE phase) no longer
  // false-trips "stalled". The driver's recovery still measures from phase_started_at (unchanged).
  last_progress_at?: number;
  /** core#182 honesty: chain steps in the CURRENT phase whose module declares no
   *  `max_invocation_seconds`, so the core could not size the stall ceiling to them and is holding
   *  the floor. Carried on the job (not merely logged) because an operator reading a stalled render
   *  needs to see which module the ceiling is unbounded against; an absence that is only in a log
   *  line is an absence nobody finds. Empty/absent means every step in play declared one. */
  ceiling_undeclared?: string[];
  // The progress fingerprint last seen ("<phase>:<doneCount>"); any change is genuine forward progress.
  progress_marker?: string;
  error?: string;
  created_at: number;
}


const filmKey = (id: string) => `renders/${id}/film-job.json`;
const clipDocKey = (clipJobId: string) => `renders/${clipJobId}/clips-job.json`; // matches render-orchestrator

export { filmKey as filmJobDocKey, clipDocKey as clipJobDocKey };

/** Map a film job phase to a shard status string for scatter gather decisions. */
export function filmPhaseToShardStatus(job: FilmJob): string {
  if (job.cancelled) return "CANCELLED";
  if (job.phase === "done") return "COMPLETED";
  if (job.phase === "failed") return "FAILED";
  return "IN_PROGRESS";
}

/** Pure: join keyframe outputs to scenes by shot_id. A scene with no matching keyframe is dropped
 *  and reported in `missing` (so the caller knows which shots the keyframe stage did not produce). */
export function joinKeyframesToScenes(
  scenes: FilmScene[],
  keyframes: { shot_id: string; keyframe_key: string }[],
): { matched: { shot_id: string; keyframe_key: string; prompt: string; seconds: number }[]; missing: string[] } {
  const byShot = new Map(keyframes.map((k) => [k.shot_id, k.keyframe_key]));
  const matched: { shot_id: string; keyframe_key: string; prompt: string; seconds: number }[] = [];
  const missing: string[] = [];
  for (const sc of scenes) {
    const key = byShot.get(sc.shot_id);
    if (key) matched.push({ shot_id: sc.shot_id, keyframe_key: key, prompt: sc.prompt, seconds: sc.seconds });
    else missing.push(sc.shot_id);
  }
  return { matched, missing };
}

/** Next shot's start still is this shot's end frame (FLF continuity). Last shot has none. */
export function pairLastKeyframeKeys<T extends { shot_id: string; keyframe_key: string }>(
  shots: T[],
): (T & { last_keyframe_key?: string })[] {
  return shots.map((s, i) => {
    const next = shots[i + 1];
    return next ? { ...s, last_keyframe_key: next.keyframe_key } : { ...s };
  });
}

export interface FinishSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  adopted: number;
  degraded: number;
  // Distinct non-empty reasons, first-seen order. Empty when nothing degraded. A panel that
  // renders this (not the `passthrough:` tag) can tell "no face" from "door timed out" (#226).
  reasons: string[];
}
/** #707: per-shot delivered-vs-planned duration, surfaced on the film summary. A fixed-grid motion
 *  backend (e.g. CogVideoX: 8fps pinned, per-tier frame caps) honestly clamps a shot's requested
 *  duration; the clamp was always visible in the module output but silent to the API/UI. One entry per
 *  done shot whose backend reported usable fps+frames; a backend that reports nothing contributes no
 *  entry (absence over fabrication). */
export interface ClipDelivery {
  shot_id: string;
  planned_seconds: number;
  delivered_seconds: number; // frames/fps, rounded to ms
  fps: number;
  frames: number;
  // #705: tier honesty -- true when a distilled model variant rendered the clip. Carried only when
  // the backend reported it; absent otherwise.
  distilled?: boolean;
}

export function clipDeliveries(clipJob: ClipJob | null): ClipDelivery[] | undefined {
  if (!clipJob) return undefined;
  const out: ClipDelivery[] = [];
  for (const s of clipJob.shots) {
    if (s.status !== "done" || !s.delivered_fps || !s.delivered_frames) continue;
    const entry: ClipDelivery = {
      shot_id: s.shot_id,
      planned_seconds: s.seconds,
      delivered_seconds: Math.round((s.delivered_frames / s.delivered_fps) * 1000) / 1000,
      fps: s.delivered_fps,
      frames: s.delivered_frames,
    };
    if (typeof s.distilled === "boolean") entry.distilled = s.distilled;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

export interface FilmSummary {
  film_id: string;
  phase: FilmJob["phase"];
  error?: string;
  clips?: JobSummary;
  // #707: delivered-vs-planned per shot (see ClipDelivery). Absent until a backend reports durations.
  clip_deliveries?: ClipDelivery[];
  finish?: FinishSummary;
  film_key?: string; // present once the film is assembled (phase "done")
  // Outcome of the film.finish chain (title / credit cards). Surfaced so the API/frontend can show
  // honest degrade state -- a film that reached "done" but shipped WITHOUT cards (e.g. the video-finish
  // container was unreachable) has film_finish.degraded set. Absent until film.finish runs. (#211 follow-up)
  film_finish?: FilmJob["film_finish"];
  // Loud degrade status when the video-finish tier was UNAVAILABLE (unbound / unreachable-after-retry):
  // the film COMPLETED delivering per-shot clips (assemble) or the silent film (mux) instead of the
  // finished film. Absent on a normal render. Lets the API/UI show "clips only, finish unavailable" (#519).
  finish_unavailable?: FilmJob["finish_unavailable"];
  // #619: keyframe recovery hit the ceiling with a partial set; the film delivered only the scenes
  // that rendered. Absent on a normal render. Lets the API/UI show "N of M scenes, dropped [...]".
  keyframes_incomplete?: FilmJob["keyframes_incomplete"];
  // cf#365: CONTENT length (not wall-clock). Integer milliseconds; absent = NOT MEASURED.
  // assemble_ms = pre-film.finish concat at renders/<id>/film.mp4 (the assemble-stage duration that
  // was write-only on the job doc until this field). output_ms = last-writer DELIVERED length for
  // job.film_key (same basis as renders.output_ms / "we bill on the last writer"). Together they let
  // a poll decompose predicted-vs-delivered without inventing a full meter.
  // Distinct from finish_elapsed_ms (CPU wall-clock capacity telemetry, cf#268).
  assemble_ms?: number;
  output_ms?: number;
}

/** Seconds of content -> integer ms for summary/billing fields, or undefined when there is no honest
 *  number. Matches outputMsFromSeconds in the orchestrator (positive finite only; 0 is not a film). */
function contentMsFromSeconds(seconds: number | undefined): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : undefined;
}

/** Reasons a finish shot actually degraded. Prefers FinishOutput.degraded (the channel, #226);
 *  falls back to the `passthrough:` tag suffix so pre-#226 job docs still summarise. */
export function finishShotReasons(s: FinishShot): string[] {
  const fromField = (s.degraded ?? []).filter((r) => typeof r === "string" && r.length > 0);
  if (fromField.length > 0) return fromField;
  const out: string[] = [];
  for (const tag of [...(s.applied ?? []), ...(s.adopted ?? [])]) {
    if (!tag.startsWith("passthrough:")) continue;
    const reason = tag.slice("passthrough:".length);
    if (reason.length > 0) out.push(reason);
  }
  return out;
}

function uniqueFirstSeen(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function summarizeFinish(shots: FinishShot[]): FinishSummary {
  const perShot = shots.map(finishShotReasons);
  return {
    total: shots.length,
    done: shots.filter((s) => s.status === "done").length,
    failed: shots.filter((s) => s.status === "failed").length,
    pending: shots.filter((s) => s.status === "pending").length,
    adopted: shots.filter((s) => (s.adopted?.length ?? 0) > 0).length, // #583: shots with >=1 finish step reused from R2
    // A soft-degraded shot is DONE and did no work. Count from the reason channel first (#226),
    // then the `passthrough:` tag so pre-#226 docs still report. `noop:` is EXCLUDED -- an
    // intentional no-op (e.g. a lip-sync module on a shot with no dialogue) is not a degrade.
    degraded: perShot.filter((rs) => rs.length > 0).length,
    reasons: uniqueFirstSeen(perShot.flat()),
  };
}
export function summarizeFilm(job: FilmJob, clipJob: ClipJob | null): FilmSummary {
  const durations = job.film_output_seconds;
  const assembleKey = defaultFilmOutputKey(job.film_id);
  // Assemble stage: the deterministic concat key. Delivered: whatever film_key points at after
  // film.finish (may equal assembleKey when no cards ran). Both read the same map; absent keys stay
  // off the summary rather than zero (NULL = not measured).
  const assemble_ms = contentMsFromSeconds(durations?.[assembleKey]);
  const output_ms = contentMsFromSeconds(
    job.film_key ? durations?.[job.film_key] : undefined,
  );
  return {
    film_id: job.film_id, phase: job.phase, error: job.error,
    clips: clipJob ? summarizeJob(clipJob) : undefined,
    clip_deliveries: clipDeliveries(clipJob),
    finish: job.finish_shots ? summarizeFinish(job.finish_shots) : undefined,
    film_key: job.film_key,
    film_finish: job.film_finish,
    finish_unavailable: job.finish_unavailable,
    keyframes_incomplete: job.keyframes_incomplete,
    assemble_ms,
    output_ms,
  };
}

/** Pure: order a set of finished clips by the storyboard's scene order, keeping only shots that
 *  produced a clip. The film must play in scene order regardless of which order the clip/finish
 *  stages happened to complete in. A shot with no clip is dropped (it never rendered). */
export function orderFinalClips(
  scenes: FilmScene[],
  shots: { shot_id: string; clip_key: string }[],
): { shot_id: string; clip_key: string }[] {
  const byShot = new Map(shots.map((s) => [s.shot_id, s.clip_key]));
  const out: { shot_id: string; clip_key: string }[] = [];
  for (const sc of scenes) {
    const clip_key = byShot.get(sc.shot_id);
    if (clip_key) out.push({ shot_id: sc.shot_id, clip_key });
  }
  return out;
}

/** House CSAM needle, same as the keyframe door. A refusal is a HARD FAIL, never a polish degrade. */
export function isCsamRefusalReason(text: unknown): boolean {
  return typeof text === "string" && text.toLowerCase().includes("csam");
}

/** True when a finish module's output is a CSAM refusal wearing a FinishOutput shape. */
export function finishOutputIsCsamRefusal(out: FinishOutput): boolean {
  if (isCsamRefusalReason(out.degraded)) return true;
  return (out.applied ?? []).some((tag) => isCsamRefusalReason(tag));
}

/** Pure: fold one finish module's output into the shot -- chain its output clip into the next module,
 *  record what it applied, advance the chain index; status -> done when the chain is exhausted.
 *  #226: also persist `out.degraded` so the reason is not swallowed. CSAM is refused by the
 *  caller (see applyFinishOutputOrRefuse); this fold never turns a refusal into a degrade. */
export function applyFinishOutput(fs: FinishShot, out: FinishOutput, project: string): void {
  fs.clip_key = assertProjectKey(project, out.clip_key);
  const tags = out.applied || [];
  fs.applied.push(...tags);
  // #226: the reason channel, not the tag. A lipsync no-face and an upscale timeout on the same
  // shot are two facts; last-write-wins would hide one.
  if (typeof out.degraded === "string" && out.degraded.length > 0) {
    (fs.degraded ??= []).push(out.degraded);
  }
  // #662: account THIS run step in the per-step ledger (chain order), so a done shot's ledger covers the
  // whole chain 1:1. `tags` may be empty (a step that ran but reported no marker); the record still
  // accounts the step -- coverage is per-record, not per-tag.
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [...tags], reused: false });
  fs.idx += 1;
  fs.poll = undefined;
  fs.attempts = 0; // a step succeeded -> the next step gets a fresh transient-retry budget
  if (fs.idx >= fs.chain.length) fs.status = "done"; // else stays pending; next advance submits chain[idx]
}

/** Fold a finish output, or fail the shot if the output is a CSAM refusal. The fold itself must
 *  never record a CSAM reason as a polish miss -- that is the bright line, not a degrade. */
export function applyFinishOutputOrRefuse(fs: FinishShot, out: FinishOutput, project: string): void {
  if (finishOutputIsCsamRefusal(out)) {
    fs.status = "failed";
    fs.error = typeof out.degraded === "string" && out.degraded.length > 0 ? out.degraded : "csam refusal";
    fs.poll = undefined;
    return;
  }
  try {
    applyFinishOutput(fs, out, project);
  } catch (e) {
    fs.status = "failed";
    fs.error = e instanceof Error ? e.message : String(e);
    fs.poll = undefined;
  }
}

/** Pure: fold an ADOPTED (reused-from-R2, NOT run this pass) finish-step artifact into the shot. Same
 *  chain advance as applyFinishOutput, but the step marker lands in `adopted` (the honest reuse channel)
 *  and is NEVER pushed into `applied` -- the record must not claim a run that did not happen (#583).
 *  `clip_key` is the adopted artifact key; `tag` is the reconstructed step marker (finishStepAppliedTag). */
export function adoptFinishStepOutput(fs: FinishShot, clip_key: string, tag: string): void {
  fs.clip_key = clip_key;
  (fs.adopted ??= []).push(tag);
  // #662: account THIS reused step in the per-step ledger (reused:true), so it is PRESENT in the ledger
  // even though its tag lives in `adopted`, not `applied` -- the fix for the "applied drops one tag" report.
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
  fs.idx += 1;
  fs.poll = undefined;
  fs.attempts = 0; // a step advanced -> the next step gets a fresh transient-retry budget
  if (fs.idx >= fs.chain.length) fs.status = "done";
}

/** Pure: fold one speech module's output into the shot. On a REAL enhancement (no `degraded`), thread the
 *  new audio_key forward so the next step (and finish) sees the cleaned audio; on an honest soft-degrade,
 *  LEAVE audio_key UNCHANGED (the original audio survives) and record the reason -- no fake applied tag,
 *  the chain never fails on a polish miss. Advance idx; done when the chain is exhausted. */
export function applySpeechOutput(ss: SpeechShot, out: SpeechOutput): void {
  if (!out.degraded) ss.audio_key = out.audio_key; // real enhance threads forward; a degrade keeps the original
  ss.applied.push(...(out.applied || []));
  if (out.degraded) ss.degraded = out.degraded;
  ss.idx += 1;
  ss.poll = undefined;
  ss.attempts = 0;
  if (ss.idx >= ss.chain.length) ss.status = "done";
}

// Bounded transient-retry for a finish-step invocation/poll failure. shot_02 shipped silent because
// its lip-sync invocation hit a transient blip (the module worker momentarily unreachable / 5xx --
// a musetalk cold-start race) and went straight to `failed`, where the mid-chain intermediate was
// then adopted. Now a TRANSIENT failure re-dispatches the step (status stays `pending`) up to the
// cap; a DETERMINISTIC reject (a 4xx, a real module error, "job failed", "no clip_key") or the cap
// exhausted goes `failed` -- loud, no spin. Same classify-then-retry discipline as the D1 / assemble
// transport retries.
export const FINISH_STEP_MAX_ATTEMPTS = 3;

/** Classify an invokeModule / pollModule failure string. Transport shapes are transient:
 *  "module /invoke -> 503", "module /poll -> 504", "module unreachable: <timeout/network>". A module-
 *  logic ok:false (input reject, "job failed", "no clip_key") or a 4xx is deterministic -> fail. */
export function classifyFinishFailure(error: string | undefined): "transient" | "deterministic" {
  // #719 unified classifier lives in render-orchestrator; film-model imports from there (never reverse).
  return classifyTransientFailure(error);
}

/** Decide whether to re-dispatch a failed finish step or fail it. Pure so the retry contract is
 *  unit-testable without a module fetcher. */
export function classifyFinishRetry(
  error: string | undefined,
  priorAttempts: number,
  maxAttempts: number = FINISH_STEP_MAX_ATTEMPTS,
): { action: "retry"; attempts: number } | { action: "fail" } {
  if (classifyFinishFailure(error) !== "transient") return { action: "fail" };
  const attempts = (priorAttempts ?? 0) + 1;
  return attempts < maxAttempts ? { action: "retry", attempts } : { action: "fail" };
}

/** Pure: resolve the validated config for each finish module, in chain order. Each module gets its
 *  config_schema defaults (the contract promises config is "already validated against the module's
 *  config_schema"); user overrides are keyed by module NAME (what /api/modules exposes), one hop,
 *  same words down. Without this a module receives `{}` and falls back to its do-nothing path, so
 *  finish-rife no-op'd in the first e2e (issue #75). */
export function resolveFinishConfigs(
  serving: { name: string; config_schema?: ConfigSchema }[],
  finishConfig: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown>[] {
  return serving.map((m) => validateConfig(m.config_schema, finishConfig?.[m.name]));
}

/** Pure: is this finish shot eligible to be adopted from its R2 artifact? R2 PRESENCE IS AUTHORITATIVE
 *  -- if <shot>_finished.mp4 is in R2 the work is done regardless of what the RunPod job envelope says.
 *  Two cases are adoptable:
 *    - `failed`: a module fast-failed a shot whose finished clip is actually in R2 (the GC'd-job path, #141).
 *    - `pending` on its LAST chain module with a submitted poll token: a finish job whose RunPod envelope
 *      froze at IN_PROGRESS (worker recycled, /status never flips to COMPLETED) so the poll reports
 *      pending forever -- but the finish output already landed in R2. Without this the shot pends to the
 *      90min hard-deadline and FALSE-FAILS a complete render (surfaced by RUN #29; sibling of #141/#142).
 *  A `pending` shot mid-chain (idx < last) is NOT adopted: its R2 key would be an intermediate module's
 *  output, not the chain's final artifact, so the remaining modules must still run. */
export function finishShotAdoptableFromR2(fs: FinishShot): boolean {
  // Adopt an R2 clip ONLY when it is the chain's FINAL artifact (idx === last). A mid-chain shot's
  // R2 key is an INTERMEDIATE module's output, so adopting it skips the remaining finish modules
  // (e.g. lip-sync) and ships a half-finished, silent clip. This guard protected the `pending` branch
  // but the `failed` branch lacked it, so a mid-chain module failure adopted the intermediate as
  // "done" -- the silent showcase render (lip-sync failed at idx 1 of 4 -> the RIFE intermediate was
  // adopted). The failed branch is the #141 GC'd-job path: a fast-failed shot whose FINAL clip is in R2.
  if (fs.idx !== fs.chain.length - 1) return false;
  if (fs.status === "failed") return true;
  return fs.status === "pending" && !!fs.poll;
}

/** Pure: adopt every adoptable finish shot whose finished clip is present in R2 (the artifact overrides
 *  the module's verdict / a stuck envelope). Mutates `finishShots`, returns the number adopted. Mirrors
 *  reclaimClipsFromR2 on the clips leg so the two phases recover symmetrically. */
export function reclaimFinishShotsFromR2(finishShots: FinishShot[], present: Map<string, string>, modules?: RegisteredModule[]): number {
  let adopted = 0;
  for (const fs of finishShots) {
    if (finishShotAdoptableFromR2(fs) && present.has(fs.shot_id)) {
      fs.clip_key = present.get(fs.shot_id) as string;
      fs.status = "done";
      fs.poll = undefined;
      fs.error = undefined; // the finished artifact in R2 is the source of truth
      // #583 honesty: this shot's FINAL step was REUSED from R2, not run this pass -- disclose it in
      // `adopted` (never a fake `applied`-run tag). finishShotAdoptableFromR2 guarantees idx === last,
      // so the reused marker is the last chain step's tag.
      const tag = finishStepAppliedTag(fs, modules);
      (fs.adopted ??= []).push(tag);
      // #662: account the reused FINAL step (idx === last) in the per-step ledger, completing it to
      // chain.length so the adopted shot's ledger reconciles 1:1 to its chain.
      (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
      adopted += 1;
    }
  }
  return adopted;
}

/** cf#1662: the film.finish outcome in the shape that reaches the RENDER ROW.
 *
 *  WHY THIS EXISTS. A film that ships without its title card or subtitles is `done`, carries no
 *  error, and was previously indistinguishable in render history from one that shipped complete --
 *  a DEGRADATION wearing completion. The chain already records everything needed (this type's own
 *  comment says `degraded` exists to prevent "a silent green"); it was simply never carried onto the
 *  poll view, and the poll view is what `updateRenderFromView` writes into `output_json`. So nobody
 *  could COUNT how often it happens, which makes every proposed fix for fc#1662 a trade against an
 *  incidence that does not exist anywhere.
 *
 *  FOUR STATES, and the shape is four rather than a boolean deliberately:
 *
 *    key absent         this row predates the change            -- NOT MEASURED
 *    null               the chain did not run (nothing to card) -- MEASURED, not applicable
 *    degraded: null     the chain ran and applied everything    -- MEASURED, clean
 *    degraded: "..."    the chain ran and SHIPPED UNCARDED      -- MEASURED, the finding
 *
 *  Collapsing "no cards were requested" into "cards applied cleanly" would rebuild the very defect
 *  this is here to expose, one field over. An absence never renders as a value.
 *
 *  `adopted` is carried because it counts the RECOVERED re-encodes: a step whose artifact was found
 *  in R2 rather than run. Under fc#1662 that is the wasted-work signal, so it is as load-bearing as
 *  `degraded` and it is the number that says whether the waste is real. */
export function filmFinishView(
  ff?: { applied?: string[]; adopted?: string[]; degraded?: string },
): { applied: string[]; adopted: string[]; degraded: string | null } | null {
  if (!ff) return null;
  return {
    applied: ff.applied ?? [],
    adopted: ff.adopted ?? [],
    // Empty string is not a reason. Only a non-empty string counts as degraded.
    degraded: typeof ff.degraded === "string" && ff.degraded.length > 0 ? ff.degraded : null,
  };
}

/** #662 honesty invariant: does this finish shot's per-step ledger reconcile 1:1 to its chain? True unless
 *  a DONE shot has a ledger that fails to cover every chain step in order. Absent ledger (a pre-#662 job
 *  doc) or a non-done shot (still advancing, or failed mid-chain with a partial ledger) is NOT asserted.
 *  The invariant a DONE shot must hold: every chain step is accounted for exactly once (run or reused), so
 *  an adopted shot's ledger never looks like it dropped a step (the #245/#249 honesty-ledger discipline). */
export function finishShotLedgerReconciles(fs: FinishShot): boolean {
  if (fs.status !== "done" || !fs.ledger) return true;
  return fs.ledger.length === fs.chain.length && fs.ledger.every((r, i) => r.binding === fs.chain[i]);
}

/** Pure: the R2 key the CURRENT finish step (fs.chain[fs.idx]) is expected to write, given its input
 *  clip (fs.clip_key). Mirrors each finish module's OWN output-key convention so the orchestrator can
 *  check R2 PRESENCE for a step whose RunPod job was GC'd / froze MID-chain (the #141/#166 R2-authoritative
 *  pattern, extended from the final step to any step). The modules: finish-rife writes
 *  `<project>/clips/<shot>_finished.mp4` (named off the shot id by its container); the append-convention
 *  modules derive `<input-base>_<suffix>.<ext>` from the input clip key (musetalk lip-sync -> `_ls`,
 *  upscale -> `_up`; see vivijure-musetalk / vivijure-upscale handler.py). Returns null for a module whose
 *  convention we do not model (e.g. text-overlay), so an unmodeled step gets NO R2 shortcut and can never
 *  be advanced off a sibling step's artifact -- the mid-chain phantom-adopt the silent-render bug warned of. */
export function finishStepOutputKey(project: string, fs: FinishShot, modules?: RegisteredModule[]): string | null {
  const binding = fs.chain[fs.idx] ?? "";
  // Contract-carried convention first (finish_artifacts, S6): the module DECLARES how it names its
  // output, so the core stops reverse-engineering module internals from the binding name.
  const decl = moduleByBinding(modules, binding)?.finish_artifacts;
  if (decl) {
    if (decl.output_key.kind === "shot_named") return `renders/${project}/clips/${fs.shot_id}${decl.output_key.filename}`;
    return insertKeySuffix(fs.clip_key, decl.output_key.suffix);
  }
  // Legacy fallback for module deploys predating finish_artifacts: the shipped modules' conventions,
  // derived from the binding name. Returns null for a module whose convention we do not model, so an
  // unmodeled step gets NO R2 shortcut and can never adopt a sibling step's artifact.
  if (/RIFE/i.test(binding)) return `renders/${project}/clips/${fs.shot_id}_finished.mp4`;
  const suffix = /LIPSYNC|MUSETALK/i.test(binding) ? "_ls" : /UPSCALE/i.test(binding) ? "_up" : null;
  if (!suffix) return null;
  return insertKeySuffix(fs.clip_key, suffix);
}

/** Insert an artifact suffix into an R2 key before its extension (`a/b.mp4` + `_ls` -> `a/b_ls.mp4`). */
function insertKeySuffix(key: string, suffix: string): string {
  const slash = key.lastIndexOf("/");
  const dotInBase = key.slice(slash + 1).lastIndexOf(".");
  if (dotInBase < 0) return `${key}${suffix}`;
  const at = slash + 1 + dotInBase;
  return `${key.slice(0, at)}${suffix}${key.slice(at)}`;
}

/** The finish module (if any) whose transport-encoded binding ref serves this chain step. */
function moduleByBinding(modules: RegisteredModule[] | undefined, binding: string): RegisteredModule | undefined {
  return modules?.find((m) => m.binding === binding);
}

const MAX_APPLIED_TAG_TEMPLATE_CHARS = 512;

/** Resolve a `{knob}` / `{knob|default}` applied-tag template against the step's validated config. */
function resolveAppliedTemplate(tag: string, cfg: Record<string, unknown>): string {
  const src = tag.length > MAX_APPLIED_TAG_TEMPLATE_CHARS ? tag.slice(0, MAX_APPLIED_TAG_TEMPLATE_CHARS) : tag;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf("}", open + 1);
    if (close === -1) {
      out += src.slice(open);
      break;
    }
    const inner = src.slice(open + 1, close);
    const pipe = inner.indexOf("|");
    const knob = pipe === -1 ? inner : inner.slice(0, pipe);
    const dflt = pipe === -1 ? undefined : inner.slice(pipe + 1);
    if (/^[A-Za-z0-9_]+$/.test(knob)) {
      const v = cfg[knob];
      out += v === undefined ? (dflt ?? "") : String(v);
    } else {
      out += src.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/** Pure: the `applied` tag the CURRENT finish step would report, reconstructed from its validated config
 *  so an R2-adopted step (whose job is gone, so its real response is lost) still carries the marker the
 *  verifier and UI read (e.g. `lipsync:v15`, `upscale:2x`, `interpolate:2x`). Mirrors each module's own
 *  `applied` string. Unmodeled modules get a `<binding>:r2-adopted` marker so the adoption is never silent. */
export function finishStepAppliedTag(fs: FinishShot, modules?: RegisteredModule[]): string {
  const binding = fs.chain[fs.idx] ?? "";
  const cfg = (fs.configs?.[fs.idx] ?? {}) as Record<string, unknown>;
  // Contract-carried rules first (finish_artifacts.applied, S6): first matching rule wins; a rule
  // with `when` applies only when the named knob equals its literal.
  const rules = moduleByBinding(modules, binding)?.finish_artifacts?.applied;
  if (rules) {
    for (const rule of rules) {
      if (rule.when && cfg[rule.when.knob] !== rule.when.equals) continue;
      return resolveAppliedTemplate(rule.tag, cfg);
    }
    return `${binding}:r2-adopted`; // declared rules, none matched: never silent
  }
  // Legacy fallback (module deploys predating finish_artifacts), binding-name derived.
  if (/LIPSYNC|MUSETALK/i.test(binding)) return `lipsync:${String(cfg.version ?? "v15")}`;
  if (/UPSCALE/i.test(binding)) return `upscale:${Number(cfg.scale ?? 2)}x`;
  if (/RIFE/i.test(binding)) return cfg.interpolate === false ? "noop:interpolate-off" : `interpolate:${Number(cfg.interpolation_factor ?? 2)}x`;
  return `${binding}:r2-adopted`;
}

/** Pure: classify a video-finish assemble attempt and advance the bounded retry counter (issue #82).
 *  `status` is the HTTP status, or null when the container was unreachable (network error). The counter
 *  tracks CONSECUTIVE transient failures, so the returned `attempts` is always the value to store:
 *    - transient gateway outcome (unreachable, or 502/503/504 from a cold or slow ffmpeg concat
 *      exceeding the request window) -> prior + 1; the film stays in "assemble" and the next poll
 *      re-attempts (re-PUTting the same film key is idempotent), bounded by maxAttempts.
 *    - any definitive answer from the container ("ok": a real success, OR the container's own terminal
 *      error like a 500 ffmpeg body) -> 0, because the transient streak is broken. Resetting here is
 *      what keeps a slow-but-successful finish from carrying stale attempts toward the cap, and gives a
 *      later manual phase-reset a full retry budget. The caller then distinguishes success from the
 *      container's terminal error (which must NOT loop).
 *  A fully-rendered film therefore self-heals from a cold-container 504 instead of failing on the last
 *  CPU-only step and needing a human phase-reset. */
export type AssembleTransport =
  | { state: "ok"; attempts: number } // definitive answer; streak reset to 0, caller reads the response
  | { state: "retry"; attempts: number; error: string } // stay in "assemble", re-attempt next poll
  | { state: "exhausted"; attempts: number; error: string }; // cap hit -> terminal failed

export function classifyAssembleTransport(
  status: number | null,
  priorAttempts: number,
  maxAttempts: number,
): AssembleTransport {
  // 524 is Cloudflare's proxy-read timeout. The Worker fetch is still a CF
  // hop even when door DNS is grey. Sync /finish that outlives ~100s returns
  // this; treat it like 504 so a leftover sync caller retries instead of
  // failing a fully-rendered film. Async /finish is the real fix.
  const transient = status === null || status === 502 || status === 503 || status === 504 || status === 524;
  if (!transient) return { state: "ok", attempts: 0 };
  const attempts = priorAttempts + 1;
  const reason = status === null ? "container unreachable" : `gateway ${status}`;
  if (attempts < maxAttempts) {
    return {
      state: "retry",
      attempts,
      error: `assemble retry ${attempts}/${maxAttempts} (${reason}); clips intact, re-attempting next poll`,
    };
  }
  return {
    state: "exhausted",
    attempts,
    error: `video-finish ${reason} after ${attempts} assemble attempts; clips intact in R2 (reset phase to "assemble" to retry)`,
  };
}

// --------------------------------------------------------------------------- master (pre-mux audio)

/** The film-level `master` chain state carried on a FilmJob (the master module bindings in ui.order, the
 *  step cursor, the in-flight poll token, and the accumulated applied / degraded record). */
export type MasterState = NonNullable<FilmJob["master"]>;

// Bounded transient-retry for a master step, the same discipline as a finish step: a transport blip (the
// module worker momentarily unreachable / a 5xx) re-dispatches the step under the cap. On EXHAUSTION the
// step soft-degrades (passthrough) -- it does NOT fail the render, because master is a polish step (#249/#77).
export const MASTER_STEP_MAX_ATTEMPTS = 3;

// How long the master phase may sit before a frozen step (a RunPod envelope stuck IN_PROGRESS so /poll
// pends forever) is soft-degraded to a passthrough and the chain advances. Generous: a CPU master of a
// few-minute bed is well done by now. NOT a hard FAIL (unlike PHASE_HARD_DEADLINE_SECONDS) -- a stuck
// polish must degrade to the un-mastered bed and still ship the film, never drop it.
export const MASTER_STALL_SECONDS = 15 * 60;

/** Pure: total film length (seconds) from the scenes -- the optional `seconds` hint a master module gets
 *  (it probes the bed if absent). Returns undefined for a job with no scene durations. */
export function filmSeconds(job: Pick<FilmJob, "scenes">): number | undefined {
  const total = (job.scenes || []).reduce((a, s) => a + (Number(s.seconds) || 0), 0);
  return total > 0 ? total : undefined;
}

/** Pure: the mastered bed's R2 key -- beside the source with a `_mastered` suffix, so the original
 *  survives and each chain step writes a fresh, deterministic key (`renders/p/audio/bed.wav` ->
 *  `renders/p/audio/bed_mastered.wav`). The core presigns a PUT for this key and passes it to the master
 *  module; the extension is `.wav`, the master config default (the master phase does not thread per-user
 *  the planner's master config (so a user-selected mp3 lands on a `.mp3` key the container PUT matches).
 *  A deterministic key makes a transient-retry re-PUT idempotent (it overwrites, never orphans). */
export function masteredBedKey(audioKey: string, format: "wav" | "mp3" = "wav"): string {
  const slash = audioKey.lastIndexOf("/");
  const dot = audioKey.lastIndexOf(".");
  const base = dot > slash ? audioKey.slice(0, dot) : audioKey;
  return `${base}_mastered.${format}`;
}

/** Pure: fold one master step's SUCCESS output into the chain state, returning the bed key to carry to
 *  the next step (and the mux). Advances idx, resets the step's poll + attempts. `applied` tags
 *  accumulate; a module soft-degrade (ok:true + output.degraded -- it passed the bed through because it
 *  could not do the work) is recorded against the step binding, so a passthrough is never silent (#77).
 *  Returns the input bed unchanged when the module returned no usable audio_key. */
export function applyMasterOutput(m: MasterState, prevKey: string, out: MasterOutput): string {
  const binding = m.chain[m.idx] ?? "";
  const carried = typeof out.audio_key === "string" && out.audio_key.length > 0 ? out.audio_key : prevKey;
  for (const a of out.applied || []) m.applied.push(a);
  if (typeof out.degraded === "string" && out.degraded.length > 0) m.degraded.push(`${binding}: ${out.degraded}`);
  m.idx += 1;
  m.poll = undefined;
  m.attempts = 0;
  return carried;
}

/** Pure: record a step that could NOT run at all (unbound module, a terminal failure, or a stall) as a
 *  soft-degrade and advance the cursor. The bed carries through unchanged -- the render never fails on a
 *  master miss (#249 / #77). */
export function degradeMasterStep(m: MasterState, reason: string): void {
  const binding = m.chain[m.idx] ?? "";
  m.degraded.push(`${binding}: ${reason}`);
  m.idx += 1;
  m.poll = undefined;
  m.attempts = 0;
}

/** Pure: true once every master step has run (or degraded). */
export function masterChainDone(m: MasterState): boolean {
  return m.idx >= m.chain.length;
}

/** Pure: normalize caller scene ids to the canonical `shot_NN` the bundle uses. /api/storyboard/bundle
 *  runs validateStoryboard, which coerces every scene id to `shot_<index+1>` in declaration order --
 *  so a caller that supplies its own ids (e.g. the Slate bot's `s1`/`s2`) gets a bundle storyboard
 *  whose ids do NOT match the film's shot_ids, and the keyframe stage rejects them
 *  (`process_shot_ids not in storyboard`). Coerce here with the SAME function so they line up by
 *  position (a valid `shot_NN` survives; anything else is renumbered). */
export function coerceSceneIds(scenes: FilmScene[]): FilmScene[] {
  return (scenes || []).map((s, i) => ({ ...s, shot_id: coerceShotId(s.shot_id, i) }));
}

/** Pure: remap dialogue-line shot ids through the SAME positional coercion coerceSceneIds applies to
 *  the scenes, keyed off the ORIGINAL (pre-coercion) scene ids. Without this a caller that supplies
 *  its own scene ids (`s1`/`s2`) plus dialogue_lines gets a film whose dialogue map is keyed `s1`
 *  while every consumer joins on the coerced `shot_01`: the lip-sync finish step reads no audio_key
 *  (noop:no-dialogue), buildCaptionCues yields zero cues, and the film ships silent + uncaptioned
 *  even though the TTS ran. A line whose id matches no scene is passed through unchanged (same
 *  fail-soft posture as the dialogue stage). Canonical `shot_NN` ids survive coerceShotId, so this
 *  is a no-op for the planner UI / scatter paths. */
export function coerceDialogueLineIds(originalScenes: FilmScene[], lines: DialogueLine[] | undefined): DialogueLine[] | undefined {
  if (!lines || !lines.length) return lines;
  const map = new Map<string, string>();
  (originalScenes || []).forEach((s, i) => {
    if (s && typeof s.shot_id === "string" && s.shot_id.trim()) map.set(s.shot_id.trim(), coerceShotId(s.shot_id, i));
  });
  return lines.map((l) => {
    const mapped = l && typeof l.shot_id === "string" ? map.get(l.shot_id.trim()) : undefined;
    return mapped && mapped !== l.shot_id ? { ...l, shot_id: mapped } : l;
  });
}

// --------------------------------------------------------------------------- stall recovery (#129)

// How long a phase may sit without progress before the driver tries to recover it, and the absolute
// ceiling past which a still-pollable phase is failed loudly rather than left to hang forever. The
// background sweep (crons */1) calls advanceFilmJob every minute, so a wedged job is rescued or failed
// within KEYFRAME_STALL_SECONDS of the GPU finishing -- never the silent forever-IN_PROGRESS of #129.
//   Cause: the keyframe / finish module poll() returns pending for any non-COMPLETED RunPod /status,
//   so once RunPod garbage-collects a finished job the poll is pending with no deadline while the GPU
//   output already sits in R2. The keyframe stage writes deterministic keys
//   (renders/<project>/keyframes/<shot>.png), so the core CAN adopt those orphans without re-running
//   the GPU; clips/finish keys are GPU-assigned (not guessable), so those phases get the loud-fail
//   ceiling only (a stuck clips/finish poll is rarer and re-submitting is the human's call).
export const KEYFRAME_STALL_SECONDS = 20 * 60; // 20min: a project-wide SDXL keyframe pass is well done by now
export const PHASE_HARD_DEADLINE_SECONDS = 90 * 60; // 90min: absolute ceiling for any one pollable phase

export const POLLABLE_PHASES: ReadonlySet<FilmJob["phase"]> = new Set(["keyframe", "clips", "speech", "finish"]);

/** Seconds the job has sat in its current phase. Falls back to created_at on pre-#129 jobs (no
 *  phase_started_at stamp); `now` is injectable so tests do not depend on the wall clock. */
export function phaseAgeSeconds(job: FilmJob, now: number = Date.now()): number {
  const since = job.phase_started_at ?? job.created_at;
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** The phases that advance one shot at a time inside a single phase (the fan-out phases). These are
 *  the phases where a long wall-clock is healthy as long as shots keep landing -- which is why the
 *  hard ceiling measures them from last_progress_at, not phase_started_at (#704). */
export const PER_SHOT_PHASES: ReadonlySet<FilmJob["phase"]> = new Set(["clips", "speech", "finish"]);

/** Seconds since the last REAL progress, for the hard-ceiling check (#704). A per-shot phase
 *  (clips/speech/finish) on a slow local-gpu card lands one clip every few minutes for hours; that is
 *  genuine progress, so the 90min ceiling measures from last_progress_at (re-stamped on every finished
 *  shot via filmProgressMarker, #136): a phase that keeps landing shots never dies at the ceiling,
 *  while 90min since the LAST landed shot still fails loudly. Batch phases (keyframe) keep the
 *  phase_started_at clock: no phase-level progress for the whole window really is wedged (#129).
 *  Falls back to phase_started_at (then created_at) on jobs with no last_progress_at stamp. */
export function ceilingAgeSeconds(job: FilmJob, now: number = Date.now()): number {
  if (!PER_SHOT_PHASES.has(job.phase)) return phaseAgeSeconds(job, now);
  const since = Math.max(job.phase_started_at ?? job.created_at, job.last_progress_at ?? 0);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** What the phase ceiling resolved to for ONE job, and on what basis (core#182).
 *
 *  `seconds` is the ceiling actually enforced; `basis` says whether the modules' own declarations
 *  raised it above the floor. The rest is the evidence, carried rather than logged-and-lost so the
 *  failure message can state WHY a render died and the poll view can disclose what the core could
 *  not bound. */
export interface PhaseCeiling {
  seconds: number;
  basis: "floor" | "derived";
  /** FINISH_STEP_MAX_ATTEMPTS * the longest declared ceiling among the steps that could run next.
   *  0 when nothing in play declared one. */
  requiredSeconds: number;
  /** The step that set `requiredSeconds`, for the failure message. */
  longest: { binding: string; module: string; seconds: number } | null;
  /** Bindings whose module declared no `max_invocation_seconds`. The core does NOT invent a number
   *  for these; it holds the floor and says so. */
  undeclared: string[];
  /** Bindings in the live chain that resolve to no registered module at all. Distinguished from
   *  `undeclared` because they are a different defect (a chain referencing a module the registry no
   *  longer serves), and collapsing them would hide it. */
  unresolved: string[];
}

/** The chain steps that could run NEXT in a ceiling-derived phase: `chain[idx]` for every shot not
 *  already done. Not the whole chain -- a step further down the chain cannot run until the one before
 *  it resolves, and a step resolving MOVES the marker and re-stamps the clock, so it starts a fresh
 *  window rather than extending this one. */
function pendingChainSteps(job: FilmJob): string[] {
  const shots: Array<{ chain: string[]; idx: number; status: string }> =
    job.phase === "finish" ? (job.finish_shots || []) : job.phase === "speech" ? (job.speech_shots || []) : [];
  const out: string[] = [];
  for (const sh of shots) {
    if (sh.status === "done") continue;
    const step = (sh.chain || [])[Math.max(0, Math.trunc(sh.idx) || 0)];
    if (typeof step === "string" && step) out.push(step);
  }
  return out;
}

/** Size the stall ceiling to the WORK IN THIS JOB rather than to a constant (core#182).
 *
 *  THE MECHANISM THIS FIXES. `PHASE_HARD_DEADLINE_SECONDS` fails a phase that has shown no progress
 *  for 90 minutes. `filmProgressMarker` deliberately does not count `attempts` -- a step retrying is
 *  not a step progressing -- so a chain step that keeps timing out at its own door burns up to
 *  FINISH_STEP_MAX_ATTEMPTS full invocations while the marker never moves. Whether that fits inside
 *  90 minutes is a fact about the MODULE, and the ordering between a door`s guard and this ceiling
 *  spans separate repositories with nothing asserting it. Modules whose guards exceed the ceiling on
 *  a SINGLE attempt already exist, so the 90 minutes is not conservative; it is unrelated.
 *
 *  THE DERIVATION, and note it introduces NO new constant: both terms already exist.
 *
 *      required  = FINISH_STEP_MAX_ATTEMPTS * max(declared ceiling over the steps that could run next)
 *      effective = max(PHASE_HARD_DEADLINE_SECONDS, required)
 *
 *  The 90-minute constant becomes a FLOOR rather than a guess. It can only ever be raised here, so a
 *  wedged phase with nothing declared still fails exactly when it does today.
 *
 *  WHY `max` AND NOT `min` ACROSS SHOTS. Any shot advancing re-stamps the clock, so the no-progress
 *  window strictly ends when the FIRST shot moves, and `min` would be the tighter reading. It is
 *  also the reading that kills correct work: the ceiling must not fire while ANY correctly-running
 *  invocation is still inside its own door`s guard. Between a late loud failure and an early false
 *  one, this picks late.
 *
 *  WHAT IT REFUSES TO DO. A step whose module declares nothing is NOT given a substituted number. It
 *  is named in `undeclared`, the floor holds, and the caller reports it -- because a fabricated
 *  ceiling would be indistinguishable from a declared one, which is the exact defect class this
 *  whole change exists to remove. Conformance fails such a module at the gate.
 *
 *  Phases outside CEILING_DERIVED_HOOKS return the floor untouched. */
export function phaseCeiling(job: FilmJob, modules?: RegisteredModule[]): PhaseCeiling {
  const floor: PhaseCeiling = {
    seconds: PHASE_HARD_DEADLINE_SECONDS,
    basis: "floor",
    requiredSeconds: 0,
    longest: null,
    undeclared: [],
    unresolved: [],
  };
  if (job.phase !== "finish" && job.phase !== "speech") return floor;

  const steps = pendingChainSteps(job);
  if (!steps.length) return floor;

  const byBinding = new Map<string, RegisteredModule>();
  for (const m of modules || []) byBinding.set(m.binding, m);

  const undeclared: string[] = [];
  const unresolved: string[] = [];
  let longest: PhaseCeiling["longest"] = null;
  for (const binding of new Set(steps)) {
    const mod = byBinding.get(binding);
    if (!mod) {
      unresolved.push(binding);
      continue;
    }
    const declared = mod.max_invocation_seconds;
    if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) {
      undeclared.push(binding);
      continue;
    }
    if (!longest || declared > longest.seconds) longest = { binding, module: mod.name, seconds: declared };
  }
  undeclared.sort();
  unresolved.sort();

  const requiredSeconds = longest ? FINISH_STEP_MAX_ATTEMPTS * longest.seconds : 0;
  const seconds = Math.max(PHASE_HARD_DEADLINE_SECONDS, requiredSeconds);
  return {
    seconds,
    basis: seconds > PHASE_HARD_DEADLINE_SECONDS ? "derived" : "floor",
    requiredSeconds,
    longest,
    undeclared,
    unresolved,
  };
}

/** The complete stall-ceiling decision for one tick, as a PURE value (core#182).
 *
 *  Extracted from `recoverStalledPhase` for the same reason `stampFilmProgress` was extracted from
 *  `advanceFilmJob` in #182: inline, the only way to exercise this was to restate the comparison and
 *  the message in a test, and a test that restates its subject agrees with the subject forever
 *  whatever the subject does. The orchestrator now APPLIES this verdict and decides nothing itself.
 *
 *  `error` is the message the render dies with, and it names the BASIS -- so a kill at a derived
 *  ceiling (the module's own declared budget, exhausted) is distinguishable from a kill at the floor
 *  with nothing declared, without reading the code. */
export interface PhaseCeilingVerdict {
  ceiling: PhaseCeiling;
  ceilingAge: number;
  expired: boolean;
  error: string | null;
}

export function phaseCeilingVerdict(
  job: FilmJob,
  modules?: RegisteredModule[],
  now: number = Date.now(),
): PhaseCeilingVerdict {
  const ceiling = phaseCeiling(job, modules);
  const ceilingAge = ceilingAgeSeconds(job, now);
  const expired = ceilingAge >= ceiling.seconds;
  if (!expired) return { ceiling, ceilingAge, expired, error: null };
  const unbounded = ceiling.undeclared.length + ceiling.unresolved.length;
  const basis =
    ceiling.basis === "derived" && ceiling.longest
      ? `ceiling ${ceiling.seconds}s derived from ${ceiling.longest.module} (${FINISH_STEP_MAX_ATTEMPTS} attempts x ${ceiling.longest.seconds}s declared)`
      : `ceiling ${ceiling.seconds}s (the floor; ${unbounded} step(s) in this chain declare no per-invocation ceiling)`;
  return {
    ceiling,
    ceilingAge,
    expired,
    error: `render stalled in phase "${job.phase}" for ${Math.floor(ceilingAge / 60)}min with no progress, ${basis}; failing so it does not hang (resubmit to retry) (#129/#704/core#182)`,
  };
}

/** Progress fingerprint for the stall signal (#136): the current phase, how many of its per-shot units
 *  are done, and how many CHAIN STEPS have resolved inside those units. Monotonic within a phase (shots
 *  only go pending->done, `idx` only advances) and it changes on every phase transition, so ANY change is
 *  genuine forward progress -- which is what re-stamps last_progress_at. Phases with no per-shot fan-out
 *  (keyframe/dialogue/assemble/master/mux) report :0:0, so their stall window runs from when the phase
 *  began, exactly as before.
 *
 *  WHY STEPS AND NOT ONLY SHOTS (#182). Counting finished SHOTS made the marker blind to a shot that is
 *  working correctly through a multi-step chain: a film whose LAST remaining shot is mid-chain, or a
 *  single-shot film, produced NO marker change between the phase starting and the shot finishing, so the
 *  90min ceiling (which measures from last_progress_at) fired on work that was proceeding exactly as
 *  configured. `idx` advances only when a step actually resolves -- run (applyFinishOutput) or reused
 *  (adoptFinishStepOutput) -- and `attempts` is deliberately NOT counted, because a step retrying is not
 *  a step progressing and folding it in would let a failing shot re-stamp the clock forever.
 *
 *  WHAT THIS DOES NOT FIX, stated here because a green suite would otherwise imply it did: a chain with
 *  exactly ONE step has no intra-shot progress to observe, so a single-shot film whose finish chain is
 *  just `finish-upscale` still gets its one marker change at the very end -- which is precisely the
 *  configuration #182 describes. Four modules declare the `finish` hook (finish-upscale, finish-lipsync,
 *  finish-rife, finish-blender), so chains of 2..4 steps are ordinary and this covers them; the
 *  single-step case needs a ceiling sized to the work, not a finer marker. `tests/film-progress-marker-182`
 *  asserts that limit explicitly rather than leaving it to be discovered. */
export function filmProgressMarker(job: FilmJob, clipJob: ClipJob | null): string {
  let done = 0;
  let steps = 0;
  if (job.phase === "clips") {
    done = (clipJob?.shots || []).filter((s) => s.status === "done").length;
  } else if (job.phase === "finish") {
    const shots = job.finish_shots || [];
    done = shots.filter((fs) => fs.status === "done").length;
    steps = shots.reduce((n, fs) => n + Math.max(0, Math.trunc(fs.idx) || 0), 0);
  } else if (job.phase === "speech") {
    const shots = job.speech_shots || [];
    done = shots.filter((ss) => ss.status === "done").length;
    steps = shots.reduce((n, ss) => n + Math.max(0, Math.trunc(ss.idx) || 0), 0);
  }
  return `${job.phase}:${done}:${steps}`;
}

/** Compare-and-stamp the stall clock (#136/#704/#182). Returns true iff the marker MOVED, i.e. real
 *  forward progress happened this pass, in which case `progress_marker` and `last_progress_at` are
 *  updated in place. Extracted from advanceFilmJob so the marker's effect on the ceiling is reachable
 *  from a test: inline, the only way to exercise it was to restate these lines in the test, and a test
 *  that restates its subject's contract agrees with the subject forever whatever the subject does.
 *  `now` is injectable so tests do not depend on the wall clock. */
export function stampFilmProgress(job: FilmJob, clipJob: ClipJob | null, now: number = Date.now()): boolean {
  const marker = filmProgressMarker(job, clipJob);
  if (marker === job.progress_marker) return false;
  job.progress_marker = marker;
  job.last_progress_at = now;
  return true;
}

// --------------------------------------------------------------------------- duration honesty (#697/#698)
//
// A per-shot finish chain can deliver a TRUNCATED clip (an outlived/retried encode race adopted a
// partial write) that the pixel gate (#558) cannot catch -- it validates pixel content, not length. The
// video-finish container is the one component that downloads + normalizes every final clip, so it is the
// honest place to probe each clip`s ACTUAL assembled duration and hand it back. The Worker then (a) gates
// each clip against its PLANNED seconds, failing the render loud instead of shipping a 0.085s "4s" shot,
// and (b) times caption cues to the ACTUAL cut instead of the bundle plan (#698). One probe, both uses.

/** Default fraction of a shot`s planned seconds an assembled clip must reach before it is treated as a
 *  truncation defect (#697) rather than a legitimate beat-trim. Clamped to [0,1]; a 0 disables the gate. */
/** THE delivery resolution for a film, in ONE place.
 *
 *  Films have always shipped 1920x1080, and until now that was not a decision expressed anywhere:
 *  it was `?? 1920` and `?? 1080` defaulting INDEPENDENTLY in two panel modules that were never
 *  told anything. Nothing set it, and nothing could observe that nothing set it, because a honoured
 *  default and a substituted one are byte-identical. Single-sourcing it here means changing the
 *  estate default is one edit that cannot half-land. */
export const DEFAULT_DELIVERY_WIDTH = 1920;
/** The delivery frame rate. Same shape and same reason as the geometry: the panel modules carry
 *  `fps: input.fps ?? 24`, the identical defect in a third dimension -- a frame rate nobody decided,
 *  defaulting independently at two consumers. Sourced here so it is a decision, and carried on every
 *  seed so those `?? 24` arms stop being what picks it.
 *
 *  NOT derived from a clip's measured `delivered_fps` or a step's `out_fps`: those are what the
 *  footage IS, and this is what the film SHIPS AT. Deriving a target from a measurement is the same
 *  conflation that would assemble a 1080p film at the upscale's 2560x1440. */
export const DEFAULT_DELIVERY_FPS = 24;
export const DEFAULT_DELIVERY_HEIGHT = 1080;

/** A delivery target, plus whether it was DECIDED or merely defaulted.
 *
 *  `decided` is the load-bearing field and it is not decoration: without it, a film carrying an
 *  explicit target and a film carrying nothing return identical values, which is precisely the
 *  state the panel modules are in today. A consumer that cannot tell the two apart has rebuilt
 *  `?? 1920` with more steps. */
export interface DeliveryResolution {
  width: number;
  height: number;
  decided: boolean;
}

function positiveInt(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Resolve a film's delivery target. BOTH axes or neither: a half-supplied target is an upstream
 *  bug, not a decision, and completing it from the default would produce a confident wrong aspect
 *  ratio, which is worse than defaulting both. Total by construction -- every refusal path lands on
 *  the default, so a zero geometry (letterboxing into nothing) can never reach the container. */
export function resolveDeliveryResolution(
  job: { delivery_width?: unknown; delivery_height?: unknown },
): DeliveryResolution {
  const w = positiveInt(job?.delivery_width);
  const h = positiveInt(job?.delivery_height);
  if (w && h) return { width: w, height: h, decided: true };
  return { width: DEFAULT_DELIVERY_WIDTH, height: DEFAULT_DELIVERY_HEIGHT, decided: false };
}

export const DEFAULT_CLIP_DURATION_FLOOR = 0.5;

/** Pure: parse + clamp the per-shot duration-floor knob (env.FILM_CLIP_DURATION_FLOOR) into [0,1].
 *  Unset / non-numeric falls back to the default; out-of-range clamps (never throws). */
export function resolveClipDurationFloor(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CLIP_DURATION_FLOOR;
  return Math.min(1, Math.max(0, n));
}

/** Pure: map the video-finish container`s per-clip `clipDurations` array (same order as the clips it was
 *  handed) onto shot ids, using the finalClips order the Worker submitted. Non-numeric / negative / missing
 *  entries are dropped so absence never fabricates a duration. Returns {} when the container reported none
 *  (an older build) -- callers treat an empty map as "no evidence", never as "all zero". */
export function mapClipDurationsToShots(
  finalClips: { shot_id: string }[],
  clipDurations: unknown,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(clipDurations)) return out;
  for (let i = 0; i < finalClips.length; i++) {
    const d = clipDurations[i];
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) out[finalClips[i].shot_id] = d;
  }
  return out;
}

/** Pure: resolve each shot`s PLANNED seconds -- the bundle`s beat-trimmed target_seconds (preferred),
 *  else the authored scene seconds. Only positive values are kept (a plan of 0/unknown cannot gate). This
 *  mirrors captions.shotDuration`s resolution so the gate and the cue timeline agree on "the plan". */
export function resolvePlannedSeconds(
  scenes: { shot_id: string; seconds: number }[],
  bundleDurations: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of scenes ?? []) {
    if (!s || typeof s.shot_id !== "string") continue;
    const fromBundle = bundleDurations[s.shot_id];
    if (typeof fromBundle === "number" && Number.isFinite(fromBundle) && fromBundle > 0) { out[s.shot_id] = fromBundle; continue; }
    if (typeof s.seconds === "number" && Number.isFinite(s.seconds) && s.seconds > 0) out[s.shot_id] = s.seconds;
  }
  return out;
}

/** One shot whose assembled clip fell below the duration floor. */
export interface ClipDurationShortfall {
  shot_id: string;
  actual: number;  // probed assembled seconds
  planned: number; // resolved planned seconds
  floor: number;   // planned * fraction (the threshold it failed)
}

/** Pure per-shot duration honesty gate (#697). Flags every clip with BOTH a known actual duration and a
 *  positive plan whose actual < planned * fraction. A shot with no reported actual (older container) or no
 *  positive plan is NOT flagged -- the gate fires on EVIDENCE, never on absence, so it can never fail a
 *  film just because a duration was unavailable. A fraction of 0 flags nothing (operator off switch). */
export function findClipDurationShortfalls(
  finalClips: { shot_id: string }[],
  actual: Record<string, number>,
  planned: Record<string, number>,
  fraction: number,
): ClipDurationShortfall[] {
  const out: ClipDurationShortfall[] = [];
  for (const c of finalClips ?? []) {
    if (!c || typeof c.shot_id !== "string") continue;
    const a = actual[c.shot_id];
    const p = planned[c.shot_id];
    if (typeof a !== "number" || !Number.isFinite(a) || typeof p !== "number" || !Number.isFinite(p) || p <= 0) continue;
    const floor = p * fraction;
    if (a < floor) out.push({ shot_id: c.shot_id, actual: a, planned: p, floor });
  }
  return out;
}

/** Pure: build the caption-timeline durations map (#698) -- the ACTUAL assembled per-clip seconds win,
 *  the bundle plan fills any shot the container did not report, and captions.shotDuration falls back to
 *  the authored scene seconds for anything in neither. This is what times cues to the real cut instead of
 *  the plan (which drifts on every non-final tier where actual != planned). */
export function captionDurations(
  bundleDurations: Record<string, number>,
  actualDurations?: Record<string, number>,
): Record<string, number> {
  return { ...bundleDurations, ...(actualDurations ?? {}) };
}
