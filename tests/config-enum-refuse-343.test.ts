// core#343: an enum value a module does not declare is refused by name, never replaced with the default.
// An absent value still takes the default. Lead ruling 2026-11-09 on the issue.
//
// Why: validateConfig turned {"size":"1080p"} into {"size":"480p"} before any module saw it, so a check
// below it against an invalid value could never fire, and a caller who sent a wrong value got the same
// 201 as a caller who sent nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigValueError, configValueRefusal, validateConfig } from "../src/modules/registry.js";
import { filmStartConfigRefusal, startFilmFromKeyframes, startFilmJob } from "../src/film-orchestrator.js";
import { resolveModuleRenderConfigs } from "../src/render-module-config.js";
import { MODULE_API, type ConfigSchema, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const SCHEMA: ConfigSchema = {
  size: { type: "enum", values: ["480p", "720p"], default: "480p" },
  enable_safety_checker: { type: "bool", default: false },
} as ConfigSchema;

const mod = (name: string, hooks: RegisteredModule["hooks"], order: number, config_schema: ConfigSchema = {}): RegisteredModule =>
  ({ name, version: "1.0.0", api: MODULE_API, binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`, hooks, config_schema, ui: { order, section: "motion" } }) as RegisteredModule;

describe("validateConfig on an enum (core#343)", () => {
  it("an absent value takes the default", () => {
    expect(validateConfig(SCHEMA, {})).toEqual({ size: "480p", enable_safety_checker: false });
    expect(validateConfig(SCHEMA, undefined)).toEqual({ size: "480p", enable_safety_checker: false });
    expect(validateConfig(SCHEMA, { size: undefined })).toEqual({ size: "480p", enable_safety_checker: false });
  });

  it("a misnamed key is still absent for the declared field, so it takes the default", () => {
    // The key-name half of the issue (vivijure-mcp#61) is a door concern; this function only sees schema keys.
    expect(validateConfig(SCHEMA, { resolution: "720p" })).toEqual({ size: "480p", enable_safety_checker: false });
  });

  it("a valid value passes as sent", () => {
    expect(validateConfig(SCHEMA, { size: "720p" })).toEqual({ size: "720p", enable_safety_checker: false });
    expect(validateConfig(SCHEMA, { size: "480p" })).toEqual({ size: "480p", enable_safety_checker: false });
  });

  it("an invalid value is refused by name: the field, the value and the allowed set", () => {
    let caught: unknown;
    try { validateConfig(SCHEMA, { size: "1080p" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigValueError);
    const e = caught as ConfigValueError;
    expect(e.field).toBe("size");
    expect(e.value).toBe("1080p");
    expect(e.allowed).toEqual(["480p", "720p"]);
    expect(e.message).toBe(`config "size": "1080p" is not supported (allowed: 480p, 720p)`);
  });

  it("null is a value the caller sent, so it is refused, not read as absent", () => {
    expect(() => validateConfig(SCHEMA, { size: null })).toThrow(`config "size": null is not supported (allowed: 480p, 720p)`);
  });

  it("a wrong-typed value is refused the same way", () => {
    expect(() => validateConfig(SCHEMA, { size: 720 })).toThrow(ConfigValueError);
  });

  it("configValueRefusal returns the sentence instead of throwing, and null when clean", () => {
    expect(configValueRefusal(SCHEMA, { size: "1080p" })).toBe(`config "size": "1080p" is not supported (allowed: 480p, 720p)`);
    expect(configValueRefusal(SCHEMA, { size: "720p" })).toBeNull();
    expect(configValueRefusal(SCHEMA, {})).toBeNull();
  });
});

describe("the host door: resolveModuleRenderConfigs refuses, it does not clamp", () => {
  it("throws ConfigValueError for a motion backend's invalid enum, so the host can 400 by name", () => {
    const talk = mod("infinitetalk", ["motion.backend"], 1, SCHEMA);
    expect(() => resolveModuleRenderConfigs({ motion_backend: "infinitetalk", config: { infinitetalk: { size: "1080p" } } }, "final", [talk]))
      .toThrow(ConfigValueError);
    const ok = resolveModuleRenderConfigs({ motion_backend: "infinitetalk", config: { infinitetalk: {} } }, "final", [talk]);
    expect(ok.motion_config).toEqual({ size: "480p", enable_safety_checker: false });
  });
});

describe("filmStartConfigRefusal names the module", () => {
  const kf = mod("keyframe", ["keyframe"], 1, { quality_tier: { type: "enum", values: ["draft", "final"], default: "final" } } as ConfigSchema);
  const talk = mod("infinitetalk", ["motion.backend"], 2, SCHEMA);
  it("the keyframe config", () => {
    expect(filmStartConfigRefusal([kf, talk], { keyframe: kf, keyframe_config: { quality_tier: "ultra" } }))
      .toBe(`keyframe config "quality_tier": "ultra" is not supported (allowed: draft, final)`);
  });
  it("the motion config, against the chosen backend", () => {
    expect(filmStartConfigRefusal([kf, talk], { motion_backend: "infinitetalk", motion_config: { size: "1080p" } }))
      .toBe(`infinitetalk config "size": "1080p" is not supported (allowed: 480p, 720p)`);
  });
  it("a per-backend motion config", () => {
    expect(filmStartConfigRefusal([kf, talk], { motion_configs: { infinitetalk: { size: "4k" } } }))
      .toBe(`infinitetalk config "size": "4k" is not supported (allowed: 480p, 720p)`);
  });
  it("clean configs and absent values pass", () => {
    expect(filmStartConfigRefusal([kf, talk], { keyframe: kf, keyframe_config: {}, motion_backend: "infinitetalk", motion_config: { size: "720p" } })).toBeNull();
  });
});

const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

function harness(mods: RegisteredModule[]) {
  const store = new Map<string, string>();
  const invokes: string[] = [];
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      put: async (k: string, v: string) => { store.set(k, v); },
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
      head: async () => null,
      delete: async (k: string) => { store.delete(k); },
      list: async () => ({ objects: [], truncated: false }),
    },

    PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
  };
  for (const m of mods) {
    env[m.binding] = { fetch: async (url: string) => (String(url).endsWith("/module.json") ? jsonResp(m) : (invokes.push(m.name), jsonResp({ ok: true, pending: true, poll: "t" }))) };
  }
  return { env: env as unknown as Env, invokes };
}

describe("a film start refuses before anything is spent", () => {
  const kf = mod("keyframe", ["keyframe"], 1, { quality_tier: { type: "enum", values: ["draft", "final"], default: "final" } } as ConfigSchema);
  const talk = mod("infinitetalk", ["motion.backend"], 2, SCHEMA);

  it("startFilmJob: an invalid keyframe enum fails the film by name, and no module is invoked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([kf, talk]);
    const job = await startFilmJob(h.env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      keyframe_config: { quality_tier: "ultra" }, motion_backend: "infinitetalk",
    }, [kf, talk]);
    expect(job.phase).toBe("failed");
    expect(job.error).toBe(`keyframe config "quality_tier": "ultra" is not supported (allowed: draft, final)`);
    expect(h.invokes).toEqual([]);
  });

  it("startFilmJob: an invalid motion enum fails the film by name, and no module is invoked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([kf, talk]);
    const job = await startFilmJob(h.env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      motion_backend: "infinitetalk", motion_config: { size: "1080p" },
    }, [kf, talk]);
    expect(job.phase).toBe("failed");
    expect(job.error).toBe(`infinitetalk config "size": "1080p" is not supported (allowed: 480p, 720p)`);
    expect(h.invokes).toEqual([]);
  });

  it("CONTROL: the same start with a valid value invokes the keyframe module", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([kf, talk]);
    const job = await startFilmJob(h.env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      keyframe_config: { quality_tier: "draft" }, motion_backend: "infinitetalk", motion_config: { size: "720p" },
    }, [kf, talk]);
    expect(job.phase).toBe("keyframe");
    expect(h.invokes).toEqual(["keyframe"]);
  });

  it("startFilmFromKeyframes: an invalid motion enum fails the film by name, and no module is invoked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([talk]);
    const job = await startFilmFromKeyframes(h.env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      keyframes: [{ shot_id: "shot_01", keyframe_key: "renders/p/keyframes/shot_01.png" }],
      motion_backend: "infinitetalk", motion_config: { size: "1080p" }, idempotency_key: `k-${Math.random()}`,
    } as never, [talk]);
    expect(job.phase).toBe("failed");
    expect(job.error).toBe(`infinitetalk config "size": "1080p" is not supported (allowed: 480p, 720p)`);
    expect(h.invokes).toEqual([]);
  });

  it("CONTROL: startFilmFromKeyframes with a valid value invokes the motion module", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([talk]);
    const job = await startFilmFromKeyframes(h.env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      keyframes: [{ shot_id: "shot_01", keyframe_key: "renders/p/keyframes/shot_01.png" }],
      motion_backend: "infinitetalk", motion_config: { size: "720p" }, idempotency_key: `k-${Math.random()}`,
    } as never, [talk]);
    expect(job.phase).not.toBe("failed");
    expect(h.invokes).toEqual(["infinitetalk"]);
  });
});
