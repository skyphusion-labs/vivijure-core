// vivijure-core#473: a refine caps what ONE TURN adds or rewrites, never the board's length. A board
// over PLANNER_ASK_MAX_SCENES must not be told to come back at that size or smaller.
import { describe, expect, it } from "vitest";
import { buildRefinementSystemPrompt, PLANNER_ASK_MAX_SCENES } from "../src/planner-prompt.js";
import { STORYBOARD_MAX_SCENES } from "../src/storyboard-validate.js";

const prompt = buildRefinementSystemPrompt();
const flat = prompt.replace(/\s+/g, " ");

describe("the refine prompt caps a turn, not the board (vivijure-core#473)", () => {
  it("tells the model to return every scene it was given, in order", () => {
    expect(flat).toContain("return EVERY scene you were given, in the same order");
    expect(flat).toContain("Never drop, merge or shorten the board on your own");
  });
  it("caps what one turn adds or rewrites at the planner ask", () => {
    expect(flat).toContain(`add or rewrite at most ${PLANNER_ASK_MAX_SCENES} scenes`);
  });
  it("bounds the board by the storyboard cap, not the ask", () => {
    expect(flat).toContain(`The whole board may hold up to ${STORYBOARD_MAX_SCENES} scenes`);
  });
  it("no longer tells the model to keep the array at the ask (the defect)", () => {
    expect(flat).not.toContain(`scenes array length: at most ${PLANNER_ASK_MAX_SCENES} entries`);
    expect(flat).not.toContain("never let the array exceed the cap");
  });
  it("CONTROL: the ask is still 50, which the panel guard is held equal to", () => {
    expect(PLANNER_ASK_MAX_SCENES).toBe(50);
  });
});
