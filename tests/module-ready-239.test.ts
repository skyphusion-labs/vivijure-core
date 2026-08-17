import { describe, it, expect } from "vitest";
import {
  classifyReadyResponse,
  parseDoorBacking,
} from "../src/module-ready.js";

function ready(module: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, module, ...extra });
}

describe("classifyReadyResponse (core#239 pair)", () => {
  it("RunPod-endpoint module with both creds true is ready", () => {
    expect(
      classifyReadyResponse(
        200,
        ready("keyframe", {
          credentials: { runpod_api_key: true, runpod_endpoint_id: true },
        }),
        "keyframe",
      ),
    ).toBe("ready");
  });

  it("door-backed module with door.token and no runpod_endpoint_id is ready", () => {
    expect(
      classifyReadyResponse(
        200,
        ready("finish-upscale", {
          door: { token: true, bound: true },
        }),
        "finish-upscale",
      ),
    ).toBe("ready");
  });

  it("public-slug with runpod_api_key only (endpoint id absent) is ready", () => {
    expect(
      classifyReadyResponse(
        200,
        ready("kling", { credentials: { runpod_api_key: true } }),
        "kling",
      ),
    ).toBe("ready");
  });

  it("finish-blender door helper with no door key falls through to creds", () => {
    // Latent cf#612 shape: door helper, no door key. Without RunPod creds
    // this is misconfigured (indistinguishable from a broken RunPod module).
    expect(
      classifyReadyResponse(200, ready("finish-blender"), "finish-blender"),
    ).toBe("misconfigured");
  });

  it("404 is unverifiable", () => {
    expect(classifyReadyResponse(404, "not found", "keyframe")).toBe("unverifiable");
  });

  it("wrong module echo is misconfigured", () => {
    expect(
      classifyReadyResponse(
        200,
        ready("other", {
          credentials: { runpod_api_key: true, runpod_endpoint_id: true },
        }),
        "keyframe",
      ),
    ).toBe("misconfigured");
  });

  it("endpoint id present, key absent is not_visible_yet", () => {
    expect(
      classifyReadyResponse(
        200,
        ready("keyframe", {
          credentials: { runpod_api_key: false, runpod_endpoint_id: true },
        }),
        "keyframe",
      ),
    ).toBe("not_visible_yet");
  });
});

describe("parseDoorBacking", () => {
  it("absent is null (not door-backed)", () => {
    expect(parseDoorBacking(undefined)).toBeNull();
    expect(parseDoorBacking(null)).toBeNull();
  });

  it("token boolean is the only field this gate reads", () => {
    expect(parseDoorBacking({ token: true })).toEqual({ token: true });
    expect(parseDoorBacking({ token: false, route: "vpc" })).toEqual({ token: false });
  });

  it("unrecognised shape is unreadable, not a fail", () => {
    expect(parseDoorBacking("vpc")).toBe("unreadable");
    expect(parseDoorBacking({ route: "vpc" })).toBe("unreadable");
  });
});
