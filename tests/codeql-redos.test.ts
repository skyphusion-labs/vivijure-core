import { describe, expect, it } from "vitest";
import { finishStepAppliedTag, type FinishShot } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";
import { stripJsonFences } from "../src/planner-prompt.js";

function fs(partial: Partial<FinishShot> & Pick<FinishShot, "chain" | "configs">): FinishShot {
  return {
    shot_id: "shot_01",
    clip_key: "renders/neon/clips/shot_01_i2v.mp4",
    idx: 0,
    status: "pending",
    applied: [],
    poll: "idle",
    ...partial,
  };
}

describe("stripJsonFences (ReDoS-safe)", () => {
  it("prefers the last fenced JSON block", () => {
    const raw = "example:\n```json\n{\"bad\":true}\n```\n\nfinal:\n```json\n{\"ok\":true}\n```";
    expect(stripJsonFences(raw)).toBe('{"ok":true}');
  });

  it("falls back to outer braces when no fences", () => {
    expect(stripJsonFences('here is {"title":"t","scenes":[]}')).toBe('{"title":"t","scenes":[]}');
  });

  it("handles adversarial fence padding without hanging", () => {
    const evil = "```" + " ".repeat(50_000);
    const t0 = Date.now();
    expect(stripJsonFences(evil)).toBe(evil.trim());
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("resolveAppliedTemplate via finishStepAppliedTag", () => {
  const modules: RegisteredModule[] = [
    {
      name: "finish-rife",
      version: "0.1.0",
      api: "vivijure-module/2",
      hooks: ["finish"],
      binding: "MODULE_X_RIFE",
      finish_artifacts: {
        output_key: { kind: "shot_named", filename: "_finished.mp4" },
        applied: [
          { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
          { tag: "interpolate:{interpolation_factor|2}x" },
        ],
      },
    },
  ];

  it("resolves {knob|default} templates", () => {
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{ interpolation_factor: 4 }] }), modules)).toBe(
      "interpolate:4x",
    );
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{}] }), modules)).toBe("interpolate:2x");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{ interpolate: false }] }), modules)).toBe(
      "noop:interpolate-off",
    );
  });

  it("handles adversarial template padding without hanging", () => {
    const evilModules: RegisteredModule[] = [
      {
        ...modules[0],
        finish_artifacts: {
          output_key: { kind: "shot_named", filename: "_finished.mp4" },
          applied: [{ tag: "{{0|" + "{{0||".repeat(10_000) }],
        },
      },
    ];
    const t0 = Date.now();
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{}] }), evilModules)).toContain("{");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
