// vivijure-core#339: the one place a host picks the module that serves `dialogue`.
//
// `dialogue` is pick_one. Five sites in the film orchestrator each took
// `servingForHook(modules, "dialogue")[0]`, so the module that ran was the first by ui.order,
// whatever the caller chose. The studio offers more than one dialogue module (dialogue-gen and
// chatterbox both serve the hook), so the module a user picked was not the module that ran.
//
// The rule, the standard pick_one rule (as pickScoreModule for score):
// - A caller selection (`dialogue_backend`, persisted on the film job) wins. A name that does not
//   serve `dialogue` is REFUSED by name. It is never replaced with the default.
// - No selection: the first serving module by ui.order, which is the behaviour before #339.
// - Nothing installed and no selection: `module` is undefined, and each caller keeps its own
//   no-module path (the pre-clip leg fails, the post-clip leg degrades to a silent film).
//
// tests/dialogue-select-339.test.ts fails if any file in src/ picks a dialogue module another way.

import { servingForHook } from "./registry.js";
import type { RegisteredModule } from "./types.js";

export type DialoguePick = { ok: true; module: RegisteredModule | undefined } | { ok: false; error: string };

/** Every module serving `dialogue`, in ui.order. For the resolver, which clamps the config the caller sent each one. */
export function dialogueModules(modules: RegisteredModule[]): RegisteredModule[] {
  return servingForHook(modules, "dialogue");
}

export function pickDialogueModule(modules: RegisteredModule[], choice?: string | null): DialoguePick {
  const serving = dialogueModules(modules);
  const named = typeof choice === "string" ? choice.trim() : "";
  if (!named) return { ok: true, module: serving[0] };
  const m = serving.find((x) => x.name === named);
  if (m) return { ok: true, module: m };
  const installed = modules.some((x) => x.name === named);
  return {
    ok: false,
    error: installed
      ? `dialogue module "${named}" does not serve the dialogue hook`
      : `dialogue module "${named}" is not installed`,
  };
}
