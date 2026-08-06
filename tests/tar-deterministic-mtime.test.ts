import { afterEach, describe, expect, it, vi } from "vitest";
import { emitTar, readTar } from "../src/tar.js";
import { assembleBundle } from "../src/bundle-assembler.js";

// cf#460: content-addressed bundle keys hash the full tar bytestream, including
// ustar mtime. emitTar used to default mtime to Date.now()/1000, so two
// byte-identical assemblies that straddled a wall-clock second produced
// different keys (measured flake on vivijure-cf upload-namespace row B).

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function envWith(objects: Record<string, Uint8Array>) {
  return {
    R2_RENDERS: {
      get: async (key: string) =>
        objects[key]
          ? {
              arrayBuffer: async () =>
                objects[key].buffer.slice(
                  objects[key].byteOffset,
                  objects[key].byteOffset + objects[key].byteLength,
                ),
              httpMetadata: { contentType: "image/png" },
            }
          : null,
      put: async () => undefined,
    },
  } as never;
}

const storyboard = {
  title: "Mtime Determinism",
  projectName: "mtime_det",
  full_prompt: "a character stands",
  style_prefix: "",
  style_category: "None",
  style_preset: "None",
  use_characters: ["A"],
  cast_rules: "",
  scenes: [{ id: "shot_01", prompt: "A stands", character_slots: ["A"] }],
};

describe("emitTar mtime is content-stable by default (cf#460)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two calls with the same files produce byte-identical tars across a second boundary", () => {
    const files = [{ name: "storyboard.yaml", content: new TextEncoder().encode("title: x\n") }];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T18:03:59.900Z"));
    const a = emitTar(files);
    // Cross the second boundary that used to change the default mtime header.
    vi.setSystemTime(new Date("2026-08-05T18:04:00.100Z"));
    const b = emitTar(files);
    expect(a).toEqual(b);
  });

  it("default mtime is epoch 0 in the ustar header (not wall-clock)", () => {
    const tar = emitTar([{ name: "only", content: new TextEncoder().encode("hi") }]);
    // mtime lives at header offset 136, 12-byte octal field.
    const mtimeField = new TextDecoder().decode(tar.subarray(136, 148)).replace(/\0/g, "").trim();
    expect(parseInt(mtimeField, 8)).toBe(0);
  });

  it("an explicit mtime is still written when provided", () => {
    const when = 1_700_000_000;
    const tar = emitTar([
      { name: "only", content: new TextEncoder().encode("hi"), mtime: when },
    ]);
    const mtimeField = new TextDecoder().decode(tar.subarray(136, 148)).replace(/\0/g, "").trim();
    expect(parseInt(mtimeField, 8)).toBe(when);
  });

  it("round-trip still recovers entry names and content", () => {
    const content = new TextEncoder().encode("payload");
    const parsed = readTar(emitTar([{ name: "payload.bin", content }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("payload.bin");
    expect(parsed[0].content).toEqual(content);
  });
});

describe("assembleBundle key is stable across a second boundary (cf#460)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("CONTROL: same portrait bytes -> same bundleKey even when wall clock advances a second", async () => {
    const objects = { "character-refs/a.png": PNG };
    const args = {
      storyboard,
      characterRefs: {
        A: {
          name: "Ada",
          prompt: "a tall woman",
          trainingImages: [{ key: "character-refs/a.png" }],
        },
      },
    } as never;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T18:03:59.950Z"));
    const first = await assembleBundle(envWith(objects), args);
    vi.setSystemTime(new Date("2026-08-05T18:04:00.050Z"));
    const second = await assembleBundle(envWith(objects), args);

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (first.ok && second.ok) {
      expect(second.bundleKey).toBe(first.bundleKey);
    }
  });
});
