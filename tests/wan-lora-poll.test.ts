import { describe, expect, it } from "vitest";
import { mergeCastLoraPollResults } from "../src/runpod-submit.js";

describe("mergeCastLoraPollResults", () => {
  const renderOk = { ok: true, view: { jobId: "j1", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" } };
  const render404 = { ok: false, status: 404, error: "not found" };
  const wanCompleted = {
    ok: true,
    view: { jobId: "j1", status: "COMPLETED", statusRaw: "COMPLETED", output: {} },
  };
  const wan404 = { ok: false, status: 404, error: "not found" };
  const wan503 = { ok: false, status: 503, error: "upstream" };

  it("prefers a successful Wan train poll", () => {
    expect(mergeCastLoraPollResults(wanCompleted, render404)).toEqual(wanCompleted);
  });

  it("falls through to the render poll when the Wan train poll 404s", () => {
    expect(mergeCastLoraPollResults(wan404, renderOk)).toEqual(renderOk);
  });

  it("returns the render poll when no Wan train poll ran", () => {
    expect(mergeCastLoraPollResults(undefined, renderOk)).toEqual(renderOk);
  });

  it("surfaces a non-404 Wan train poll error without falling through", () => {
    expect(mergeCastLoraPollResults(wan503, renderOk)).toEqual(wan503);
  });
});
