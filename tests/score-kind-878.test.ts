// vivijure-cf#878 (ruling A): a score module declares what it produces in `score_kind`, and the host
// picks one module within a kind. Config keys never decide it.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { checkManifest } from "../src/modules/conformance.js";
import { hookCatalog } from "../src/modules/registry.js";
import { pickOneForHook, resolveRenderPipeline } from "../src/modules/render-pipeline.js";
import { pickScoreModule, scoreModulesOfKind, undeclaredScoreModules } from "../src/modules/score-select.js";
import { HOOK_CARDINALITY, MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import { beatSyncScoreModules } from "../src/beat-analyze.js";

const score = (name: string, order: number, kind?: string, schema: Record<string, unknown> = {}): RegisteredModule => ({
  name, version: "1", api: MODULE_API, hooks: ["score"], binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`,
  config_schema: schema, ui: { section: "score", order }, ...(kind ? { score_kind: kind } : {}),
} as unknown as RegisteredModule);

// The installed set as the studio serves it, by ui.order: music first.
const MUSIC = score("music-gen", 10, "music", { prompt: { type: "string", default: "" } });
const NARRATION = score("narration-gen", 20, "narration", { text: { type: "string", default: "" } });
const BEAT = score("beat-sync", 30, "beat", { clip_seconds: { type: "float", default: 8 } });
const ALL = [BEAT, NARRATION, MUSIC];

describe("score_kind at load and at conformance (vivijure-cf#878)", () => {
  const manifest = (extra: Record<string, unknown>) => ({ api: MODULE_API, name: "m", version: "1", hooks: ["score"], ...extra });
  it("a malformed kind does not load; an absent one does", () => {
    expect(validateManifest(manifest({ score_kind: "song" }))).toMatch(/score_kind "song" unknown \(music \| narration \| beat\)/);
    expect(typeof validateManifest(manifest({}))).toBe("object");
    expect(typeof validateManifest(manifest({ score_kind: "music" }))).toBe("object");
  });
  it("a score module with no kind fails conformance, and one with a kind passes", () => {
    expect(checkManifest(manifest({})).find((c) => c.name === "score-kind")?.pass).toBe(false);
    expect(checkManifest(manifest({ score_kind: "beat" })).find((c) => c.name === "score-kind")?.pass).toBe(true);
  });
  it("CONTROL: a module that does not serve score is not asked", () => {
    expect(checkManifest({ api: MODULE_API, name: "k", version: "1", hooks: ["keyframe"] }).some((c) => c.name === "score-kind")).toBe(false);
  });
});

describe("pickScoreModule picks within a kind (vivijure-cf#878)", () => {
  it("each kind gets its own module, whatever ui.order says", () => {
    expect(pickScoreModule(ALL, "music")).toMatchObject({ ok: true, module: { name: "music-gen" } });
    expect(pickScoreModule(ALL, "narration")).toMatchObject({ ok: true, module: { name: "narration-gen" } });
    expect(pickScoreModule(ALL, "beat")).toMatchObject({ ok: true, module: { name: "beat-sync" } });
  });
  it("CONTROL: the plain pick_one rule this replaces sends a narration request to music-gen", () => {
    expect(pickOneForHook(ALL, "score", undefined)?.name).toBe("music-gen");
  });
  it("an explicit choice wins within the kind, by ui.order otherwise", () => {
    const second = score("music-alt", 15, "music");
    expect(pickScoreModule([...ALL, second], "music")).toMatchObject({ module: { name: "music-gen" } });
    expect(pickScoreModule([...ALL, second], "music", "music-alt")).toMatchObject({ ok: true, module: { name: "music-alt" } });
  });
  it("a choice of the wrong kind, an undeclared module, or an unknown name is refused by name", () => {
    expect(pickScoreModule(ALL, "narration", "music-gen")).toEqual({ ok: false, error: 'score module "music-gen" is a music module, not a narration module' });
    const legacy = score("legacy-score", 1, undefined, { text: { type: "string", default: "" } });
    expect(pickScoreModule([...ALL, legacy], "narration", "legacy-score")).toMatchObject({ ok: false, error: expect.stringContaining('"legacy-score" declares no score_kind') });
    expect(pickScoreModule(ALL, "music", "nope")).toEqual({ ok: false, error: 'score module "nope" is not installed' });
  });
  it("a module with no kind is never picked, even first by ui.order and even with the old config key", () => {
    const legacy = score("legacy-score", 1, undefined, { text: { type: "string", default: "" } });
    expect(pickScoreModule([legacy, MUSIC], "narration")).toEqual({
      ok: false,
      error: "no narration score module installed (legacy-score declares no score_kind and is not used; vivijure-cf#878)",
    });
    expect(undeclaredScoreModules([legacy, MUSIC])).toEqual(["legacy-score"]);
    expect(scoreModulesOfKind([legacy, MUSIC], "music").map((m) => m.name)).toEqual(["music-gen"]);
  });
});

describe("the contract and its consumers (vivijure-cf#878)", () => {
  it("score is one per kind, and the catalog says so", () => {
    expect(HOOK_CARDINALITY.score).toBe("pick_one_per_kind");
    expect(hookCatalog().find((h) => h.name === "score")?.cardinality).toBe("pick_one_per_kind");
  });
  it("the render pipeline resolves one score module per kind, and honours a per-kind choice", () => {
    const second = score("music-alt", 15, "music");
    expect(resolveRenderPipeline([...ALL, second]).score.map((m) => m.name)).toEqual(["music-gen", "narration-gen", "beat-sync"]);
    expect(resolveRenderPipeline([...ALL, second], { score_choice: { music: "music-alt" } }).score.map((m) => m.name))
      .toEqual(["music-alt", "narration-gen", "beat-sync"]);
  });
  it("beat analysis finds its module by kind, not by a clip_seconds key", () => {
    const keyOnly = score("old-beat", 1, undefined, { clip_seconds: { type: "float", default: 8 } });
    const kindOnly = score("new-beat", 2, "beat", {});
    expect(beatSyncScoreModules([keyOnly, kindOnly, MUSIC]).map((m) => m.name)).toEqual(["new-beat"]);
  });
});
