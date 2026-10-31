import { describe, expect, it } from "vitest";
import { buildPlanningSystemPrompt, buildRefinementSystemPrompt } from "../src/planner-prompt.js";

// vivijure-cf#1145: a keyframe is drawn from its own shot prompt. On film-f70f2700 a shot with no place
// put Mara in an open field in a film set in a workshop.
describe("the planner is told to name a place in every scene", () => {
  it("in the planning prompt", () => {
    expect(buildPlanningSystemPrompt()).toContain("names where the shot takes place");
  });
  it("and its worked example obeys the rule on the shot most likely to break it", () => {
    expect(buildPlanningSystemPrompt()).toContain("Close-up on Elena's face on the hilltop");
    expect(buildPlanningSystemPrompt()).not.toContain("Close-up on Elena's face, soft side light");
  });
  it("in the refinement prompt, so a refine does not lose it", () => {
    expect(buildRefinementSystemPrompt()).toContain("Close-up on Elena's face on the hilltop");
  });
});
