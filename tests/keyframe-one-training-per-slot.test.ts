// core#370: a split film must not train the same LoRA once per job.
import { describe, expect, it, vi } from "vitest";

const yamlState = vi.hoisted(() => ({ value: null as string | null, fail: false }));
vi.mock("../src/bundle-storyboard.js", async (original) => ({
  ...(await original<typeof import("../src/bundle-storyboard.js")>()),
  readBundleStoryboardYaml: async () => {
    if (yamlState.fail) throw new Error("r2 down");
    return yamlState.value;
  },
}));

import { startFilmJob } from "../src/film-orchestrator.js";
import { slotsMissingAdapters } from "../src/film-model.js";

const SCENES = [1, 2, 3, 4].map((n) => ({ shot_id: `shot_0${n}`, prompt: `p${n}`, seconds: 4 }));

function harness(trains: boolean) {
  const invokes: { shot_ids: string[] }[] = [];
  const manifest = {
    name: "keyframe", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_KEYFRAME",
    hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 10 }, cancelable: true,
    ...(trains ? { trains_loras: true } : {}),
  };
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  const env = {
    KEYFRAME_PARALLEL: "4",
    MODULE_KEYFRAME: {
      fetch: async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (String(url).endsWith("/module.json")) return json(manifest);
        if (String(url).endsWith("/invoke")) {
          invokes.push({ shot_ids: body.input?.shot_ids ?? [] });
          return json({ ok: true, pending: true, poll: `p${invokes.length}`, jobId: `j${invokes.length}` });
        }
        return new Response("no", { status: 404 });
      },
    },
    R2_RENDERS: {
      async put() {},
      async get() { return null; },
      async list() { return { objects: [], truncated: false }; },
    },
  };
  return { env: env as never, invokes };
}

const start = (env: never, pretrained?: Record<string, string>) => startFilmJob(env, {
  project: "film", bundle_key: "bundles/film.tar.gz", scenes: SCENES, keyframes_only: true,
  pretrained_loras: pretrained,
} as never);

describe("one training per slot (core#370)", () => {
  it("a slot with no adapter keeps the film to one job, with every shot in it", async () => {
    yamlState.fail = false; yamlState.value = "use_characters: [A]\n";
    const { env, invokes } = harness(true);
    await start(env);
    expect(invokes).toHaveLength(1);
    expect(invokes[0].shot_ids).toHaveLength(4);
  });

  it("every adapter present: the film splits", async () => {
    yamlState.fail = false; yamlState.value = "use_characters: [A]\n";
    const { env, invokes } = harness(true);
    await start(env, { A: "loras/a.safetensors" });
    expect(invokes).toHaveLength(4);
  });

  it("no characters: nothing can train, so the film splits", async () => {
    yamlState.fail = false; yamlState.value = "use_characters: []\n";
    const { env, invokes } = harness(true);
    await start(env);
    expect(invokes).toHaveLength(4);
  });

  it("an unreadable bundle takes the safe path", async () => {
    yamlState.fail = true; yamlState.value = null;
    const { env, invokes } = harness(true);
    await start(env);
    expect(invokes).toHaveLength(1);
  });

  it("a module that does not train is never held back, and the bundle is not the question", async () => {
    yamlState.fail = false; yamlState.value = "use_characters: [A]\n";
    const { env, invokes } = harness(false);
    await start(env);
    expect(invokes).toHaveLength(4);
  });
});

describe("slotsMissingAdapters", () => {
  it("reads flow lists, quoted or not", () => {
    expect(slotsMissingAdapters('use_characters: [A, "B"]\n', { A: "x" })).toEqual(["B"]);
  });
  it("a long run of tabs after the key is read, not a slow match", () => {
    expect(slotsMissingAdapters(`use_characters:${"\t".repeat(200_000)}[A]\n`, undefined)).toEqual(["A"]);
    expect(slotsMissingAdapters(`use_characters:${"\t".repeat(200_000)}x`, undefined)).toBeNull();
  });
  it("no key means no slots", () => {
    expect(slotsMissingAdapters("title: x\n", undefined)).toEqual([]);
  });
  it("what it cannot parse is null, never an empty answer", () => {
    expect(slotsMissingAdapters("use_characters:\n  - A\n", undefined)).toBeNull();
    expect(slotsMissingAdapters(null, undefined)).toBeNull();
  });
});
