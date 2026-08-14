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

// A DIFFERENT portrait, for the negative control below. One byte of the IHDR width differs, so it
// is a valid distinct payload rather than a length change -- a different LENGTH would also move the
// tar header, and then the control would pass for a reason that has nothing to do with content.
const PNG_OTHER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
]);

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

  const ARGS = {
    storyboard,
    characterRefs: {
      A: {
        name: "Ada",
        prompt: "a tall woman",
        trainingImages: [{ key: "character-refs/a.png" }],
      },
    },
  } as never;

  /** Assemble once and return the key, asserting UNCONDITIONALLY that there IS one.
   *
   *  This helper is the point of the review fix, not a tidy-up. The previous shape was
   *  `if (first.ok && second.ok) expect(second.bundleKey).toBe(first.bundleKey)`, and
   *  `undefined === undefined` passes: it could not tell STABLE from ABSENT, nor from CONSTANT,
   *  and stability is the whole property under test. Asserting truthiness here rather than inside
   *  a narrowing `if` means the check cannot vanish with the branch (an if-wrapped assertion is
   *  invisible when its guard is false). */
  async function bundleKeyOf(objects: Record<string, Uint8Array>): Promise<string> {
    const r = await assembleBundle(envWith(objects), ARGS);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("unreachable: asserted ok on the line above");
    expect(
      r.bundleKey,
      "assembleBundle returned ok with no bundleKey -- a stability assertion over two ABSENT keys passes vacuously",
    ).toBeTruthy();
    return r.bundleKey;
  }

  it("same portrait bytes -> same bundleKey even when wall clock advances a second", async () => {
    const objects = { "character-refs/a.png": PNG };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T18:03:59.950Z"));
    const first = await bundleKeyOf(objects);
    vi.setSystemTime(new Date("2026-08-05T18:04:00.050Z"));
    const second = await bundleKeyOf(objects);

    expect(second).toBe(first);
  });

  it("NEGATIVE CONTROL: different portrait bytes MUST produce a different bundleKey", async () => {
    // Without this row every case in the file is a same-input case, so the suite is green under an
    // implementation that returns a CONSTANT key -- which is a strictly worse defect than the
    // wall-clock one this file was written for, and this file is the only thing guarding it.
    // A content address that is not a function of the content has stopped being an address.
    const first = await bundleKeyOf({ "character-refs/a.png": PNG });
    const other = await bundleKeyOf({ "character-refs/a.png": PNG_OTHER });

    expect(other).not.toBe(first);
  });
});
