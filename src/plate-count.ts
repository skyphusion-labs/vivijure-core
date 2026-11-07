// The plate count guard, carried from the GPU backend to the render row (vivijure-cf#1143 follow-up).
//
// On a two-person shot the backend draws the background plate, counts the faces in it, and redraws
// when it finds more people than the shot asked for. It reports what it saw on each keyframe entry as
// `plate_count: {expected, faces, chosen, clean, retries}` (vivijure-backend docs/contract.md, the
// `keyframes` row). `clean: false` means no draw held at most `expected` faces, so the still was made
// from the draw with the fewest and may show an extra person. Under the face floor (vivijure-backend#605)
// the block also carries `floor: true`, and `clean` then needs the exact count, so `clean: false` can
// mean a plate short of a person. The flag is carried, never inferred (vivijure-core#492).
//
// Before this file the core dropped the field in three places (the module contract type, the job
// doc's keyframe refs, and the render row), so the studio could not tell a user that a still was
// made from a plate the guard could not clean. A guard whose failure is silent reads as a pass.
//
// THE LADDER is the same three states the other render signals use:
//   key ABSENT        the guard never ran on any still in this render (one-person shots, a backend
//                     without the guard, a cloud keyframe door). Not measured. The panel shows nothing.
//   unclean: []       the guard ran and every still came out clean. Measured, not a warning.
//   unclean: [...]    the guard ran and these stills may show an extra person.

import type { PlateCount } from "./modules/types.js";

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Strict read of one `plate_count` block. Anything that is not the documented shape is dropped
 *  (undefined) rather than guessed at: a malformed block must never be read as `clean: true`, and it
 *  must never fail the keyframe either, because the still itself is fine to use. */
export function parsePlateCount(raw: unknown): PlateCount | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.clean !== "boolean") return undefined;
  if (!isCount(o.expected) || !isCount(o.chosen) || !isCount(o.retries)) return undefined;
  if (!Array.isArray(o.faces) || !o.faces.every(isCount)) return undefined;
  return {
    expected: o.expected,
    faces: [...(o.faces as number[])],
    chosen: o.chosen,
    clean: o.clean,
    retries: o.retries,
    // Only a literal `true` means the floor ran; any other value is not the documented shape and is
    // dropped, so a missing or odd flag reads as "no floor", never as one (vivijure-core#492).
    ...(o.floor === true ? { floor: true as const } : {}),
  };
}

/** One still the guard could not clean, as the render row carries it. */
export interface PlateCheckUnclean {
  shot_id: string;
  expected: number;
  /** Faces on the draw the still was made from, or null when `chosen` points outside `faces`. */
  faces: number | null;
}

/** The render-level summary on `output.plate_check`. */
export interface PlateCheckView {
  /** Stills the guard ran on. */
  checked: number;
  /** The stills that may show an extra person, in keyframe order. */
  unclean: PlateCheckUnclean[];
}

/** Summarise the guard over a render's keyframes. Undefined when it ran on none of them (the absent
 *  rung of the ladder), so a render the guard never looked at is not reported as clean. */
export function plateCheckView(
  keyframes: ReadonlyArray<{ shot_id: string; plate_count?: PlateCount }> | undefined,
): PlateCheckView | undefined {
  if (!keyframes?.length) return undefined;
  let checked = 0;
  const unclean: PlateCheckUnclean[] = [];
  for (const k of keyframes) {
    const pc = k.plate_count;
    if (!pc) continue;
    checked++;
    if (pc.clean) continue;
    const faces = pc.faces[pc.chosen];
    unclean.push({ shot_id: k.shot_id, expected: pc.expected, faces: typeof faces === "number" ? faces : null });
  }
  if (!checked) return undefined;
  return { checked, unclean };
}
