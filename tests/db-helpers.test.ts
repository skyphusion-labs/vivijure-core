import { describe, expect, it } from "vitest";
import { isPublicId, newPublicId } from "../src/public-id.js";
import { buildRenderLogText, renderLogKey } from "../src/render-log.js";

describe("public-id", () => {
  it("mints canonical UUID v4", () => {
    expect(isPublicId(newPublicId())).toBe(true);
  });

  it("rejects bare integers as public ids", () => {
    expect(isPublicId("5")).toBe(false);
    expect(isPublicId(5)).toBe(false);
  });
});

describe("render-log", () => {
  it("uses conventional key path", () => {
    expect(renderLogKey("film-abc")).toBe("renders/logs/film-abc.txt");
  });

  it("formats a terminal job view", () => {
    const text = buildRenderLogText(
      {
        jobId: "film-abc",
        status: "COMPLETED",
        statusRaw: "done",
        executionTimeMs: 5000,
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(text).toContain("film-abc");
    expect(text).toContain("COMPLETED");
    expect(text).toContain("5.0s");
  });
});
