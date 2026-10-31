import { describe, expect, it } from "vitest";
import { shareEndFrame } from "../src/film-model.js";
import { gzipBytes } from "../src/bundle-durations.js";
import { startFilmFromKeyframes } from "../src/film-orchestrator.js";
import { emitTar } from "../src/tar.js";
import type { RegisteredModule } from "../src/modules/types.js";
import { parseStoryboardScenes, serializeStoryboardYaml } from "../src/planner-yaml.js";
import type { StoryboardValidated } from "../src/storyboard-validate.js";

// vivijure-cf#1140: the next shot's start still as an end frame morphs a clip into that shot, so a cut
// between different people lost the first character before the cut.

describe("shareEndFrame", () => {
  it("keeps the end frame between shots of the same people, in any order", () => {
    expect(shareEndFrame(["A"], ["A"])).toBe(true);
    expect(shareEndFrame(["A", "B"], ["B", "A"])).toBe(true);
    expect(shareEndFrame([], [])).toBe(true);
  });

  it("drops it across a cut to different people", () => {
    expect(shareEndFrame(["A"], ["B"])).toBe(false);
    expect(shareEndFrame(["A"], ["A", "B"])).toBe(false);
    expect(shareEndFrame(["A", "B"], ["A"])).toBe(false);
    expect(shareEndFrame(["A"], [])).toBe(false);
  });

  it("keeps it when either shot does not say who is in it", () => {
    expect(shareEndFrame(undefined, ["A"])).toBe(true);
    expect(shareEndFrame(["A"], undefined)).toBe(true);
    expect(shareEndFrame(undefined, undefined)).toBe(true);
  });
});

describe("parseStoryboardScenes reads character_slots", () => {
  const board = (scenes: StoryboardValidated["scenes"]): StoryboardValidated => ({
    title: "T", projectName: "t", full_prompt: "p", duration_seconds: undefined, clip_seconds: undefined,
    style_prefix: "", style_category: "None", style_preset: "None",
    use_characters: ["A", "B"], cast_rules: "", scenes,
  });

  it("round-trips one, two, and no slots, and leaves an unstated shot absent", () => {
    const parsed = parseStoryboardScenes(serializeStoryboardYaml(board([
      { id: "shot_01", prompt: "a", character_slots: ["A"] },
      { id: "shot_02", prompt: "b", character_slots: ["A", "B"] },
      { id: "shot_03", prompt: "c", character_slots: [] },
      { id: "shot_04", prompt: "d" },
    ])));
    expect(parsed.map((s) => s.character_slots)).toEqual([["A"], ["A", "B"], [], undefined]);
  });

  it("does not carry a shot's slots into the next shot", () => {
    const parsed = parseStoryboardScenes(serializeStoryboardYaml(board([
      { id: "shot_01", prompt: "a", character_slots: ["A"] },
      { id: "shot_02", prompt: "b" },
    ])));
    expect(parsed[1].character_slots).toBeUndefined();
  });
});

describe("the motion door receives the decision", () => {
  const door = {
    name: "seedance", version: "0.1.0", api: "vivijure-module/2" as const, binding: "MODULE_SEEDANCE",
    hooks: ["motion.backend" as const], config_schema: {}, ui: { section: "motion", order: 6, locality: "cloud" as const },
  } as unknown as RegisteredModule;

  const SHOTS = ["shot_01", "shot_02", "shot_03"];
  const board = (slots: (string[] | undefined)[]): StoryboardValidated => ({
    title: "T", projectName: "t", full_prompt: "p", duration_seconds: undefined, clip_seconds: undefined,
    style_prefix: "", style_category: "None", style_preset: "None", use_characters: ["A", "B"], cast_rules: "",
    scenes: SHOTS.map((id, i) => ({ id, prompt: id, ...(slots[i] ? { character_slots: slots[i] as ("A" | "B")[] } : {}) })),
  });

  /** Run a real from-keyframes submit against a real gzipped bundle. Return each shot's end frame as sent. */
  async function endFrames(slots: (string[] | undefined)[], bundleExists = true): Promise<Record<string, string | undefined>> {
    const gz = await gzipBytes(emitTar([
      { name: "storyboard.yaml", content: new TextEncoder().encode(serializeStoryboardYaml(board(slots))) },
    ]));
    const seen: Record<string, string | undefined> = {};
    const docs = new Map<string, string>();
    const env = {
      PRESIGNER: {
        presignGet: async (key: string) => `https://example.invalid/${key}`,
        presignPut: async (key: string) => `https://example.invalid/${key}`,
      },
      MODULE_SEEDANCE: {
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as { input?: { shot_id?: string; last_keyframe_url?: string } };
          if (body.input?.shot_id) seen[body.input.shot_id] = body.input.last_keyframe_url;
          return new Response(JSON.stringify({ ok: true, pending: true, poll: "p" }), {
            headers: { "content-type": "application/json" },
          });
        },
      },
      R2_RENDERS: {
        async put(key: string, value: string) { docs.set(key, value); },
        async get(key: string) {
          if (key === "bundles/t.tar.gz") {
            if (!bundleExists) return null;
            return { arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
          }
          const v = docs.get(key);
          return v === undefined ? null : { text: async () => v };
        },
      },
    };
    const job = await startFilmFromKeyframes(env as never, {
      project: "t",
      bundle_key: "bundles/t.tar.gz",
      scenes: SHOTS.map((shot_id) => ({ shot_id, prompt: shot_id, seconds: 5 })),
      keyframes: SHOTS.map((shot_id) => ({ shot_id, keyframe_key: `keyframes/${shot_id}.png`, prompt: shot_id, seconds: 5 })),
      motion_backend: "seedance",
      derive_mode: "finalized",
    }, [door]);
    expect(job.phase).toBe("clips");
    return seen;
  }

  it("sends no end frame across a cut to different people, and keeps it between the same people", async () => {
    const seen = await endFrames([["A"], ["B"], ["B"]]);
    expect(Object.keys(seen).sort()).toEqual(SHOTS);
    expect(seen.shot_01).toBeUndefined();
    expect(seen.shot_02).toContain("keyframes/shot_03.png");
    expect(seen.shot_03).toBeUndefined();
  });

  it("CONTROL: a board that states no slots keeps the old behavior", async () => {
    const seen = await endFrames([undefined, undefined, undefined]);
    expect(seen.shot_01).toContain("keyframes/shot_02.png");
    expect(seen.shot_02).toContain("keyframes/shot_03.png");
  });

  it("an unreadable bundle keeps the old behavior and does not fail the film", async () => {
    const seen = await endFrames([["A"], ["B"], ["B"]], false);
    expect(seen.shot_01).toContain("keyframes/shot_02.png");
  });
});
