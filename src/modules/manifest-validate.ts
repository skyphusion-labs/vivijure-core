// Pure manifest validation (shared by registry + conformance harness).

import {
  HOOK_NAMES,
  MODULE_API,
  SCORE_KINDS,
  SUPPORTED_MODULE_APIS,
  type ModuleManifest,
} from "./types.js";
import { parseMotionUsage } from "../motion-usage.js";
import { LINE_WAV_MAX_SECONDS } from "../wav-duration.js";

/** Validate a parsed manifest enough to trust it in the registry. Returns the typed manifest or a
 *  reason string. We check the contract version, a name, and that every declared hook is known. */
export function validateManifest(raw: unknown): ModuleManifest | string {
  if (!raw || typeof raw !== "object") return "manifest is not an object";
  const m = raw as Record<string, unknown>;
  if (!(SUPPORTED_MODULE_APIS as ReadonlySet<string>).has(String(m.api)))
    return `unsupported api ${String(m.api)} (core speaks ${MODULE_API}, accepts ${[...SUPPORTED_MODULE_APIS].join(", ")})`;
  if (typeof m.name !== "string" || !m.name) return "manifest missing name";
  if (typeof m.version !== "string" || !m.version) return "manifest missing version";
  if (!Array.isArray(m.hooks) || m.hooks.length === 0) return "manifest declares no hooks";
  const known = new Set<string>(HOOK_NAMES);
  const bad = (m.hooks as unknown[]).filter((h) => !known.has(h as string));
  if (bad.length) return `manifest declares unknown hooks: ${bad.join(", ")}`;
  // core#507: a malformed `requires` would silently never fire, so it is refused at load.
  if (m.config_schema !== undefined && m.config_schema !== null && typeof m.config_schema === "object") {
    for (const [key, f] of Object.entries(m.config_schema as Record<string, unknown>)) {
      const req = (f as { requires?: unknown } | null)?.requires;
      if (req === undefined) continue;
      if (!Array.isArray(req)) return `config_schema.${key}.requires is not an array`;
      for (const r of req as unknown[]) {
        const rule = r as Record<string, unknown> | null;
        const w = rule?.when;
        if (!rule || typeof rule !== "object" || !["string", "number", "boolean"].includes(typeof w))
          return `config_schema.${key}.requires rule needs a when value`;
        const ss = rule.shot_seconds as Record<string, unknown> | undefined;
        const num = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
        if (!ss || typeof ss !== "object" || (ss.min === undefined && ss.max === undefined) || !num(ss.min) || !num(ss.max))
          return `config_schema.${key}.requires rule needs shot_seconds with a numeric min or max`;
        if (rule.message !== undefined && typeof rule.message !== "string")
          return `config_schema.${key}.requires rule message must be a string`;
      }
    }
  }
  if (m.finish_artifacts !== undefined) {
    const fa = m.finish_artifacts as Record<string, unknown>;
    if (!fa || typeof fa !== "object") return "finish_artifacts is not an object";
    const ok = fa.output_key as Record<string, unknown> | undefined;
    if (!ok || typeof ok !== "object") return "finish_artifacts.output_key missing";
    if (ok.kind === "shot_named") {
      if (typeof ok.filename !== "string" || !ok.filename) return "finish_artifacts.output_key.filename missing";
    } else if (ok.kind === "append_suffix") {
      if (typeof ok.suffix !== "string" || !ok.suffix) return "finish_artifacts.output_key.suffix missing";
    } else {
      return `finish_artifacts.output_key.kind ${JSON.stringify(ok.kind)} unknown (shot_named | append_suffix)`;
    }
    if (fa.applied !== undefined) {
      if (!Array.isArray(fa.applied)) return "finish_artifacts.applied is not an array";
      for (const r of fa.applied as unknown[]) {
        const rule = r as Record<string, unknown>;
        if (!rule || typeof rule !== "object" || typeof rule.tag !== "string" || !rule.tag)
          return "finish_artifacts.applied rule missing tag";
        if (rule.when !== undefined) {
          const w = rule.when as Record<string, unknown>;
          if (!w || typeof w !== "object" || typeof w.knob !== "string" || !w.knob || w.equals === undefined)
            return "finish_artifacts.applied rule has a malformed when clause";
        }
      }
    }
  }
  if (m.keyframe_label !== undefined) {
    if (typeof m.keyframe_label !== "string" || !m.keyframe_label.trim())
      return "keyframe_label must be a non-empty string";
  }
  // cf#537: refuse a malformed participation value at LOAD rather than coercing it. The field's
  // default is permissive, so a typo ("optin", "opt-in", true) that fell through to the default would
  // silently put an opt-in module back on every render -- the failure would look exactly like the
  // module never having declared anything. Absent stays legal; wrong does not.
  if (m.participation !== undefined && m.participation !== "default" && m.participation !== "opt_in") {
    return `participation ${JSON.stringify(m.participation)} unknown (default | opt_in)`;
  }
  // core#182: refuse a malformed ceiling at LOAD rather than coercing it, exactly as `participation`
  // above. The core multiplies this value by FINISH_STEP_MAX_ATTEMPTS to size a phase deadline, so a
  // string "1200", a 0, a negative or a NaN that fell through would either read as UNDECLARED (and be
  // reported as an absence the module does not have) or silently produce a deadline of zero, failing
  // a healthy render at the first tick. Absent stays legal and means undeclared; wrong does not load.
  if (m.max_invocation_seconds !== undefined) {
    const v = m.max_invocation_seconds;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      return `max_invocation_seconds ${JSON.stringify(v)} must be a positive finite number of seconds`;
  }
  // vivijure-cf#878: a malformed score_kind does not load. Read as absent, it would leave a module that
  // tried to declare itself unselectable with an error naming the wrong cause.
  if (m.score_kind !== undefined && !(SCORE_KINDS as readonly unknown[]).includes(m.score_kind)) {
    return `score_kind ${JSON.stringify(m.score_kind)} unknown (${SCORE_KINDS.join(" | ")})`;
  }
  if (m.usage !== undefined && !parseMotionUsage(m.usage)) {
    return "usage is present but not a valid MotionUsageDecl (native_audio, voice, scatter_native_audio, min_seconds, max_seconds)";
  }
  // core#464: a declared audio floor that cannot be used must not load. Dropping it would hand the door a
  // line shorter than it accepts, and the provider would refuse the clip after the film was paid for.
  if (m.usage && typeof m.usage === "object" && "driving_audio_min_seconds" in (m.usage as object)) {
    const v = (m.usage as Record<string, unknown>).driving_audio_min_seconds;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > LINE_WAV_MAX_SECONDS)
      return `usage.driving_audio_min_seconds ${JSON.stringify(v)} must be a number of seconds above 0 and at most ${LINE_WAV_MAX_SECONDS}`;
  }
  return m as unknown as ModuleManifest;
}
