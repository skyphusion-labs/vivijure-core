// vivijure-core#339: the caller picks the dialogue module, and every dialogue site honours it.
//
// Five sites took `servingForHook(modules, "dialogue")[0]` with `config: {}`, so the first module by
// ui.order ran whatever the caller chose, and it never got the caller's config. Lead ruling on #339:
// a selection on FilmJob, folded into the idempotency key, refused by name if unknown, one picker for
// all five sites, and no selection keeps the [0] default.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dialogueModules, pickDialogueModule } from "../src/modules/dialogue-select.js";
import { advanceFilmJob, filmJobDocKey, startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import { parseModuleRenderOverrides, resolveModuleRenderConfigs } from "../src/render-module-config.js";
import { naturalKeyForStartFilmJob, naturalKeyForStartFromKeyframes } from "../src/film-submit-idempotency.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const mod = (name: string, hooks: RegisteredModule["hooks"], order: number, config_schema: RegisteredModule["config_schema"] = {}): RegisteredModule =>
  ({ name, version: "1.0.0", api: MODULE_API, binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`, hooks, config_schema, ui: { order, section: "audio" } }) as RegisteredModule;

const GEN = mod("dialogue-gen", ["dialogue"], 5);
const CHATTER = mod("chatterbox", ["dialogue"], 6, { exaggeration: { type: "float", default: 0.5, min: 0, max: 2 } });
const SPEECH = mod("speech-upscale", ["speech"], 7);

describe("one picker for every dialogue site (core#339)", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith(".ts") ? [join(d, n)] : []));
  const bypasses = (text: string) =>
    text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l) && /servingForHook\(.*"dialogue"\s*\)/.test(l));

  it("no file in src/ looks up the dialogue module except src/modules/dialogue-select.ts", () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(50); // the denominator
    const found = all
      .filter((p) => !p.endsWith("modules/dialogue-select.ts"))
      .flatMap((p) => bypasses(readFileSync(p, "utf8")).map((l) => `${relative(SRC, p)}: ${l.trim()}`));
    expect(found).toEqual([]);
  });

  it("the film orchestrator reaches the picker at all five sites and both start paths", () => {
    const text = readFileSync(join(SRC, "film-orchestrator.ts"), "utf8");
    expect((text.match(/pickDialogueModule\(/g) ?? []).length).toBe(7);
  });

  it("control: the scan sees each bypass shape, and not the picker", () => {
    for (const l of [
      `const dialogueModule = servingForHook(preModules, "dialogue")[0];`,
      `const provider = servingForHook(preModules, "dialogue")[0]?.name;`,
      `const m = servingForHook(preModules ?? await discoverModules(envRec), "dialogue")[0];`,
    ]) expect(bypasses(l), l).toEqual([l]);
    expect(bypasses(`const pick = pickDialogueModule(preModules, job.dialogue_backend);`)).toEqual([]);
    expect(bypasses(`// servingForHook(modules, "dialogue")[0] in a comment`)).toEqual([]);
  });
});

describe("pickDialogueModule", () => {
  const all = [CHATTER, SPEECH, GEN];
  it("no choice keeps the default: the first serving module by ui.order", () => {
    expect(pickDialogueModule(all)).toEqual({ ok: true, module: GEN });
    expect(pickDialogueModule(all, "  ")).toEqual({ ok: true, module: GEN });
    expect(dialogueModules(all).map((m) => m.name)).toEqual(["dialogue-gen", "chatterbox"]);
  });
  it("a choice wins over ui.order", () => {
    expect(pickDialogueModule(all, "chatterbox")).toEqual({ ok: true, module: CHATTER });
    expect(pickDialogueModule(all, " chatterbox ")).toEqual({ ok: true, module: CHATTER });
  });
  it("an unknown choice is refused by name, never replaced with the default", () => {
    expect(pickDialogueModule(all, "elevenlabs")).toEqual({ ok: false, error: `dialogue module "elevenlabs" is not installed` });
    expect(pickDialogueModule(all, "speech-upscale")).toEqual({ ok: false, error: `dialogue module "speech-upscale" does not serve the dialogue hook` });
  });
  it("nothing installed and no choice is no module, for the caller's own no-module path", () => {
    expect(pickDialogueModule([SPEECH])).toEqual({ ok: true, module: undefined });
  });
});

describe("the wire and the resolver (core#339)", () => {
  it("parses dialogue_backend, and a bag carrying only it is the modern shape", () => {
    expect(parseModuleRenderOverrides({ dialogue_backend: " chatterbox " })).toEqual({ dialogue_backend: "chatterbox" });
    expect(parseModuleRenderOverrides({ dialogue_backend: "   " })).toEqual({});
  });
  it("resolves the choice, and clamps config only for the dialogue modules the caller sent config for", () => {
    const r = resolveModuleRenderConfigs(
      { dialogue_backend: "chatterbox", config: { chatterbox: { exaggeration: 9 } } },
      "draft",
      [GEN, CHATTER],
    );
    expect(r.dialogue_backend).toBe("chatterbox");
    expect(r.dialogue_config).toEqual({ chatterbox: { exaggeration: 2 } });
    const none = resolveModuleRenderConfigs({}, "draft", [GEN, CHATTER]);
    expect(none.dialogue_backend).toBeUndefined();
    expect(none.dialogue_config).toEqual({});
  });
});

describe("the idempotency key covers the dialogue selection (core#339)", () => {
  const base = { project: "p", bundle_key: "b", scenes: [] };
  const fp = (x: unknown) => JSON.stringify(x);
  it("two submits that differ only in dialogue module are two films, on both start paths", () => {
    expect(fp(naturalKeyForStartFilmJob({ ...base, dialogue_backend: "chatterbox" }))).not.toBe(fp(naturalKeyForStartFilmJob(base)));
    expect(fp(naturalKeyForStartFilmJob({ ...base, dialogue_config: { chatterbox: { exaggeration: 1 } } }))).not.toBe(fp(naturalKeyForStartFilmJob(base)));
    const kb = { ...base, keyframes: [], derive_mode: "finalized" as const };
    expect(fp(naturalKeyForStartFromKeyframes({ ...kb, dialogue_backend: "chatterbox" }))).not.toBe(fp(naturalKeyForStartFromKeyframes(kb)));
  });
  it("a blank choice and an empty config are the same as none", () => {
    expect(fp(naturalKeyForStartFilmJob({ ...base, dialogue_backend: " ", dialogue_config: {} }))).toBe(fp(naturalKeyForStartFilmJob(base)));
  });
});

// ---- the real legs ---------------------------------------------------------------------------------

const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const FILM = "film-339";
const CLIPS = "clips-339";

/** A film parked after its clips, with two dialogue modules installed, so the post-clip dialogue leg
 *  runs on the next tick (the cf#834 harness shape). Records which module was invoked, with what config. */
function postClipHarness(over: Partial<FilmJob>, mode: "output" | "pending" = "output") {
  const job = {
    film_id: FILM, project: "p", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    dialogue_lines: [{ shot_id: "shot_01", text: "hello" }],
    motion_backend: "seedance", motion_config: {}, finish_config: {}, keyframe_binding: null,
    phase: "clips", clip_job_id: CLIPS, created_at: 0, ...over,
  };
  const clipJob = { job_id: CLIPS, project: "p", shots: [{ shot_id: "shot_01", status: "done", clip_key: `renders/${FILM}/shot_01.mp4` }] };
  const store = new Map<string, string>([[filmJobDocKey(FILM), JSON.stringify(job)], [`renders/clip-jobs/${CLIPS}.json`, JSON.stringify(clipJob)]]);
  const calls: { module: string; kind: "invoke" | "poll"; config?: unknown }[] = [];
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (k: string) => {
        for (const [key, v] of store) if (key === k || (k.includes(CLIPS) && key.includes(CLIPS))) return { text: async () => v };
        return null;
      },
      head: async () => null,
      list: async () => ({ objects: [] }),
      put: async (k: string, v: string) => { store.set(k, v); },
    },
    PRESIGNER: { presignGet: async (k: string) => `https://presigned/${k}`, presignPut: async (k: string) => `https://presigned-put/${k}` },
    MODULE_FINISH_RIFE: {
      fetch: async (url: string) => String(url).endsWith("/module.json")
        ? jsonResp({ name: "finish-rife", version: "1.0.0", api: MODULE_API, hooks: ["finish"], ui: { order: 10, section: "finish" } })
        : jsonResp({ ok: true, pending: true, poll: "https://module/poll/finish" }),
    },
  };
  for (const m of [GEN, CHATTER]) {
    env[m.binding] = {
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/module.json")) return jsonResp(m);
        const body = init?.body ? JSON.parse(String(init.body)) as { poll?: string; config?: unknown } : {};
        const kind = typeof body.poll === "string" ? "poll" : "invoke";
        calls.push({ module: m.name, kind, ...(kind === "invoke" ? { config: body.config } : {}) });
        if (mode === "pending" && kind === "invoke") return jsonResp({ ok: true, pending: true, poll: `poll-${m.name}` });
        return jsonResp({ ok: true, output: { project: "p", audio: [{ shot_id: "shot_01", audio_key: `renders/${FILM}/dialogue/shot_01.wav`, voice_id: "v", duration_s: 2 }], applied: [m.name] } });
      },
    };
  }
  return { env: env as unknown as Env, calls, read: () => JSON.parse(store.get(filmJobDocKey(FILM))!) as FilmJob };
}

describe("the post-clip dialogue leg runs the module the caller chose (core#339)", () => {
  it("CONTROL: with no selection the first module by ui.order runs, with {} as before", async () => {
    const h = postClipHarness({});
    await advanceFilmJob(h.env, FILM);
    expect(h.calls).toEqual([{ module: "dialogue-gen", kind: "invoke", config: {} }]);
    expect(h.read().phase).not.toBe("failed");
  });

  it("a selection runs that module, with the caller's config", async () => {
    const h = postClipHarness({ dialogue_backend: "chatterbox", dialogue_config: { chatterbox: { exaggeration: 1.5 } } });
    await advanceFilmJob(h.env, FILM);
    expect(h.calls).toEqual([{ module: "chatterbox", kind: "invoke", config: { exaggeration: 1.5 } }]);
    expect(Object.keys(h.read().dialogue_audio ?? {})).toEqual(["shot_01"]);
  });

  it("an accepted batch is polled on the same selected module, never the default", async () => {
    const h = postClipHarness({ dialogue_backend: "chatterbox" }, "pending");
    await advanceFilmJob(h.env, FILM); // the tick submits, then drives the dialogue poll it parked
    expect(h.calls.map((c) => `${c.module}:${c.kind}`)).toEqual(["chatterbox:invoke", "chatterbox:poll"]);
    expect(Object.keys(h.read().dialogue_audio ?? {})).toEqual(["shot_01"]);
  });

  it("an unknown selection fails the film by name; neither module runs and it is not a silent film", async () => {
    const h = postClipHarness({ dialogue_backend: "elevenlabs" });
    await advanceFilmJob(h.env, FILM);
    const doc = h.read();
    expect(h.calls).toEqual([]);
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/dialogue module "elevenlabs" is not installed/);
    expect(doc.dialogue_degraded).toBeUndefined();
  });
});

describe("startFilmJob refuses an unknown dialogue module before anything is spent (core#339)", () => {
  it("fails with the name, and the keyframe module is never invoked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const kf = mod("keyframe", ["keyframe"], 1);
    let kfInvokes = 0;
    const store = new Map<string, string>();
    const env = {
      R2_RENDERS: {
        put: async (k: string, v: string) => { store.set(k, v); },
        get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
        head: async () => null,
        list: async () => ({ objects: [], truncated: false }),
      },
      [kf.binding]: { fetch: async (url: string) => (String(url).endsWith("/module.json") ? jsonResp(kf) : (kfInvokes++, jsonResp({ ok: true, pending: true, poll: "k" }))) },
    } as unknown as Env;
    const job = await startFilmJob(env, {
      project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      keyframes_only: true, dialogue_backend: "elevenlabs",
    }, [kf, GEN, CHATTER]);
    expect(job.phase).toBe("failed");
    expect(job.error).toBe(`dialogue module "elevenlabs" is not installed`);
    expect(kfInvokes).toBe(0);
    expect(job.dialogue_backend).toBe("elevenlabs");
  });
});
