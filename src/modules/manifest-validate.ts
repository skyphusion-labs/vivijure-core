// Pure manifest validation (shared by registry + conformance harness).

import {
  HOOK_NAMES,
  MODULE_API,
  SUPPORTED_MODULE_APIS,
  type ModuleManifest,
} from "./types.js";

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
  return m as unknown as ModuleManifest;
}
