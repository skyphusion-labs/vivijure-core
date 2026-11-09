import { afterEach, describe, expect, it } from "vitest";
import {
  BoardKeyCollisionError,
  boardKeySlug,
  createProject,
  getProjectById,
  setLastStoryboard,
} from "../src/storyboard-projects-db.js";
import type { DbEnv } from "../src/db-env.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

// core#518 (vivijure-backend#487): the backend keys renders/<key>/ and loras/<key>/ by the BOARD TITLE,
// through normalizeProjectName. Two projects whose titles share a key reuse each other's stored keyframes
// and LoRAs as prior state. setLastStoryboard now refuses the second, naming the first.
//
// Real SQLite with the real cf migrations and the shipped query text: the refusal depends on
// json_extract / json_valid semantics, which a recording fake cannot observe.

let d1: TestD1 | null = null;
afterEach(() => {
  d1?.close();
  d1 = null;
});

function env(): DbEnv {
  d1 = openTestD1();
  return { DB: d1.DB } as DbEnv;
}

const board = (title: string) => ({ title, scenes: [{ id: "shot_01", prompt: "x" }] });

function storedTitle(id: number): unknown {
  const row = d1!.raw.prepare("SELECT last_storyboard_json AS j FROM storyboard_projects WHERE id = ?").get(id) as
    { j: string | null };
  return row.j === null ? null : (JSON.parse(row.j) as { title?: unknown }).title;
}

describe("boardKeySlug", () => {
  it("is core's normalizeProjectName of the title", () => {
    expect(boardKeySlug(board("Two O'Clock Proof (43 shots)"))).toBe("Two_O_Clock_Proof__43_shots_");
    expect(boardKeySlug(board("Hero Film"))).toBe("Hero_Film");
  });
  it("is null for a board with no usable title", () => {
    for (const b of [null, undefined, "x", [], {}, { title: 7 }, { title: "" }, { title: "   " }]) {
      expect(boardKeySlug(b)).toBeNull();
    }
  });
});

describe("setLastStoryboard refuses a board whose key another project holds", () => {
  it("refuses a different project with the same title, names the holder, and writes nothing", async () => {
    const e = env();
    const a = await createProject(e, { name: "First" });
    const b = await createProject(e, { name: "Second" });
    await setLastStoryboard(e, a.id, board("Neon City"));
    const err = await setLastStoryboard(e, b.id, board("Neon City")).catch((x) => x);
    expect(err).toBeInstanceOf(BoardKeyCollisionError);
    expect(err.slug).toBe("Neon_City");
    expect(err.existing).toEqual({ id: a.public_id, name: "First", title: "Neon City" });
    expect(err.message).toContain(a.public_id);
    expect(err.existing.id).not.toBe(String(a.id)); // the public id, never the internal PK
    expect(storedTitle(b.id)).toBeNull();
  });

  it("uses core's rule, not the backend's: titles that differ only in what core sanitizes collide", async () => {
    // backend _slug keeps the apostrophe and parentheses; core maps both to "_". Core's key is what reaches
    // the backend, so these two would share renders/Two_O_Clock_/.
    const e = env();
    const a = await createProject(e, { name: "a" });
    const b = await createProject(e, { name: "b" });
    await setLastStoryboard(e, a.id, board("Two O'Clock (cut)"));
    await expect(setLastStoryboard(e, b.id, board("Two O_Clock _cut)"))).rejects.toBeInstanceOf(BoardKeyCollisionError);
    await expect(setLastStoryboard(e, b.id, board("Two  O/Clock  (cut)"))).rejects.toBeInstanceOf(BoardKeyCollisionError);
  });

  it("refuses a retitle onto a key another project holds (rename)", async () => {
    const e = env();
    const a = await createProject(e, { name: "a" });
    const b = await createProject(e, { name: "b" });
    await setLastStoryboard(e, a.id, board("Harbor"));
    await setLastStoryboard(e, b.id, board("Pier"));
    await expect(setLastStoryboard(e, b.id, board("Harbor"))).rejects.toBeInstanceOf(BoardKeyCollisionError);
    expect(storedTitle(b.id)).toBe("Pier");
  });

  it("never refuses a project its own key: re-save and retitle pass", async () => {
    const e = env();
    const a = await createProject(e, { name: "a" });
    await setLastStoryboard(e, a.id, board("Harbor"));
    await setLastStoryboard(e, a.id, board("Harbor"));
    await setLastStoryboard(e, a.id, board("Harbor  Lights"));
    expect(storedTitle(a.id)).toBe("Harbor  Lights");
    // and the key it left is free again for another project
    const b = await createProject(e, { name: "b" });
    await setLastStoryboard(e, b.id, board("Harbor"));
    expect(storedTitle(b.id)).toBe("Harbor");
  });

  it("allows same NAME with different titles (the measured twice-* pair shape)", async () => {
    const e = env();
    const a = await createProject(e, { name: "twice" });
    const b = await createProject(e, { name: "twice" });
    await setLastStoryboard(e, a.id, board("Take one"));
    await setLastStoryboard(e, b.id, board("Take two"));
    expect(storedTitle(b.id)).toBe("Take two");
  });

  it("does not check an untitled board, and an untitled board holds no key", async () => {
    const e = env();
    const a = await createProject(e, { name: "a" });
    const b = await createProject(e, { name: "b" });
    await setLastStoryboard(e, a.id, { scenes: [] });
    await setLastStoryboard(e, b.id, { scenes: [] });
    await setLastStoryboard(e, b.id, board("project")); // "project" is the empty-title fallback key
    expect(storedTitle(b.id)).toBe("project");
  });

  it("skips a stored board that is not valid JSON instead of failing the save", async () => {
    const e = env();
    const a = await createProject(e, { name: "a" });
    d1!.raw.prepare("UPDATE storyboard_projects SET last_storyboard_json = ? WHERE id = ?").run("{not json", a.id);
    const b = await createProject(e, { name: "b" });
    const row = await setLastStoryboard(e, b.id, board("Neon City"));
    expect(row?.last_storyboard).toEqual(board("Neon City"));
    expect((await getProjectById(e, a.id))?.last_storyboard).toBeNull();
  });

  it("finds a holder past any page size: no cap on the scan", async () => {
    const e = env();
    for (let i = 0; i < 520; i++) {
      d1!.raw.prepare(
        "INSERT INTO storyboard_projects (public_id, slug, name, prefs_json, last_storyboard_json) VALUES (?, ?, ?, '{}', ?)",
      ).run(`p-${i}`, `s-${i}`, `n-${i}`, JSON.stringify(board(`Title ${i}`)));
    }
    const late = await createProject(e, { name: "late" });
    await expect(setLastStoryboard(e, late.id, board("Title 519"))).rejects.toBeInstanceOf(BoardKeyCollisionError);
    await expect(setLastStoryboard(e, late.id, board("Title 0"))).rejects.toBeInstanceOf(BoardKeyCollisionError);
  });
});
