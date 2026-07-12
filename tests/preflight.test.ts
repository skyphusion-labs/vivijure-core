import { describe, expect, it } from "vitest";
import {
  checkDurationGrid,
  checkStoryboardShape,
  resolveCastBindings,
  summarize,
} from "../src/preflight.js";

describe("preflight pure checks", () => {
  it("flags empty scenes", () => {
    const result = summarize(checkStoryboardShape({ title: "t", scenes: [] }));
    expect(result.ok).toBe(false);
    expect(result.counts.error).toBeGreaterThan(0);
  });

  it("resolves public cast ids to numeric row ids", () => {
    const { resolved, unresolved } = resolveCastBindings(
      { A: "cast-uuid-1" },
      [{ id: 7, public_id: "cast-uuid-1" }],
    );
    expect(unresolved).toHaveLength(0);
    expect(resolved.A).toBe(7);
  });
});

describe("checkDurationGrid pure check (#707)", () => {
  const GRID = {
    fps: 8,
    tiers: { draft: { max_frames: 25 }, standard: { max_frames: 49 }, final: { max_frames: 49 } },
  };
  const board = (seconds: number) => ({
    title: "t",
    scenes: [{ id: "shot_01", prompt: "a long enough prompt here", target_seconds: seconds }],
  });

  it("warns when the planned seconds exceed the named tier's grid", () => {
    const issues = checkDurationGrid(board(5), GRID, "draft", "local-gpu");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "warning", scope: "scene[shot_01]" });
    expect(issues[0].message).toContain("clamped");
  });

  it("stays quiet when the plan fits the tier", () => {
    expect(checkDurationGrid(board(5), GRID, "standard", "local-gpu")).toEqual([]);
  });

  it("escalates to error when the clamp breaches the duration floor (#751)", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu", 0.5);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "error", scope: "scene[shot_01]" });
    expect(issues[0].message).toContain("duration gate");
  });

  it("stays a warning when the clamp is within the floor", () => {
    const issues = checkDurationGrid(board(5), GRID, "draft", "local-gpu", 0.5);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("floor 0 never escalates", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu", 0);
    expect(issues[0].level).toBe("warning");
  });

  it("omitting the floor keeps warning-only behavior", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu");
    expect(issues[0].level).toBe("warning");
  });
});
