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
import {
  isMediaFinishAuthError,
  mediaDoorFetcher,
  mediaFinishHeaders,
  videoFinishFetch,
  videoFinishUrl,
} from "./media-finish-auth.js";
import { presignR2Get, presignR2Put } from "./presign.js";

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
  /**
   * cf#784 chunked assemble. One presigned {put,get} pair per batch partial, consumed in order.
   * ABSENT or EMPTY selects the container's single-pass path, so omitting it is the old
   * behaviour byte for byte. Never sent with remuxAudioOnly, which is single-pass by definition.
   */
  partialUrls?: PartialUrlPair[];
};


// ---------------------------------------------------------------------------------------------
// Chunked assemble: the partialUrls pool, and the TTL that has to outlive the whole job.
// ---------------------------------------------------------------------------------------------
//
// The container (vivijure-cf containers/video-finish, cf#784/#801) holds NO R2 credentials by
// design, so it can only write a batch partial to a URL the Worker handed it. It consumes one
// {put,get} pair per batch, in order, and raises a loud 400 when the pool runs out. With no pool
// at all it takes the single-pass path, which is why chunked assemble was inert until this code
// existed.
//
// WHY THE TTL IS A CONSTANT WITH AN ASSERTION AND NOT A COMMENT. Every presigned URL in an
// assemble payload used to be minted at 1800s. Under single-pass that was sound: every clip is
// downloaded in the first seconds of the job, so a 30 minute window covered the only access that
// happened. Chunking invalidates that assumption in TWO places, and only one of them is new code:
//
//   * the final pass concatenates the partials, and partial_gets[0] is minted at t0 but first
//     READ at t_final, so a partial GET sized to the join has already expired by the time it is
//     used;
//   * batch N downloads its own clips only after batches 0..N-1 have fully normalized through
//     libx264, so the INPUT clip GETs must outlive the whole job too. This is the one that gets
//     missed, because the line of code did not change; its assumption did.
//
// A README cannot fail and a comment cannot fail. assertAssembleTtl() fails, at module load and
// again on every mint, so a URL that cannot outlive its job cannot be produced at all.

/**
 * The wall clock one assemble job may occupy before the Worker declares it dead.
 *
 * Derived from the container's own contract rather than picked: MAX_CLIP_BYTES is 256 MB and
 * MAX_CLIPS is 80, and every clip is re-encoded through libx264 at `-preset medium`. A 256 MB
 * clip is minutes of video, so a contracted-maximum film is hours of CPU on a 4 vCPU instance,
 * not minutes. Six hours covers that with margin while still being a bound rather than "forever".
 *
 * This is ALSO the give-up horizon, deliberately. Past it the presigned URLs are expired, so the
 * job provably cannot succeed and further polling waits on a guaranteed failure. Tying the two to
 * one constant is what stops them drifting apart: shorten the TTL and you shorten the horizon.
 */
export const ASSEMBLE_MAX_JOB_SECONDS = 6 * 3600;

/**
 * TTL every presigned URL in an assemble payload is minted with. Strictly greater than the
 * horizon so a job that dies exactly at the horizon dies of the horizon, with a clear error,
 * rather than of an expired signature two seconds earlier with a 403 from R2.
 */
export const ASSEMBLE_PRESIGN_TTL_SECONDS = ASSEMBLE_MAX_JOB_SECONDS + 1800;

/**
 * Upper bound on pool size. Mirrors MAX_CLIPS in containers/video-finish/app.py; a film with more
 * clips than this is refused by the container regardless, so minting past it is pure waste.
 */
export const ASSEMBLE_MAX_POOL_PAIRS = 80;

/** A presigned {put,get} pair for one batch partial. */
export type PartialUrlPair = { put: string; get: string };

/**
 * Refuse a TTL that cannot outlive the job it is being minted for.
 *
 * Throws rather than clamping: a caller that asked for 1800s has a wrong model of the job, and
 * silently widening it to 7h would hide exactly the mistake this exists to surface.
 */
export function assertAssembleTtl(ttlSeconds: number, what: string): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < ASSEMBLE_MAX_JOB_SECONDS) {
    throw new Error(
      `${what}: ${ttlSeconds}s cannot outlive an assemble job (horizon ${ASSEMBLE_MAX_JOB_SECONDS}s). ` +
        "Under chunked assemble the final pass reads the FIRST partial at the END of the job, and " +
        "batch N downloads its clips only after batch N-1 has encoded, so every URL in an assemble " +
        "payload must cover the whole job. Use ASSEMBLE_PRESIGN_TTL_SECONDS.",
    );
  }
  return ttlSeconds;
}

// Load-bearing: this runs at module load, so a future edit that shortens the TTL below the
// horizon fails the Worker at deploy and in every test that imports this module, not in
// production six hours into somebody's film.
assertAssembleTtl(ASSEMBLE_PRESIGN_TTL_SECONDS, "ASSEMBLE_PRESIGN_TTL_SECONDS");

/**
 * Deterministic R2 key for batch partial `index` of the film whose output is `outputKey`.
 *
 * Deterministic on purpose: cleanup then needs no stored state, so a partial cannot be orphaned
 * by a job doc that lost a field.
 */
export function partialKeyFor(outputKey: string, index: number): string {
  const slash = outputKey.lastIndexOf("/");
  const dir = slash >= 0 ? outputKey.slice(0, slash) : "";
  const n = String(index).padStart(3, "0");
  return dir ? `${dir}/partials/partial-${n}.mp4` : `partials/partial-${n}.mp4`;
}

/**
 * Mint the {put,get} pool for a chunked assemble.
 *
 * POOL SIZE IS PROVABLE, NOT A GUESS. The container flushes a batch only when the batch is
 * non-empty, so every batch contains at least one clip, so the number of batches can never exceed
 * the number of clips. `clipCount` pairs is therefore an exact upper bound -- no HEAD probe, no
 * byte accounting on the Worker side, no way to under-mint. The container consumes what its
 * byte-batching needs and the unused tail simply expires; presigning is local HMAC with no
 * network, so that tail is close to free.
 */
export async function mintPartialUrlPool(
  env: Env,
  outputKey: string,
  clipCount: number,
  ttlSeconds: number = ASSEMBLE_PRESIGN_TTL_SECONDS,
): Promise<PartialUrlPair[]> {
  assertAssembleTtl(ttlSeconds, "partialUrls pool TTL");
  const pairs = Math.max(0, Math.min(clipCount, ASSEMBLE_MAX_POOL_PAIRS));
  if (pairs === 0) return [];
  return Promise.all(
    Array.from({ length: pairs }, async (_unused, i) => {
      const key = partialKeyFor(outputKey, i);
      const [put, get] = await Promise.all([
        presignR2Put(env, key, ttlSeconds, "video/mp4"),
        presignR2Get(env, key, ttlSeconds),
      ]);
      return { put, get };
    }),
  );
}

/**
 * Best-effort delete of every partial a job could have written.
 *
 * Candidate keys are deterministic, so this needs nothing from the job doc. Slots the container
 * never used were never written and their delete is a no-op. A cleanup miss NEVER fails a film
 * that rendered: the partials are intermediate garbage and a storage leak is a smaller harm than
 * failing a finished film. It is not silent either -- the count of failures is returned.
 */
export async function deletePartialPool(
  env: Env,
  outputKey: string,
  clipCount: number,
): Promise<{ attempted: number; failed: number }> {
  const pairs = Math.max(0, Math.min(clipCount, ASSEMBLE_MAX_POOL_PAIRS));
  let failed = 0;
  await Promise.all(
    Array.from({ length: pairs }, async (_unused, i) => {
      try {
        await env.R2_RENDERS.delete(partialKeyFor(outputKey, i));
      } catch {
        failed += 1;
      }
    }),
  );
  return { attempted: pairs, failed };
}

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
  return pollVia(env, (path, init) => fetch(base + path, init), jobId);
}

/**
 * One poll, over whatever transport the caller supplies.
 *
 * Split out for cf#810: SUBMIT goes through the binding but POLL used a raw global fetch against
 * per-box hostnames, and shipping only half of that would have submitted into the container and
 * then polled three authoritative NXDOMAINs for the answer. Every job would have hung as `missing`
 * until the not-found streak gave up. Transport is one decision, so it is made in one place.
 */
async function pollVia(
  env: Env,
  send: (path: string, init: RequestInit) => Promise<Response>,
  jobId: string,
): Promise<StatusHit> {
  const headers = await mediaFinishHeaders(env);
  let resp: Response;
  try {
    resp = await send(`/async/status/${encodeURIComponent(jobId)}`, { headers });
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
    // cf#835: "completed" with no result OBJECT used to be synthesized into `{ ok: true }`, which is
    // the studio inventing a success the container never reported. Everything downstream then read
    // undefined as absent-but-fine: clipDurations undefined no-ops the #697 duration gate, and
    // hasAudio undefined is not `=== false` so the mux degrade branch is skipped and job.film_key is
    // set to an output key that may never have been written. A completion with nothing in it is a
    // FAILURE of the contract, and the studio says so instead of filling the gap in for it.
    if (!body.result || typeof body.result !== "object") {
      return { kind: "failed", error: "video-finish reported completed with no result body" };
    }
    return { kind: "completed", result: body.result };
  }
  if (body.status === "failed") {
    return { kind: "failed", error: body.error || "video-finish async job failed" };
  }
  if (body.status === "pending") return { kind: "pending" };
  return { kind: "missing" };
}

export async function pollVideoFinishAsync(env: Env, jobId: string): Promise<StatusHit> {
  // Bound door: ONE target, not a fan-out. The per-box fan-out exists because jobs lived in the
  // memory of one of several replicas behind a load balancer, so a 404 from a peer was not
  // evidence. A DO stub is a single addressable instance and there are no peers to ask.
  //
  // The not-found STREAK is kept anyway, deliberately. Async job state still lives in container
  // process memory (#784 item 2 is not done), and a container restart or an instance eviction
  // loses it, so a 404 here is still "possibly transient" rather than proof the job never existed.
  // Tightening that debounce is a change to make when the state is externalised, not now.
  const bound = mediaDoorFetcher(env, "VIDEO_FINISH_URL");
  if (bound) {
    return pollVia(env, (path, init) => bound.fetch("http://video-finish" + path, init), jobId);
  }
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
  // Past the horizon every presigned URL in this job's payload has expired, so the job CANNOT
  // succeed: the container will 403 on its next clip download or on the final partial read. Before
  // this check nothing read submittedAt at all (verified grep-zero) and notFoundStreak resets to 0
  // on any `pending`, so an expired job polled forever. That is why a short TTL presented as a hang
  // rather than an error, and it is why the TTL and this horizon are one constant.
  const expired = Date.now() - submittedAt > ASSEMBLE_MAX_JOB_SECONDS * 1000;
  if (hit.kind === "completed") {
    if (hit.result.ok === false) {
      return { kind: "failed", error: hit.result.error || "video-finish gather failed" };
    }
    return { kind: "done", result: hit.result };
  }
  if (hit.kind === "failed") return { kind: "failed", error: hit.error };
  if (expired) {
    return {
      kind: "failed",
      error:
        `video-finish assemble exceeded ${ASSEMBLE_MAX_JOB_SECONDS}s; its presigned URLs have ` +
        "expired, so the job cannot complete. Resubmit, or reduce the film.",
    };
  }
  if (hit.kind === "pending") {
    return { kind: "pending", poll: { jobId, submittedAt, notFoundStreak: 0 } };
  }
  const streak = notFoundStreak + 1;
  if (streak >= ASSEMBLE_NOTFOUND_STREAK) {
    return { kind: "failed", error: "video-finish assemble job not found on any replica; resubmit" };
  }
  return { kind: "pending", poll: { jobId, submittedAt, notFoundStreak: streak } };
}
