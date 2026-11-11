// vivijure-cf#879 MA-14: install-scope config belongs to the operator, on EVERY hook.
//
// 1. invokeRegistered replaces each install-scope key in the outgoing config with the stored install
//    value (or its default), passes render-scope keys through, and reads no store for a module that has
//    no install-scope field.
// 2. A source sweep: no file in src/ but registry.ts (the transport) and invoke-registered.ts calls
//    invokeModule directly, so no hook can skip the overlay.
// 3. Every hook in HOOK_NAMES is classified: invoked by the core (and then only through the wrapper),
//    or invoked by the host. A new hook fails here until someone decides which it is.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { invokeConfig, invokeRegistered, invokeTargetFor } from "../src/modules/invoke-registered.js";
import { HOOK_NAMES, type ConfigSchema, type RegisteredModule } from "../src/modules/types.js";

const SCHEMA: ConfigSchema = {
  notify_email: { type: "string", default: "", label: "recipient", scope: "install" },
  api_region: { type: "enum", values: ["us", "eu"], default: "us", scope: "install" },
  quality_tier: { type: "enum", values: ["draft", "final"], default: "draft" },
};

function envWith(stored: Record<string, unknown>) {
  const reads: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(name: string) {
          return {
            async all() {
              reads.push(`${sql}|${name}`);
              return { results: Object.entries(stored).map(([field_key, v]) => ({ field_key, value_json: JSON.stringify(v) })) };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as never, reads };
}

function recordingFetcher() {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetch: async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, output: {} }), { status: 200 });
    },
  };
}

const MOD = { name: "notify-email", config_schema: SCHEMA };
const req = (config: Record<string, unknown>) => ({ hook: "keyframe" as const, input: {}, config, context: { project: "p", job_id: "j" } });

describe("invokeRegistered: install-scope keys are the operator's", () => {
  it("a caller's install-scope value is replaced by the stored one; render keys pass", async () => {
    const { env } = envWith({ notify_email: "ops@example.org", api_region: "eu" });
    const f = recordingFetcher();
    await invokeRegistered(env, MOD, f, req({ notify_email: "attacker@example.org", api_region: "us", quality_tier: "final" }));
    expect(f.bodies[0].config).toEqual({ notify_email: "ops@example.org", api_region: "eu", quality_tier: "final" });
  });

  it("with nothing stored, a caller's install-scope value becomes the schema default, not the caller's", async () => {
    const { env } = envWith({});
    const f = recordingFetcher();
    await invokeRegistered(env, MOD, f, req({ notify_email: "attacker@example.org", quality_tier: "final" }));
    expect(f.bodies[0].config).toEqual({ notify_email: "", api_region: "us", quality_tier: "final" });
  });

  it("a module with no install-scope field reads no store and sends its config unchanged", async () => {
    const { env, reads } = envWith({ notify_email: "x" });
    const f = recordingFetcher();
    const plain = { name: "keyframe", config_schema: { quality_tier: SCHEMA.quality_tier } };
    await invokeRegistered(env, plain, f, req({ quality_tier: "final" }));
    expect(f.bodies[0].config).toEqual({ quality_tier: "final" });
    expect(reads).toEqual([]);
  });

  it("the rest of the envelope is untouched", async () => {
    const { env } = envWith({});
    const f = recordingFetcher();
    await invokeRegistered(env, MOD, f, req({}));
    expect(f.bodies[0]).toMatchObject({ hook: "keyframe", input: {}, context: { project: "p", job_id: "j" } });
  });

  it("invokeConfig reads the store under the module's own name", async () => {
    const { env, reads } = envWith({});
    await invokeConfig(env, MOD, {});
    expect(reads).toHaveLength(1);
    expect(reads[0].endsWith("|notify-email")).toBe(true);
  });

  it("invokeTargetFor finds a chain step's module by binding, else a schema-less target", () => {
    const mods = [{ name: "finish-rife", binding: "MODULE_FINISH_RIFE", config_schema: SCHEMA }] as unknown as RegisteredModule[];
    expect(invokeTargetFor(mods, "MODULE_FINISH_RIFE")).toBe(mods[0]);
    expect(invokeTargetFor(mods, "MODULE_GONE")).toEqual({ name: "MODULE_GONE" });
  });
});

const SRC = join(__dirname, "..", "src");
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const FILES = tsFiles(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));
// A CALL, not a mention: `invokeModule(` or `invokeModule<`, outside comments.
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const callsTransport = (t: string) => /\binvokeModule\s*[<(]/.test(code(t));
const TRANSPORT_OK = new Set(["modules/registry.ts", "modules/invoke-registered.ts"]);

describe("no hook skips the install overlay (source sweep)", () => {
  it("CONTROL: the matcher finds the transport's own calls, and ignores a comment", () => {
    expect(callsTransport(FILES.find((f) => f.rel === "modules/registry.ts")!.text)).toBe(true);
    expect(callsTransport("// invokeModule(x)\n/* invokeModule<A>(y) */")).toBe(false);
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("only registry.ts and invoke-registered.ts call invokeModule", () => {
    const offenders = FILES.filter((f) => !TRANSPORT_OK.has(f.rel) && callsTransport(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

// Hooks the HOST invokes (vivijure-cf / vivijure-local routes), never the core orchestrators.
const HOST_INVOKED = new Set(["plan.enhance", "image.generate", "cast.image"]);

describe("every hook is classified (HOOK_NAMES)", () => {
  const coreInvoked = new Set(
    FILES.flatMap((f) => [...code(f.text).matchAll(/\bhook:\s*"([a-z.]+)"/g)].map((m) => m[1])),
  );

  it("each hook is core-invoked or host-invoked, never both, never neither", () => {
    for (const hook of HOOK_NAMES) {
      const core = coreInvoked.has(hook);
      const host = HOST_INVOKED.has(hook);
      expect(core !== host, `${hook}: core=${core} host=${host}`).toBe(true);
    }
  });

  it("every core invoke site of a hook sits in a file that uses invokeRegistered", () => {
    for (const f of FILES) {
      const hooks = [...code(f.text).matchAll(/\bhook:\s*"([a-z.]+)"/g)].map((m) => m[1]).filter((h) => (HOOK_NAMES as readonly string[]).includes(h));
      if (!hooks.length || TRANSPORT_OK.has(f.rel)) continue;
      expect(/\binvokeRegistered\s*[<(]/.test(code(f.text)), `${f.rel} builds ${hooks.join(", ")}`).toBe(true);
    }
  });
});
