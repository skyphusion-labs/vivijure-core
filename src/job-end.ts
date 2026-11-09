// core#490: the one way a film or scatter job reaches a terminal phase, and the one place its end
// time is written.
//
// A poll view used to report a finished job's runtime as `now - created_at`, so a job first polled
// late recorded a late figure. `phase_started_at` is not an end stamp: it is written only on a phase
// change inside an advance tick, so a cancel, the advance catch path and the start-path failures
// leave it at the start of an earlier phase (measured on vivijure-core#490: film-8a5d078 read 0 s
// against a 1428 s run). So the end time is its own field, `ended_at`, written here and only here.
//
// tests/job-end-490.test.ts scans src/ and fails on any terminal phase or cancel written another
// way, so a new terminal site cannot quietly skip the stamp.
//
// The stamp is the time of the LATEST terminal write. A job that leaves a terminal phase (the
// keyframes-reuse start placeholder, a finish retry) and ends again is stamped again. A job read
// while it is not terminal reports `now - created_at`, whatever `ended_at` holds.
//
// Not a billing figure: RunPod bills GPU time from its own records, and nothing that charges a
// tenant reads `executionTimeMs` or `renders.execution_time_ms`. This is a correctness fix.

export type TerminalPhase = "done" | "failed";

/** The fields both FilmJob and ScatterJob carry. */
export interface EndableJob {
  phase: string;
  created_at: number;
  /** core#490: wall clock of the latest terminal write. Absent on docs written before core#490. */
  ended_at?: number;
  cancelled?: boolean;
}

/** Put a job in a terminal phase and stamp when it ended. `now` is injectable for tests. */
export function endJob<J extends EndableJob>(
  job: J,
  phase: Extract<J["phase"], TerminalPhase>,
  now: number = Date.now(),
): void {
  job.phase = phase;
  job.ended_at = now;
}

/** Cancel a job: it is failed, flagged cancelled, and stamped. The caller sets `error`. */
export function cancelJob<J extends EndableJob>(job: J, now: number = Date.now()): void {
  job.cancelled = true;
  endJob(job, "failed" as Extract<J["phase"], TerminalPhase>, now);
}

export function isTerminalJob(job: EndableJob): boolean {
  return !!job.cancelled || job.phase === "done" || job.phase === "failed";
}

/** Runtime for a poll view: `ended_at - created_at` once the job has ended, `now - created_at`
 *  while it runs. A terminal doc written before core#490 has no `ended_at` and keeps the old
 *  figure, `now - created_at`; the render row keeps its first terminal write (core#487). */
export function jobElapsedMs(job: EndableJob, now: number = Date.now()): number {
  const end = isTerminalJob(job) && typeof job.ended_at === "number" ? job.ended_at : now;
  return Math.max(0, end - job.created_at);
}
