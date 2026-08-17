// core#239: shared /ready classifier. Pair fixtures, not a self-consistency check.

import { describe, expect, it } from "vitest";
import { classifyReadyResponse } from "../src/module-ready.js";

const runpodBoth = (module: string) =>
  JSON.stringify({
    ok: true,
    module,
    credentials: { runpod_api_key: true, runpod_endpoint_id: true },
  });

const doorToken = (module: string, token: boolean) =>
  JSON.stringify({
    ok: token,
    module,
    door: { token, bound: true, route: "vpc-propagandhi" },
  });

const publicSlug = (module: string, key: boolean) =>
  JSON.stringify({
    ok: key,
    module,
    credentials: { runpod_api_key: key },
  });

describe("classifyReadyResponse (core#239 / cp#468)", () => {
  it("(a) RunPod-endpoint module with both creds true is ready", () => {
    expect(classifyReadyResponse(200, runpodBoth("keyframe"), "keyframe")).toBe("ready");
  });

  it("(b) door-backed module with door.token and NO runpod_endpoint_id is ready", () => {
    expect(classifyReadyResponse(200, doorToken("finish-upscale", true), "finish-upscale")).toBe("ready");
  });

  it("(c) public-slug with runpod_api_key only is ready", () => {
    expect(classifyReadyResponse(200, publicSlug("seedance", true), "seedance")).toBe("ready");
  });

  it("(d) finish-blender door helper with no door key is misconfigured (cf#612)", () => {
    // Latent: blender uses the door helper but /ready emits no door key, so a door deploy is
    // indistinguishable from a broken RunPod module. The classifier must say so, not invent ready.
    const blender = JSON.stringify({
      ok: true,
      module: "finish-blender",
      credentials: { runpod_api_key: false, runpod_endpoint_id: false },
    });
    expect(classifyReadyResponse(200, blender, "finish-blender")).toBe("misconfigured");
  });

  it("(e) 404 is unverifiable", () => {
    expect(classifyReadyResponse(404, "not found", "keyframe")).toBe("unverifiable");
  });

  it("(f) wrong module echo is misconfigured", () => {
    expect(classifyReadyResponse(200, runpodBoth("own-gpu"), "keyframe")).toBe("misconfigured");
    expect(classifyReadyResponse(200, doorToken("finish-upscale", true), "speech-upscale")).toBe("misconfigured");
  });

  it("door token:false is misconfigured even when RunPod creds look healthy", () => {
    const dead = JSON.stringify({
      ok: true,
      module: "finish-upscale",
      credentials: { runpod_api_key: true, runpod_endpoint_id: true },
      door: { token: false, bound: true, route: "vpc" },
    });
    expect(classifyReadyResponse(200, dead, "finish-upscale")).toBe("misconfigured");
  });

  it("absent public-slug key is not_visible_yet, not misconfigured", () => {
    expect(classifyReadyResponse(200, publicSlug("seedance", false), "seedance")).toBe("not_visible_yet");
  });
});
