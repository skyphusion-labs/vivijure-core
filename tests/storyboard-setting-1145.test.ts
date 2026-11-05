import { describe, expect, it } from "vitest";
import { SETTING_MAX_CHARS, validateStoryboard } from "../src/storyboard-validate.js";
import { serializeStoryboardYaml } from "../src/planner-yaml.js";
import { buildPlanningSystemPrompt, buildRefinementSystemPrompt } from "../src/planner-prompt.js";

// vivijure-cf#1145: a shot whose prompt names no place lost the film's place. `setting` is the film's place, said
// by the renderer on any shot that does not already say it. It is optional and additive.
const board = (extra: Record<string, unknown> = {}) => ({
  title: "night shift",
  full_prompt: "Two adult engineers repair a failed generator in a dim workshop overnight.",
  style_prefix: "photoreal, 35mm",
  use_characters: ["A"],
  scenes: [{ prompt: "Mara wipes grease from her hands and frowns at a gauge.", character_slots: ["A"] }],
  ...extra,
});

describe("storyboard setting (vivijure-cf#1145)", () => {
  it("is kept, trimmed, when set", () => {
    const r = validateStoryboard(board({ setting: "  a dim workshop at night " }));
    expect(r.ok && r.value.setting).toBe("a dim workshop at night");
  });

  it("is absent when not set, so an old board validates exactly as before", () => {
    const r = validateStoryboard(board());
    expect(r.ok).toBe(true);
    expect(r.ok && "setting" in r.value).toBe(false);
  });

  it("is absent when blank", () => {
    const r = validateStoryboard(board({ setting: "   " }));
    expect(r.ok && "setting" in r.value).toBe(false);
  });

  it("is refused when not a string", () => {
    const r = validateStoryboard(board({ setting: 3 }));
    expect(!r.ok && r.errors.some((e) => e.startsWith("setting must be a string"))).toBe(true);
  });

  it("is refused over the cap, and accepted at it", () => {
    const at = validateStoryboard(board({ setting: "x".repeat(SETTING_MAX_CHARS) }));
    expect(at.ok).toBe(true);
    const over = validateStoryboard(board({ setting: "x".repeat(SETTING_MAX_CHARS + 1) }));
    expect(!over.ok && over.errors.some((e) => e.includes(`cap is ${SETTING_MAX_CHARS}`))).toBe(true);
  });

  it("is refused across lines", () => {
    const r = validateStoryboard(board({ setting: "a workshop\nat night" }));
    expect(!r.ok && r.errors.includes("setting must be one line")).toBe(true);
  });

  it("reaches the bundle's storyboard.yaml when set", () => {
    const r = validateStoryboard(board({ setting: 'a "dim" workshop' }));
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(serializeStoryboardYaml(r.value)).toContain('setting: "a \\"dim\\" workshop"');
  });

  it("leaves the yaml byte for byte unchanged when not set", () => {
    const a = validateStoryboard(board());
    const b = validateStoryboard(board({ setting: "" }));
    if (!a.ok || !b.ok) throw new Error("invalid");
    const y = serializeStoryboardYaml(a.value);
    expect(y).not.toMatch(/^setting:/m);
    expect(serializeStoryboardYaml(b.value)).toBe(y);
  });

  it("the planner is asked to fill it, and its worked example does", () => {
    const p = buildPlanningSystemPrompt();
    expect(p).toContain('"setting": string');
    expect(p).toContain('"setting": "a misty hilltop at dawn"');
    expect(p).toContain(`at most\n  ${SETTING_MAX_CHARS} characters`);
  });

  it("a refine keeps it", () => {
    const p = buildRefinementSystemPrompt();
    expect(p).toContain('"setting": string');
    expect(p).toContain("setting: KEEP it");
  });
});
