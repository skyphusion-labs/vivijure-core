import { describe, it, expect } from "vitest";
import { buildDialogueLines, dialogueLinesFromBundleScenes } from "../src/dialogue-lines.js";

const voices = { A: "orion", B: "hera" };

// Stored storyboard shape (D1 last_storyboard): scenes with optional id + dialogue {slot, text}.
const storyboard = {
  title: "t",
  scenes: [
    { id: "shot_01", prompt: "a", character_slots: ["A", "B"], dialogue: { slot: "A", text: "  We're here.  " } },
    { id: "shot_02", prompt: "b", character_slots: ["B"], dialogue: { slot: "B", text: "Are we?" } },
    { id: "shot_03", prompt: "c" },                        // silent shot, no dialogue
    { id: "shot_04", prompt: "d", dialogue: { slot: "C", text: "Uncast voice." } }, // slot has no cast voice
  ],
};

describe("buildDialogueLines", () => {
  it("builds a line per speaking shot, trims text, resolves voice from the slot map", () => {
    const lines = buildDialogueLines(storyboard, voices, ["shot_01", "shot_02", "shot_03", "shot_04"]);
    expect(lines).toEqual([
      { shot_id: "shot_01", text: "We're here.", voice_id: "orion" },
      { shot_id: "shot_02", text: "Are we?", voice_id: "hera" },
      { shot_id: "shot_04", text: "Uncast voice.", voice_id: "angus" }, // no cast voice -> default
    ]);
  });

  it("excludes shots not in the render set (e.g. a scatter shard)", () => {
    const lines = buildDialogueLines(storyboard, voices, ["shot_02"]);
    expect(lines.map((l) => l.shot_id)).toEqual(["shot_02"]);
  });

  it("returns [] for a storyboard with no dialogue, missing scenes, or junk input", () => {
    expect(buildDialogueLines({ scenes: [{ id: "shot_01", prompt: "a" }] }, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines({}, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines(null, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines("nope", voices, ["shot_01"])).toEqual([]);
  });

  it("skips a dialogue with a non-string slot/text or empty line", () => {
    const sb = { scenes: [
      { id: "shot_01", dialogue: { slot: "A", text: "   " } },     // empty after trim
      { id: "shot_02", dialogue: { slot: 5, text: "x" } },          // bad slot
      { id: "shot_03", dialogue: { text: "no slot" } },             // missing slot
    ] };
    expect(buildDialogueLines(sb, voices, ["shot_01", "shot_02", "shot_03"])).toEqual([]);
  });

  it("coerces shot ids by position when ids are absent (matches the bundle numbering)", () => {
    const sb = { scenes: [
      { prompt: "a", dialogue: { slot: "A", text: "one" } },        // -> shot_01
      { prompt: "b", dialogue: { slot: "B", text: "two" } },        // -> shot_02
    ] };
    const lines = buildDialogueLines(sb, voices, ["shot_01", "shot_02"]);
    expect(lines.map((l) => l.shot_id)).toEqual(["shot_01", "shot_02"]);
  });
});


describe("dialogueLinesFromBundleScenes (scatter #122 fallback helper)", () => {
  it("builds lines from bundle scenes and skips silent shots", () => {
    const lines = dialogueLinesFromBundleScenes(
      [
        { shot_id: "shot_01", prompt: "a", seconds: 4, dialogue: { slot: "A", text: "  Hello.  " } },
        { shot_id: "shot_02", prompt: "b", seconds: 4 },
        { shot_id: "shot_03", prompt: "c", seconds: 4, dialogue: { slot: "B", text: "World." } },
      ],
      { A: "voice-a", B: "voice-b" },
    );
    expect(lines.map((l) => ({ shot_id: l.shot_id, text: l.text }))).toEqual([
      { shot_id: "shot_01", text: "Hello." },
      { shot_id: "shot_03", text: "World." },
    ]);
    expect(lines[0].voice_id).toBeTruthy();
    expect(lines[1].voice_id).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- resolveDialogueLines (scatter #122)
// Mackaye CR: the pure helper dialogueLinesFromBundleScenes already existed on main; coverage must
// hit resolveDialogueLines itself so removing the D1-empty fallback goes red.
import { resolveDialogueLines } from "../src/scatter-orchestrator.js";
import type { Env } from "../src/platform/index.js";

/** D1 row shape that getProjectById / rowToProject expect (last_storyboard_json string). */
function envWithProjectRow(row: Record<string, unknown> | null): Env {
  return {
    DB: {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async first() {
            return row;
          },
          async all() {
            return { results: row ? [row] : [] };
          },
          async run() {
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
    },
  } as unknown as Env;
}

const bundleScenesForFallback = [
  { shot_id: "shot_01", prompt: "a", seconds: 4, dialogue: { slot: "A", text: "From bundle." } },
  { shot_id: "shot_02", prompt: "b", seconds: 4 },
];
const fallbackVoices = { A: "voice-a" };
const scatterArgsBase = {
  project: "p",
  bundleKey: "bundles/p.tar.gz",
  shotIds: ["shot_01", "shot_02"],
  qualityTier: "standard" as const,
};

describe("resolveDialogueLines (scatter #122 D1-then-bundle fallback)", () => {
  it("falls back to bundle dialogue when project_id is absent", async () => {
    const lines = await resolveDialogueLines(
      envWithProjectRow(null),
      scatterArgsBase as never,
      fallbackVoices,
      ["shot_01", "shot_02"],
      bundleScenesForFallback,
    );
    expect(lines.map((l) => l.text)).toEqual(["From bundle."]);
  });

  it("falls back to bundle when D1 project has no last_storyboard", async () => {
    const lines = await resolveDialogueLines(
      envWithProjectRow({
        id: 1,
        public_id: "p1",
        slug: "p",
        name: "p",
        prefs_json: "{}",
        last_storyboard_json: null,
        created_at: "0",
        updated_at: "0",
      }),
      { ...scatterArgsBase, project_id: 1 } as never,
      fallbackVoices,
      ["shot_01"],
      bundleScenesForFallback,
    );
    expect(lines.map((l) => l.text)).toEqual(["From bundle."]);
  });

  it("falls back to bundle when D1 storyboard has no dialogue", async () => {
    const silent = { scenes: [{ id: "shot_01", prompt: "silent" }] };
    const lines = await resolveDialogueLines(
      envWithProjectRow({
        id: 1,
        public_id: "p1",
        slug: "p",
        name: "p",
        prefs_json: "{}",
        last_storyboard_json: JSON.stringify(silent),
        created_at: "0",
        updated_at: "0",
      }),
      { ...scatterArgsBase, project_id: 1 } as never,
      fallbackVoices,
      ["shot_01"],
      bundleScenesForFallback,
    );
    expect(lines.map((l) => l.text)).toEqual(["From bundle."]);
  });

  it("prefers D1 dialogue when present (bundle ignored)", async () => {
    const d1 = { scenes: [{ id: "shot_01", dialogue: { slot: "A", text: "From D1." } }] };
    const lines = await resolveDialogueLines(
      envWithProjectRow({
        id: 1,
        public_id: "p1",
        slug: "p",
        name: "p",
        prefs_json: "{}",
        last_storyboard_json: JSON.stringify(d1),
        created_at: "0",
        updated_at: "0",
      }),
      { ...scatterArgsBase, project_id: 1 } as never,
      fallbackVoices,
      ["shot_01"],
      bundleScenesForFallback,
    );
    expect(lines.map((l) => l.text)).toEqual(["From D1."]);
  });
});
