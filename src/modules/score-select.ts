// vivijure-cf#878: select a `score` module by its declared kind.
//
// The score hook carries three products a film can use together: a music bed, narration, and a beat
// plan. Each module declares which one in `score_kind`. This file is the one place a host picks a
// score module, so no caller infers a kind from config keys (the defect #878 removes: `prompt` meant
// music, `text` meant narration, `clip_seconds` meant beat).
//
// Within a kind the rule is the standard pick_one rule: an explicit choice wins, else the first
// module by ui.order. Every refusal says why, by name.

import { servingForHook } from "./registry.js";
import { SCORE_KINDS, type RegisteredModule, type ScoreKind } from "./types.js";

export type ScorePick = { ok: true; module: RegisteredModule } | { ok: false; error: string };

/** Score modules that declare `kind`, in ui.order. */
export function scoreModulesOfKind(modules: RegisteredModule[], kind: ScoreKind): RegisteredModule[] {
  return servingForHook(modules, "score").filter((m) => m.score_kind === kind);
}

/** Names of score modules that declare no valid kind. They are never selected. */
export function undeclaredScoreModules(modules: RegisteredModule[]): string[] {
  return servingForHook(modules, "score")
    .filter((m) => !(SCORE_KINDS as readonly unknown[]).includes(m.score_kind))
    .map((m) => m.name);
}

/** Pick the score module that serves `kind`, or say why there is none. */
export function pickScoreModule(modules: RegisteredModule[], kind: ScoreKind, choice?: string): ScorePick {
  const named = choice?.trim();
  if (named) {
    const m = servingForHook(modules, "score").find((x) => x.name === named);
    if (!m) return { ok: false, error: `score module "${named}" is not installed` };
    if (m.score_kind === undefined) {
      return { ok: false, error: `score module "${named}" declares no score_kind, so it cannot serve ${kind} (vivijure-cf#878)` };
    }
    if (m.score_kind !== kind) {
      return { ok: false, error: `score module "${named}" is a ${m.score_kind} module, not a ${kind} module` };
    }
    return { ok: true, module: m };
  }
  const first = scoreModulesOfKind(modules, kind)[0];
  if (first) return { ok: true, module: first };
  const undeclared = undeclaredScoreModules(modules);
  return {
    ok: false,
    error: `no ${kind} score module installed` +
      (undeclared.length ? ` (${undeclared.join(", ")} declare${undeclared.length === 1 ? "s" : ""} no score_kind and ${undeclared.length === 1 ? "is" : "are"} not used; vivijure-cf#878)` : ""),
  };
}
