// core#507: config_schema can say a value only fits some shots (`requires`). The concrete case is Veo 3.1,
// which makes 1080p only as an 8 second clip, and cf-veo snaps 7.5 s and up to 8 s. The core refuses a film
// that breaks a rule when it starts, before anything is spent, instead of the door refusing it at clip time
// after the keyframes were bought.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configRequiresRefusal, validateConfig } from "../src/modules/registry.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { filmStartConfigRefusal, startFilmJob } from "../src/film-orchestrator.js";
import { MODULE_API, type ConfigSchema, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const VEO: ConfigSchema = {
  resolution: {
    type: "enum", values: ["720p", "1080p"], default: "720p",
    requires: [{ when: "1080p", shot_seconds: { min: 7.5 }, message: "Veo 3.1 makes 1080p only as an 8 second clip" }],
  },
};
const mod = (name: string, hooks: RegisteredModule["hooks"], order: number, config_schema: ConfigSchema = {}): RegisteredModule =>
  ({ name, version: "1.0.0", api: MODULE_API, binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`, hooks, config_schema, ui: { order, section: "motion" } }) as RegisteredModule;
const kf = mod("keyframe", ["keyframe"], 1);
const veo = mod("cf-veo", ["motion.backend"], 2, VEO);
const other = mod("seedance", ["motion.backend"], 3, { resolution: { type: "enum", values: ["720p", "1080p"], default: "720p" } });
const shot = (shot_id: string, seconds: number) => ({ shot_id, prompt: "a", seconds });

describe("configRequiresRefusal", () => {
  const cfg = (v: Record<string, unknown>) => validateConfig(VEO, v);
  it("a shot outside the range is refused, naming field, value, range, shot and message", () => {
    expect(configRequiresRefusal(VEO, cfg({ resolution: "1080p" }), { shot_id: "s2", seconds: 6 }))
      .toBe(`resolution "1080p" needs shots of at least 7.5 s, and shot s2 is 6 s (Veo 3.1 makes 1080p only as an 8 second clip)`);
  });
  it("a shot inside passes; the boundary is inclusive", () => {
    expect(configRequiresRefusal(VEO, cfg({ resolution: "1080p" }), { shot_id: "s", seconds: 8 })).toBeNull();
    expect(configRequiresRefusal(VEO, cfg({ resolution: "1080p" }), { shot_id: "s", seconds: 7.5 })).toBeNull();
  });
  it("another value is not constrained", () => {
    expect(configRequiresRefusal(VEO, cfg({ resolution: "720p" }), { shot_id: "s", seconds: 4 })).toBeNull();
  });
  it("the DEFAULT counts: a schema whose default is constrained refuses an absent value", () => {
    const d: ConfigSchema = { resolution: { ...(VEO.resolution as object), default: "1080p" } as ConfigSchema[string] };
    expect(configRequiresRefusal(d, validateConfig(d, {}), { shot_id: "s", seconds: 4 })).toMatch(/needs shots of at least 7.5 s/);
  });
  it("max and a two-sided range", () => {
    const s: ConfigSchema = { fast: { type: "bool", default: false, requires: [{ when: true, shot_seconds: { min: 2, max: 5 } }] } };
    expect(configRequiresRefusal(s, { fast: true }, { shot_id: "s", seconds: 6 })).toBe(`fast true needs shots of 2 to 5 s, and shot s is 6 s`);
    expect(configRequiresRefusal(s, { fast: true }, { shot_id: "s", seconds: 3 })).toBeNull();
  });
  it("a shot with no usable seconds does not pass a rule", () => {
    expect(configRequiresRefusal(VEO, cfg({ resolution: "1080p" }), { shot_id: "s", seconds: Number.NaN })).not.toBeNull();
  });
});

describe("filmStartConfigRefusal checks each shot against its own door", () => {
  const mods = [kf, veo, other];
  it("the film door's config across every shot; the first bad shot is named", () => {
    expect(filmStartConfigRefusal(mods, {
      motion_backend: "cf-veo", motion_config: { resolution: "1080p" }, scenes: [shot("s1", 8), shot("s2", 6), shot("s3", 4)],
    })).toBe(`cf-veo resolution "1080p" needs shots of at least 7.5 s, and shot s2 is 6 s (Veo 3.1 makes 1080p only as an 8 second clip)`);
  });
  it("CONTROL: 8 second shots at 1080p pass, and 720p passes any length", () => {
    expect(filmStartConfigRefusal(mods, { motion_backend: "cf-veo", motion_config: { resolution: "1080p" }, scenes: [shot("s1", 8)] })).toBeNull();
    expect(filmStartConfigRefusal(mods, { motion_backend: "cf-veo", motion_config: { resolution: "720p" }, scenes: [shot("s1", 4)] })).toBeNull();
  });
  it("a shot routed to another door is judged by that door, not the film's", () => {
    expect(filmStartConfigRefusal(mods, {
      motion_backend: "cf-veo", motion_config: { resolution: "1080p" },
      per_shot_motion: { s2: "seedance" }, scenes: [shot("s1", 8), shot("s2", 4)],
    })).toBeNull();
  });
  it("a per-shot door uses its own motion_configs entry", () => {
    expect(filmStartConfigRefusal(mods, {
      motion_backend: "seedance", per_shot_motion: { s2: "cf-veo" },
      motion_configs: { "cf-veo": { resolution: "1080p" } }, scenes: [shot("s1", 4), shot("s2", 5)],
    })).toMatch(/^cf-veo resolution "1080p" needs shots of at least 7.5 s, and shot s2 is 5 s/);
  });
  it("an absent value is judged at its DEFAULT", () => {
    const veo1080 = mod("veo-1080", ["motion.backend"], 4, { resolution: { ...(VEO.resolution as object), default: "1080p" } as ConfigSchema[string] });
    expect(filmStartConfigRefusal([kf, veo1080], { motion_backend: "veo-1080", scenes: [shot("s1", 4)] }))
      .toMatch(/^veo-1080 resolution "1080p" needs shots of at least 7.5 s, and shot s1 is 4 s/);
  });
  it("without scenes nothing per-shot is checked (back-compatible)", () => {
    expect(filmStartConfigRefusal(mods, { motion_backend: "cf-veo", motion_config: { resolution: "1080p" } })).toBeNull();
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

describe("startFilmJob refuses before the keyframes are bought", () => {
  it("1080p Veo with a 6 second shot fails the film by name and invokes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([kf, veo]);
    const job = await startFilmJob(h.env, {
      project: "p", bundle_key: "b", scenes: [shot("shot_01", 8), shot("shot_02", 6)],
      motion_backend: "cf-veo", motion_config: { resolution: "1080p" },
    }, [kf, veo]);
    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/^cf-veo resolution "1080p" needs shots of at least 7\.5 s, and shot shot_02 is 6 s/);
    expect(h.invokes).toEqual([]);
  });
  it("CONTROL: all 8 second shots start, and the keyframe module is invoked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness([kf, veo]);
    const job = await startFilmJob(h.env, {
      project: "p", bundle_key: "b", scenes: [shot("shot_01", 8), shot("shot_02", 8)],
      motion_backend: "cf-veo", motion_config: { resolution: "1080p" },
    }, [kf, veo]);
    expect(job.phase).not.toBe("failed");
    expect(h.invokes.length).toBeGreaterThan(0);
    expect(new Set(h.invokes)).toEqual(new Set(["keyframe"]));
  });
});

describe("validateManifest checks requires", () => {
  const m = (schema: unknown) => ({ name: "m", version: "1.0.0", api: MODULE_API, hooks: ["motion.backend"], config_schema: schema });
  it("CONTROL: a well-formed rule validates", () => {
    expect(typeof validateManifest(m(VEO))).toBe("object");
  });
  for (const [label, req, msg] of [
    ["not an array", { when: "x", shot_seconds: { min: 1 } }, /requires is not an array/],
    ["no when", [{ shot_seconds: { min: 1 } }], /needs a when value/],
    ["an object when", [{ when: {}, shot_seconds: { min: 1 } }], /needs a when value/],
    ["no shot_seconds", [{ when: "x" }], /numeric min or max/],
    ["an empty range", [{ when: "x", shot_seconds: {} }], /numeric min or max/],
    ["a string min", [{ when: "x", shot_seconds: { min: "8" } }], /numeric min or max/],
    ["a non-string message", [{ when: "x", shot_seconds: { min: 1 }, message: 3 }], /message must be a string/],
  ] as [string, unknown, RegExp][]) {
    it(`refuses ${label}`, () => {
      const r = validateManifest(m({ resolution: { type: "enum", values: ["x"], default: "x", requires: req } }));
      expect(typeof r).toBe("string");
      expect(r as string).toMatch(msg);
    });
  }
});
