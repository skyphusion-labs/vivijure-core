import { afterEach, describe, expect, it } from "vitest";
import { setRenderAudioOutput } from "../src/renders-db.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

// core#225: setRenderAudioOutput is safe only because it MERGES (json_set) rather than
// replacing output_json. Nothing in the suite pinned that property. A whole-payload rewrite
// (the obvious "simplification", and the core#205 defect class) would erase sibling film
// keys on a finished row, and a test that only checked the three audio keys would stay green.
//
// Behavioural: write a finished-render payload, call setRenderAudioOutput, assert the
// pre-existing film keys SURVIVE. Named keys, not "no exception".

const SIBLINGS = {
  project: "proj-c225-distinct",
  keyframes_incomplete: { adopted: 7, expected: 9, dropped: ["shot_08", "shot_09"] },
  clips: { shot_01: "renders/proj-c225-distinct/shot_01.mp4" },
  model: "wan-c225",
  derive_mode: "full",
};

const ORIGINAL_AUDIO = {
  output_key: "renders/proj-c225-distinct/film-silent.mp4",
  has_audio: false,
  seconds: 9,
};

const MUXED_KEY = "renders/proj-c225-distinct/film-audio.mp4";
const MUXED_SECONDS = 12.5;

const open: TestD1[] = [];
function openD1(): TestD1 {
  const d1 = openTestD1();
  open.push(d1);
  return d1;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function seedFinished(d1: TestD1): number {
  const payload = { ...ORIGINAL_AUDIO, ...SIBLINGS };
  d1.raw
    .prepare(
      `INSERT INTO renders (job_id, status, submitted_at, output_key, output_json, notified_at, mode, parent_id)
       VALUES (?, 'COMPLETED', ?, ?, ?, NULL, 'full', NULL)`,
    )
    .run("film-c225", Math.floor(Date.now() / 1000), payload.output_key, JSON.stringify(payload));
  const row = d1.raw
    .prepare("SELECT id FROM renders WHERE job_id = ?")
    .get("film-c225") as { id: number };
  return Number(row.id);
}

function readOutput(d1: TestD1, id: number): Record<string, unknown> {
  const row = d1.raw
    .prepare("SELECT output_key, output_json FROM renders WHERE id = ?")
    .get(id) as { output_key: string | null; output_json: string | null };
  return {
    column_output_key: row.output_key,
    ...(JSON.parse(row.output_json ?? "{}") as Record<string, unknown>),
  };
}

describe("core#225: setRenderAudioOutput merges; sibling film keys survive", () => {
  it("CONTROL: the seeded finished row carries the sibling keys before the write", () => {
    const d1 = openD1();
    const id = seedFinished(d1);
    const before = readOutput(d1, id);
    expect(before.project).toBe(SIBLINGS.project);
    expect(before.keyframes_incomplete).toEqual(SIBLINGS.keyframes_incomplete);
    expect(before.clips).toEqual(SIBLINGS.clips);
    expect(before.model).toBe(SIBLINGS.model);
    expect(before.derive_mode).toBe(SIBLINGS.derive_mode);
    expect(before.output_key).toBe(ORIGINAL_AUDIO.output_key);
    expect(before.has_audio).toBe(false);
  });

  it("a partial audio update cannot clobber sibling output_json fields", async () => {
    const d1 = openD1();
    const id = seedFinished(d1);
    const env = { DB: d1.DB } as unknown as Env;
    const changed = await setRenderAudioOutput(env, id, MUXED_KEY, MUXED_SECONDS);
    expect(changed).toBe(true);

    const after = readOutput(d1, id);
    console.log(`core#225 after keys: ${JSON.stringify(Object.keys(after).sort())}`);

    // THE ASSERTION. A whole-payload rewrite that only sets the three audio keys
    // would keep these three green and drop everything below.
    expect(after.output_key).toBe(MUXED_KEY);
    expect(after.column_output_key).toBe(MUXED_KEY);
    expect(after.has_audio).toBe(true);
    expect(Number(after.seconds)).toBe(MUXED_SECONDS);

    expect(after.project, "project must survive a merge").toBe(SIBLINGS.project);
    expect(after.keyframes_incomplete, "keyframes_incomplete must survive a merge").toEqual(
      SIBLINGS.keyframes_incomplete,
    );
    expect(after.clips, "clips must survive a merge").toEqual(SIBLINGS.clips);
    expect(after.model, "model must survive a merge").toBe(SIBLINGS.model);
    expect(after.derive_mode, "derive_mode must survive a merge").toBe(SIBLINGS.derive_mode);
  });
});
