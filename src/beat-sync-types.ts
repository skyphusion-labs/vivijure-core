// Beat-sync / planner analyze types. Upstream keeps these in modules/beat-sync/src/contract.ts;
// vivijure-core keeps them out of modules/types.ts so that file stays verbatim with vivijure main.

import type { ScoreOutput } from "./modules/types.js";

export interface TimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}

export interface AudioBeatPlan {
  mode: "beat" | "duration";
  audioKey: string;
  durationSeconds: number;
  bpm?: number;
  beatCount?: number;
  suggestedShots: number;
  clipSeconds: number;
  filmSeconds: number;
  remainderSeconds: number;
  timedScenes: TimedScene[];
  note: string;
}

/** POST /api/audio/analyze request (camelCase). */
export interface AudioAnalyzeRequest {
  audioKey: string;
  clipSeconds?: number;
  mode?: "beat" | "duration";
  minSceneS?: number;
  maxSceneS?: number;
  forceShots?: number;
}

export interface BeatSyncOutput extends ScoreOutput {
  beat_plan?: AudioBeatPlan;
}
