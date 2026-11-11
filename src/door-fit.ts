// vivijure-cf#930: a lined shot whose film door has a clip floor above the plan leaves the speaker
// mouthing silence after the line ends (cf#929 measured 3.6s of a 5s Wan clip). Conrad's ruling
// (2026-11-11): a per-shot motion door applies to that one clip only, and the film's door stays the
// default for every other shot. So the orchestrator may give such a shot its own door, from a list the
// caller offered, through the per_shot_motion map that already exists (core#442). Pure: no I/O.

import type { MotionUsageDecl, RegisteredModule } from "./modules/types.js";
import { doorBillsPerClip, usageOf } from "./motion-usage.js";
import { LINE_WAV_MAX_SECONDS } from "./wav-duration.js";

/** How much longer than the plan and the line a clip must run before it counts as a tail. Below this, a
 *  rounding step is not worth a different door. */
export const DOOR_FIT_TAIL_SECONDS = 0.5;

/** A shot that was moved to another door for this clip only. */
export interface DoorFitSwap {
  shot_id: string;
  /** The film door the shot would have rendered on. */
  from: string;
  /** The door it renders on instead. */
  to: string;
  line_seconds: number;
  planned_seconds: number;
  /** The clip length `from` would have made. */
  from_clip_seconds: number;
}

/** A lined shot that still ends in a silent-mouthing tail: the caller offered no substitute, or none fit. */
export interface DoorFitTail {
  shot_id: string;
  door: string;
  line_seconds: number;
  clip_seconds: number;
}

/** The job record and render-row view. Absent when no lined shot had a tail. */
export interface DoorFitRecord {
  swapped: DoorFitSwap[];
  tails: DoorFitTail[];
}

/** The clip a door makes for a shot of `plannedSeconds`. A door with `duration_steps` rounds UP to the
 *  next step (the largest when the plan is past them all); any other door clamps to its range. */
export function clipSecondsOnDoor(usage: MotionUsageDecl, plannedSeconds: number): number {
  const planned = Number.isFinite(plannedSeconds) && plannedSeconds > 0 ? plannedSeconds : usage.min_seconds;
  const steps = usage.duration_steps ? [...usage.duration_steps].sort((a, b) => a - b) : undefined;
  if (steps && steps.length) return steps.find((s) => s >= planned) ?? steps[steps.length - 1];
  return Math.min(Math.max(planned, usage.min_seconds), usage.max_seconds);
}

/** The silent-mouthing tail a driven door leaves on a shot, in seconds, or 0. Only a door that bills by
 *  length can leave one: a per-clip door has its line padded to the plan (cf#1338) and sizes its clip from
 *  the line. A tail is counted only when the door's floor pushes the clip past the plan, so a shot planned
 *  longer than its line is the plan's choice, not the door's. */
export function doorTailSeconds(
  mod: RegisteredModule | undefined,
  lineSeconds: number,
  plannedSeconds: number,
): { tail: number; clip: number } {
  const usage = usageOf(mod);
  if (!usage || usage.driving_audio !== true || doorBillsPerClip(mod)) return { tail: 0, clip: 0 };
  const clip = clipSecondsOnDoor(usage, plannedSeconds);
  // The line on a by-length door is padded to the door's audio floor only (drivenLineFloorSeconds).
  const floor = Math.min(usage.driving_audio_min_seconds ?? 0, usage.max_seconds, LINE_WAV_MAX_SECONDS);
  const audio = Math.max(lineSeconds, floor);
  const planned = Number.isFinite(plannedSeconds) && plannedSeconds > 0 ? plannedSeconds : 0;
  if (clip - planned <= DOOR_FIT_TAIL_SECONDS || clip - audio <= DOOR_FIT_TAIL_SECONDS) return { tail: 0, clip };
  return { tail: clip - audio, clip };
}

/** The first offered door that can take this shot without a tail: serving, driven by audio (the shot is
 *  lined, so its door must follow the line), not the film door, and passing `accepts` (the caller's
 *  per-shot `requires` check). Order is the caller's. */
export function pickFitDoor(
  offered: readonly string[],
  serving: readonly RegisteredModule[],
  filmDoor: string,
  lineSeconds: number,
  plannedSeconds: number,
  accepts: (mod: RegisteredModule) => boolean,
): RegisteredModule | undefined {
  for (const name of offered) {
    if (name === filmDoor) continue;
    const mod = serving.find((m) => m.name === name);
    if (!mod || usageOf(mod)?.driving_audio !== true) continue;
    if (doorTailSeconds(mod, lineSeconds, plannedSeconds).tail > 0) continue;
    if (!accepts(mod)) continue;
    return mod;
  }
  return undefined;
}
