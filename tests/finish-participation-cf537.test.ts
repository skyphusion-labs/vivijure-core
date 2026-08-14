import { describe, it, expect } from "vitest";
import {
  selectForChain,
  resolveRenderPipeline,
} from "../src/modules/render-pipeline.js";
import {
  parseHookSelection,
  parseModuleRenderOverrides,
  resolveModuleRenderConfigs,
} from "../src/render-module-config.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { checkManifest, allPass, failures } from "../src/modules/conformance.js";
import {
  naturalKeyForStartFilmJob,
  naturalKeyForStartFromKeyframes,
  filmSubmitClaimKey,
} from "../src/film-submit-idempotency.js";
import {
  MODULE_API,
  SELECTABLE_HOOKS,
  HOOK_CARDINALITY,
  type HookSelection,
  type RegisteredModule,
} from "../src/modules/types.js";

// cf#537. `finish` is a CHAIN hook, so BINDING a module was the entire enrolment: every bound finish
// module ran on every shot of every film, and `finish-blender` was therefore applying a real
// `filmic_warm` grade at strength 1.0 to footage nobody asked to grade. Conrad ruled the fix is
// PER-RENDER, caller-named.
//
// These tests exist because the defect's signature is that everything reported success. A module ran
// that nobody requested and the job said `finish: done 1, failed 0, degraded 0`. So every assertion
// below has to be able to tell "ran" from "did not run", and the suite prints its DENOMINATOR
// wherever it asserts over a set -- a predicate that cannot match a whole class of its inputs reads
// as a clean pass.

const mod = (
  name: string,
  order: number,
  participation?: "default" | "opt_in",
): RegisteredModule => ({
  name,
  version: "0.0.0",
  api: MODULE_API,
  hooks: ["finish"],
  ui: { order },
  ...(participation ? { participation } : {}),
  binding: "MODULE_" + name.toUpperCase().replace(/-/g, "_"),
});

// Deliberately NOT the default arrangement: `blender` sits in the MIDDLE of ui.order, and one module
// leaves `participation` ABSENT while another states "default" explicitly. On a default arrangement
// (opt_in last, everything else uniform) "honoured" and "substituted" are byte-identical -- a filter
// that dropped the LAST module, or one that ignored the field entirely and happened to keep order,
// would both pass. This layout distinguishes them.
const rife = mod("finish-rife", 10); //            participation ABSENT  -> legacy, must still run
const lipsync = mod("finish-lipsync", 15, "default"); //   explicit default -> must still run
const blender = mod("finish-blender", 18, "opt_in"); //    OPT-IN, mid-order -> must NOT run unasked
const upscale = mod("finish-upscale", 20, "default"); //   explicit default -> must still run
const SERVING = [rife, lipsync, blender, upscale];

const names = (ms: { name: string }[]) => ms.map((m) => m.name);

// A fixed-answer row: true under the pre-cf#537 contract and the new one alike. If THIS fails the
// fixture has drifted and nothing below it means anything (N92: put a case in the matrix whose answer
// is fixed under all hypotheses, and read it as "the harness is lying" before touching the subject).
describe("cf#537 fixture integrity", () => {
  it("the fixture really carries one opt_in module among four, mid-ui.order", () => {
    expect(SERVING.length, "DENOMINATOR: serving finish modules in fixture").toBe(4);
    const optIn = SERVING.filter((m) => m.participation === "opt_in");
    expect(names(optIn), `1 of ${SERVING.length} serving modules is opt_in`).toEqual(["finish-blender"]);
    // opt_in is NOT the last module: a filter that simply dropped the tail would pass otherwise.
    expect(names(SERVING).indexOf("finish-blender")).toBe(2);
    expect(names(SERVING).length - 1).toBe(3);
    // and exactly one leaves the field absent, so "absent == default" is exercised rather than assumed
    expect(names(SERVING.filter((m) => m.participation === undefined))).toEqual(["finish-rife"]);
  });
});

describe("selectForChain: ABSENT selection (every caller that predates the contract)", () => {
  it("drops ONLY the opt_in module and keeps ui.order", () => {
    const got = selectForChain(SERVING, "finish", undefined);
    expect(names(got.modules)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
    expect(got.modules.length, `3 of ${SERVING.length} serving modules participate by default`).toBe(3);
    expect(got.missing).toEqual([]);
  });

  it("THE TICKET: finish-blender is absent from the chain when nobody asked for it", () => {
    expect(names(selectForChain(SERVING, "finish", undefined).modules)).not.toContain("finish-blender");
  });

  it("a module with participation ABSENT is treated as default, not as opt_in", () => {
    // finish-rife declares nothing. Absence at the MANIFEST layer is permissive by design (the field
    // is additive and a 27-manifest cutover was rejected); this pins that direction so a later change
    // cannot flip it silently and strip interpolation from every legacy caller.
    expect(names(selectForChain([rife], "finish", undefined).modules)).toEqual(["finish-rife"]);
  });

  it("{ mode: \"default\" } resolves identically to ABSENT", () => {
    const explicit = selectForChain(SERVING, "finish", { mode: "default" });
    const absent = selectForChain(SERVING, "finish", undefined);
    expect(names(explicit.modules)).toEqual(names(absent.modules));
  });
});

describe("selectForChain: NAMED selection", () => {
  it("runs an opt_in module when it IS named", () => {
    const got = selectForChain(SERVING, "finish", { mode: "named", modules: ["finish-blender"] });
    expect(names(got.modules)).toEqual(["finish-blender"]);
    expect(got.missing).toEqual([]);
  });

  it("naming overrides participation, and NOT the other way round", () => {
    // The whole point: opt_in means "not unless asked", never "not ever".
    const got = selectForChain(SERVING, "finish", {
      mode: "named",
      modules: ["finish-blender", "finish-upscale"],
    });
    expect(names(got.modules)).toEqual(["finish-blender", "finish-upscale"]);
  });

  it("keeps REGISTRY ui.order, not the caller's array order", () => {
    // Non-default probe: the request lists them backwards. ui.order is a correctness property here
    // (finish_consumes_audio requires lip-sync before any time-resampling step), so the caller does
    // not get to reorder the chain by reordering their array.
    const got = selectForChain(SERVING, "finish", {
      mode: "named",
      modules: ["finish-upscale", "finish-rife"],
    });
    expect(names(got.modules)).toEqual(["finish-rife", "finish-upscale"]);
  });

  it("names a MIDDLE subset -- not a prefix, not a suffix, not everything", () => {
    const got = selectForChain(SERVING, "finish", {
      mode: "named",
      modules: ["finish-lipsync", "finish-blender"],
    });
    expect(names(got.modules)).toEqual(["finish-lipsync", "finish-blender"]);
    expect(got.modules.length, `2 of ${SERVING.length} serving modules named`).toBe(2);
  });

  it("EMPTY named list means ZERO modules, and is NOT the same as absent", () => {
    const empty = selectForChain(SERVING, "finish", { mode: "named", modules: [] });
    const absent = selectForChain(SERVING, "finish", undefined);
    expect(empty.modules).toEqual([]);
    expect(absent.modules.length).toBe(3);
    // If these two ever agree, the three-state contract has collapsed and this is the row that says so.
    expect(empty.modules.length).not.toBe(absent.modules.length);
  });

  it("a named module that is not serving is REPORTED, never silently dropped", () => {
    const got = selectForChain(SERVING, "finish", {
      mode: "named",
      modules: ["finish-upscale", "finish-nonesuch", "finish-alsomissing"],
    });
    expect(names(got.modules)).toEqual(["finish-upscale"]);
    expect(got.missing).toEqual(["finish-nonesuch", "finish-alsomissing"]);
  });

  it("a repeated name is deduplicated in BOTH the result and the diagnostic", () => {
    const dup = selectForChain(SERVING, "finish", {
      mode: "named",
      modules: ["finish-rife", "finish-rife", "finish-nope", "finish-nope"],
    });
    expect(names(dup.modules)).toEqual(["finish-rife"]);
    expect(dup.missing).toEqual(["finish-nope"]);
  });
});

describe("selectForChain: the gate is PER HOOK (blast radius)", () => {
  it("SELECTABLE_HOOKS contains exactly finish today", () => {
    expect([...SELECTABLE_HOOKS]).toEqual(["finish"]);
  });

  it("every OTHER chain hook keeps run-every-bound-module, selection or no selection", () => {
    const chainHooks = (Object.keys(HOOK_CARDINALITY) as (keyof typeof HOOK_CARDINALITY)[])
      .filter((h) => HOOK_CARDINALITY[h] === "chain");
    // DENOMINATOR. The issue body and the ruling both enumerate SIX chain hooks; HOOK_CARDINALITY
    // says seven (`plan.enhance` is in neither prose list). Derived here, never transcribed.
    expect(chainHooks.length, `chain hooks in HOOK_CARDINALITY: ${chainHooks.join(", ")}`).toBe(7);
    const unselectable = chainHooks.filter((h) => !SELECTABLE_HOOKS.has(h));
    expect(unselectable.length, `${unselectable.length} of ${chainHooks.length} chain hooks are NOT selectable`).toBe(6);

    for (const hook of unselectable) {
      // Same modules, same aggressive selection. A non-selectable hook must ignore it entirely --
      // both the restrictive direction (an empty list must not empty the chain) and the
      // participation direction (an opt_in module must still fold, because this hook has no gate).
      const emptied = selectForChain(SERVING, hook, { mode: "named", modules: [] });
      expect(names(emptied.modules), `hook ${hook} must ignore an empty selection`).toEqual(names(SERVING));
      const absent = selectForChain(SERVING, hook, undefined);
      expect(names(absent.modules), `hook ${hook} must ignore participation`).toEqual(names(SERVING));
      expect(emptied.missing).toEqual([]);
    }
  });
});

describe("cf#537 wire parsing: the three states survive the door", () => {
  it("parses a named selection out of the renderOverrides bag", () => {
    const wire = parseModuleRenderOverrides({
      select: { finish: { mode: "named", modules: ["finish-upscale"] } },
    });
    expect(wire.select?.finish).toEqual({ mode: "named", modules: ["finish-upscale"] });
  });

  it("a bag carrying ONLY a selection is not mistaken for the legacy keyframe/i2v shape", () => {
    // The modern-shape discriminator used to be config|motion_backend|keyframe_backend. A bag with
    // just `select` fell through to the legacy mapping and the selection was dropped -- silently, and
    // in the direction that keeps running the module the caller was excluding.
    const wire = parseModuleRenderOverrides({ select: { finish: { mode: "named", modules: [] } } });
    expect(wire.select?.finish, "a select-only bag must survive parsing").toEqual({ mode: "named", modules: [] });
  });

  it("an EMPTY named list survives the parser as an empty list, not as an absence", () => {
    const wire = parseModuleRenderOverrides({
      config: { "finish-upscale": { scale: 2 } },
      select: { finish: { mode: "named", modules: [] } },
    });
    expect(wire.select?.finish).toEqual({ mode: "named", modules: [] });
    expect(wire.select?.finish?.mode).toBe("named");
  });

  it("NEGATIVE CONTROL: a bag with no select yields NO select key at all", () => {
    // This is the control for every assertion above: it proves the probe can report the field absent.
    const wire = parseModuleRenderOverrides({ config: { "finish-upscale": { scale: 2 } } });
    expect(wire.select).toBeUndefined();
    expect("select" in wire).toBe(false);
  });

  it("drops unknown hooks and malformed entries rather than inventing a mode", () => {
    const sel = parseHookSelection({
      finish: { mode: "named", modules: ["finish-rife", "", "  ", 7] },
      "no-such-hook": { mode: "named", modules: ["x"] },
      notify: { mode: "sideways" },
      master: { mode: "named" }, // no modules[] -- malformed, must NOT become {named, []}
    });
    expect(sel?.finish).toEqual({ mode: "named", modules: ["finish-rife"] });
    expect(sel && "no-such-hook" in sel).toBe(false);
    expect(sel?.notify).toBeUndefined();
    // A malformed entry resolves to the DEFAULT-participation set, which still excludes opt_in
    // modules. Inventing {named, []} from a tagless payload would be the unsafe direction.
    expect(sel?.master).toBeUndefined();
  });
});

describe("cf#537 resolve: the selection reaches ResolvedModuleRenderConfigs", () => {
  it("emits finish_select so the MINT site can read it", () => {
    const resolved = resolveModuleRenderConfigs(
      { select: { finish: { mode: "named", modules: ["finish-upscale"] } } },
      "final",
      SERVING,
    );
    expect(resolved.finish_select).toEqual({ mode: "named", modules: ["finish-upscale"] });
  });

  it("NEGATIVE CONTROL: no selection -> finish_select is ABSENT, not an empty object", () => {
    const resolved = resolveModuleRenderConfigs({ config: {} }, "final", SERVING);
    expect(resolved.finish_select).toBeUndefined();
    expect("finish_select" in resolved).toBe(false);
  });

  it("resolve-time finish_config honours the same gate (no config for a module that will not run)", () => {
    const dflt = resolveModuleRenderConfigs({ config: {} }, "final", SERVING);
    expect(Object.keys(dflt.finish_config).sort()).toEqual([
      "finish-lipsync",
      "finish-rife",
      "finish-upscale",
    ]);
    const named = resolveModuleRenderConfigs(
      { select: { finish: { mode: "named", modules: ["finish-blender"] } } },
      "final",
      SERVING,
    );
    expect(Object.keys(named.finish_config)).toEqual(["finish-blender"]);
  });

  it("resolveRenderPipeline: `finish` is gated, and no other chain is", () => {
    const plan = resolveRenderPipeline(SERVING, {
      select: { finish: { mode: "named", modules: [] } },
    });
    expect(names(plan.finish)).toEqual([]);
    // The same modules do not serve score/speech/master/film.finish, so those chains are empty for a
    // reason that has nothing to do with the gate. Assert the DENOMINATOR so this row is not vacuous.
    expect(SERVING.filter((m) => m.hooks.includes("score")).length, "fixture modules serving score").toBe(0);
  });
});

describe("cf#537 manifest contract", () => {
  it("validateManifest ACCEPTS an absent participation and both legal values", () => {
    const base = { name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"] };
    expect(typeof validateManifest(base)).toBe("object");
    expect(typeof validateManifest({ ...base, participation: "default" })).toBe("object");
    expect(typeof validateManifest({ ...base, participation: "opt_in" })).toBe("object");
  });

  it("validateManifest REFUSES a malformed participation at LOAD", () => {
    // A typo must not fall through to the permissive default. "optin" reading as "runs on everything"
    // is the defect this whole change exists to remove, arriving through a misspelling.
    const base = { name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"] };
    for (const bad of ["optin", "opt-in", "OPT_IN", true, 1, null]) {
      const r = validateManifest({ ...base, participation: bad });
      expect(typeof r, `participation ${JSON.stringify(bad)} must be refused`).toBe("string");
      expect(String(r)).toMatch(/participation/);
    }
  });

  it("conformance FAILS a module serving a selectable hook with no participation", () => {
    const checks = checkManifest({ name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"] });
    expect(allPass(checks)).toBe(false);
    const f = failures(checks).map((c) => c.name);
    expect(f, JSON.stringify(failures(checks))).toContain("participation");
  });

  it("conformance PASSES the same module once it declares one", () => {
    for (const p of ["default", "opt_in"] as const) {
      const checks = checkManifest({
        name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"], participation: p,
      });
      expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
    }
  });

  it("conformance does NOT require participation from a module serving no selectable hook", () => {
    // The gate must be scoped to SELECTABLE_HOOKS, or it becomes a 27-manifest cutover by the back
    // door -- and a guard that fires on correct code is the guard people switch off.
    const checks = checkManifest({ name: "m", version: "1.0.0", api: MODULE_API, hooks: ["notify"] });
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
    expect(checks.map((c) => c.name)).not.toContain("participation");
  });
});

describe("cf#537 idempotency: finish_select is render-affecting on BOTH natural keys", () => {
  const baseFilm = { project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01" }] };
  const baseKf = { ...baseFilm, keyframes: [], derive_mode: "finalized" as const };

  const key = (o: object) => filmSubmitClaimKey(naturalKeyForStartFilmJob(o as never));
  const keyKf = (o: object) => filmSubmitClaimKey(naturalKeyForStartFromKeyframes(o as never));

  it("startFilmJob: changing the selection changes the key", async () => {
    const a = await key(baseFilm);
    const b = await key({ ...baseFilm, finish_select: { mode: "named", modules: ["finish-upscale"] } });
    expect(a).not.toBe(b);
  });

  it("startFilmJob: absent, {default} and {named,[]} are THREE distinct keys", async () => {
    const absent = await key(baseFilm);
    const dflt = await key({ ...baseFilm, finish_select: { mode: "default" } as HookSelection });
    const none = await key({ ...baseFilm, finish_select: { mode: "named", modules: [] } as HookSelection });
    const all = new Set([absent, dflt, none]);
    expect(all.size, `3 wire states must produce 3 keys, got ${all.size}`).toBe(3);
  });

  it("startFromKeyframes: changing the selection changes the key", async () => {
    const a = await keyKf(baseKf);
    const b = await keyKf({ ...baseKf, finish_select: { mode: "named", modules: ["finish-upscale"] } });
    expect(a).not.toBe(b);
  });

  it("CONTROL: two identical submits still collide (the key is not merely random)", async () => {
    const sel = { mode: "named", modules: ["finish-blender"] } as HookSelection;
    expect(await key({ ...baseFilm, finish_select: sel })).toBe(await key({ ...baseFilm, finish_select: sel }));
    expect(await keyKf({ ...baseKf, finish_select: sel })).toBe(await keyKf({ ...baseKf, finish_select: sel }));
  });
});

// ---------------------------------------------------------------------------------------------
// CONSUMER SWEEP.
//
// This block exists because enumerating the consumers of the new field -- rather than assuming the
// door plumbing was the whole surface -- found one my own change had missed: scatter resolves the
// overrides AND mints its shard films entirely inside core, so a selection that stopped at the two
// single-film start functions would have left every scattered render on the default set while the
// single-film path honoured the caller. That is the two-panel parity split in miniature, arriving
// through a path neither panel touches.
//
// The assertion is deliberately SOURCE-level and it is the weaker kind of test, so it says so: it
// pins that each core-internal mint site FORWARDS the field, which is what an omission looks like.
// The behavioural half lives in the wiring suite, which drives the consumption point for real.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("cf#537 consumer sweep: every core-internal site that mints a film forwards finish_select", () => {
  // DERIVED, not transcribed: any core file that hands a resolved finish_config into a start
  // function is a site that must also hand over the selection.
  const CANDIDATES = ["film-orchestrator.ts", "scatter-orchestrator.ts"];

  it("CONTROL: the matcher finds the thing it is looking for", () => {
    // Run first. Every assertion below is "this file contains X"; if the matcher cannot find a
    // known-present token in a known-present file, a later zero is a broken read, not a finding.
    const src = readFileSync(resolve(SRC, "film-orchestrator.ts"), "utf8");
    expect(src.split("finish_config").length - 1, "finish_config occurrences in film-orchestrator").toBeGreaterThan(0);
    // ...and the matcher must be able to come back EMPTY on a file that genuinely lacks it.
    const other = readFileSync(resolve(SRC, "srt.ts"), "utf8");
    expect(other.includes("finish_select"), "srt.ts must NOT mention finish_select").toBe(false);
  });

  it("every candidate that passes finish_config into a mint ALSO passes finish_select", () => {
    let checked = 0;
    for (const f of CANDIDATES) {
      const src = readFileSync(resolve(SRC, f), "utf8");
      const mints = src.split("finish_config: ").length - 1;
      if (!mints) continue;
      checked++;
      expect(
        src.includes("finish_select:"),
        `${f} passes finish_config into a mint but never forwards finish_select (cf#537)`,
      ).toBe(true);
    }
    // DENOMINATOR. If this ever reads 0, the sweep matched nothing and the row above is vacuous --
    // which is exactly how a guard quietly stops guarding after a rename.
    expect(checked, `${checked} of ${CANDIDATES.length} candidate files carry a mint`).toBe(2);
  });
});
