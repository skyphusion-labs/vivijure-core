import { describe, expect, it } from "vitest";
import { STORYBOARD_MAX_SCENES, STORYBOARD_MAX_SECONDS, validateStoryboard } from "../src/storyboard-validate.js";
import { buildPlanningSystemPrompt, buildRefinementSystemPrompt, PLANNER_ASK_MAX_SCENES } from "../src/planner-prompt.js";
import { assembleFilmByteCeiling, R2_SINGLE_PUT_BYTES } from "../src/assemble-admission.js";

// vivijure-core#455 (vivijure-cf#1122 stage 3): a board takes up to 600 shots and 60 minutes stated,
// and the planner still asks for 50 in one turn.

const board = (scenes: number, extra: Record<string, unknown> = {}) => ({
  title: "harbor",
  full_prompt: "A fishing harbor from dawn to dusk.",
  style_prefix: "photoreal, 35mm",
  use_characters: [],
  scenes: Array.from({ length: scenes }, (_u, i) => ({ prompt: `The harbor, shot ${i + 1}, boats at rest.` })),
  ...extra,
});

describe("the storyboard caps (vivijure-core#455)", () => {
  it("accepts 600 scenes and refuses 601 with the count", () => {
    expect(validateStoryboard(board(STORYBOARD_MAX_SCENES)).ok).toBe(true);
    const over = validateStoryboard(board(STORYBOARD_MAX_SCENES + 1));
    expect(!over.ok && over.errors.some((e) => e.includes(`scenes count ${STORYBOARD_MAX_SCENES + 1} exceeds the hard cap of ${STORYBOARD_MAX_SCENES}`))).toBe(true);
  });
  it("accepts a stated 3600 s and refuses 3601 s", () => {
    expect(validateStoryboard(board(2, { duration_seconds: STORYBOARD_MAX_SECONDS })).ok).toBe(true);
    const over = validateStoryboard(board(2, { duration_seconds: STORYBOARD_MAX_SECONDS + 1 }));
    expect(!over.ok && over.errors.some((e) => e.includes("cap is 3600s"))).toBe(true);
  });
  it("CONTROL: the old 50 scene cap no longer refuses a 51 scene board", () => {
    expect(validateStoryboard(board(51)).ok).toBe(true);
  });
});

describe("the planner asks for 50 scenes, not the board cap (vivijure-core#455)", () => {
  it("both prompts carry the ask, and neither carries the board cap", () => {
    for (const prompt of [buildPlanningSystemPrompt(), buildRefinementSystemPrompt()]) {
      expect(prompt).toContain(`at most ${PLANNER_ASK_MAX_SCENES} entries`);
      expect(prompt).not.toContain(`at most ${STORYBOARD_MAX_SCENES} entries`);
    }
  });
});

describe("the larger bed reserve does not move admission (vivijure-core#455)", () => {
  it("the byte ceiling is still one R2 PUT", () => {
    expect(assembleFilmByteCeiling()).toBe(R2_SINGLE_PUT_BYTES);
  });
});
