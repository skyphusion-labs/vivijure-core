/**
 * Async assemble/mux against video-finish.
 *
 * POST /finish is synchronous concat. A 17-shot gather downloads every clip,
 * ffmpeg, and PUTs the film. That outlives the Cloudflare Worker fetch
 * budget (~100-125s) and comes back as HTTP 524 even when DNS is grey-cloud,
 * because the caller IS a Worker. POST /async/finish returns 202 + jobId
 * immediately; we poll /async/status across ticks.
 *
 * Jobs live in-process on one replica. Submit goes to VIDEO_FINISH_URL (the
 * LB). Poll hits that origin plus per-box poll URLs so a 404 from a peer
 * is not "job gone".
 */
import type { Env } from "./platform/orchestrator-context.js";
import { isMediaFinishAuthError, mediaFinishHeaders, videoFinishFetch, videoFinishUrl } from "./media-finish-auth.js";

export const HOSTED_FINISH_POLL_BOXES = ["jello", "descendents", "badbrains"] as const;
export const ASSEMBLE_NOTFOUND_STREAK = 12;

export type FinishPayload = {
  clips: { url: string }[];
  outputUrl: string;
  outputKey: string;
  width?: number;
  height?: number;
  fps?: number;
  audioUrl?: string;
  remuxAudioOnly?: boolean;
  keepClipAudio?: boolean;
};

export type FinishResult = {
  ok?: boolean;
  error?: string;
  key?: string;
  durationSeconds?: number;
  shots?: number;
  clipsReceived?: number;
  clipDurations?: number[];
  elapsedMs?: number;
  hasAudio?: boolean;
};

export type AssemblePollState = {
  jobId: string;
  submittedAt: number;
  notFoundStreak: number;
};

export type AssembleTick =
  | { kind: "pending"; poll: AssemblePollState }
  | { kind: "done"; result: FinishResult }
  | { kind: "failed"; error: string };

export function encodeAssemblePoll(p: AssemblePollState): string {
  return JSON.stringify(p);
}

export function decodeAssemblePoll(raw: string | undefined | null): AssemblePollState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<AssemblePollState>;
    if (typeof p.jobId !== "string" || !p.jobId) return null;
    return {
      jobId: p.jobId,
      submittedAt: typeof p.submittedAt === "number" ? p.submittedAt : Date.now(),
      notFoundStreak: typeof p.notFoundStreak === "number" && p.notFoundStreak > 0
        ? Math.floor(p.notFoundStreak)
        : 0,
    };
  } catch {
    return null;
  }
}

/** Submit origin plus per-box poll origins. Hosted fleet is 3 replicas. */
export function videoFinishPollUrls(env: Env): string[] {
  const base = videoFinishUrl(env);
  if (!base) return [];
  const extra = typeof env.VIDEO_FINISH_POLL_URLS === "string" ? env.VIDEO_FINISH_POLL_URLS : "";
  const listed = extra.split(/[,\s]+/).map((s) => s.replace(/\/$/, "")).filter(Boolean);
  const out = [base, ...listed];
  try {
    const u = new URL(base);
    if (u.hostname === "video-finish.skyphusion.org") {
      for (const box of HOSTED_FINISH_POLL_BOXES) {
        out.push(`${u.protocol}//video-finish-${box}.skyphusion.org`);
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

async function submitAsync(env: Env, payload: FinishPayload): Promise<string | null> {
  const init = {
    method: "POST",
    headers: await mediaFinishHeaders(env),
    body: JSON.stringify(payload),
  };
  let resp: Response | null = null;
  try {
    resp = await videoFinishFetch(env, "/async/finish", init);
  } catch (e) {
    if (isMediaFinishAuthError(e)) throw e;
    return null;
  }
  if (!resp || resp.status !== 202) return null;
  try {
    const body = (await resp.json()) as { ok?: boolean; jobId?: string };
    return body.ok === true && typeof body.jobId === "string" && body.jobId.length > 0
      ? body.jobId
      : null;
  } catch {
    return null;
  }
}

type StatusHit =
  | { kind: "completed"; result: FinishResult }
  | { kind: "failed"; error: string }
  | { kind: "pending" }
  | { kind: "missing" };

async function pollOne(env: Env, base: string, jobId: string): Promise<StatusHit> {
  const headers = await mediaFinishHeaders(env);
  let resp: Response;
  try {
    resp = await fetch(`${base}/async/status/${encodeURIComponent(jobId)}`, { headers });
  } catch {
    return { kind: "missing" };
  }
  if (resp.status === 404) return { kind: "missing" };
  if (resp.status === 524 || resp.status === 502 || resp.status === 503 || resp.status === 504) {
    return { kind: "pending" };
  }
  if (!resp.ok) return { kind: "pending" };
  let body: { status?: string; result?: FinishResult; error?: string };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return { kind: "pending" };
  }
  if (body.status === "completed") {
    return { kind: "completed", result: body.result && typeof body.result === "object" ? body.result : { ok: true } };
  }
  if (body.status === "failed") {
    return { kind: "failed", error: body.error || "video-finish async job failed" };
  }
  if (body.status === "pending") return { kind: "pending" };
  return { kind: "missing" };
}

export async function pollVideoFinishAsync(env: Env, jobId: string): Promise<StatusHit> {
  const urls = videoFinishPollUrls(env);
  if (urls.length === 0) return { kind: "missing" };
  const hits = await Promise.all(urls.map((u) => pollOne(env, u, jobId)));
  const done = hits.find((h) => h.kind === "completed");
  if (done) return done;
  const failed = hits.find((h) => h.kind === "failed");
  if (failed) return failed;
  if (hits.some((h) => h.kind === "pending")) return { kind: "pending" };
  return { kind: "missing" };
}

/**
 * One assemble/mux tick. First call submits. Later calls poll. 404 from a
 * peer replica is pending until ASSEMBLE_NOTFOUND_STREAK misses in a row.
 */
export async function tickVideoFinishAssemble(
  env: Env,
  payload: FinishPayload,
  pollRaw: string | undefined,
): Promise<AssembleTick> {
  try {
    return await tickVideoFinishAssembleInner(env, payload, pollRaw);
  } catch (e) {
    if (isMediaFinishAuthError(e)) return { kind: "failed", error: e.message };
    throw e;
  }
}

async function tickVideoFinishAssembleInner(
  env: Env,
  payload: FinishPayload,
  pollRaw: string | undefined,
): Promise<AssembleTick> {
  const existing = decodeAssemblePoll(pollRaw);
  let jobId = existing?.jobId;
  let submittedAt = existing?.submittedAt ?? Date.now();
  let notFoundStreak = existing?.notFoundStreak ?? 0;
  if (!jobId) {
    const submitted = await submitAsync(env, payload);
    if (!submitted) {
      return { kind: "failed", error: "video-finish async submit failed (no jobId)" };
    }
    jobId = submitted;
    submittedAt = Date.now();
    notFoundStreak = 0;
    // Same tick: a remux that already finished completes now. A 20-shot
    // concat is still pending and the next poll tick picks it up.
  }
  const hit = await pollVideoFinishAsync(env, jobId);
  if (hit.kind === "completed") {
    if (hit.result.ok === false) {
      return { kind: "failed", error: hit.result.error || "video-finish gather failed" };
    }
    return { kind: "done", result: hit.result };
  }
  if (hit.kind === "failed") return { kind: "failed", error: hit.error };
  if (hit.kind === "pending") {
    return { kind: "pending", poll: { jobId, submittedAt, notFoundStreak: 0 } };
  }
  const streak = notFoundStreak + 1;
  if (streak >= ASSEMBLE_NOTFOUND_STREAK) {
    return { kind: "failed", error: "video-finish assemble job not found on any replica; resubmit" };
  }
  return { kind: "pending", poll: { jobId, submittedAt, notFoundStreak: streak } };
}
