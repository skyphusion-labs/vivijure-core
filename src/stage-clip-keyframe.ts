// Stage clip keyframes into the shared render bucket under renders/<project>/keyframes/<shot>.png
// (same layout as full-film keyframe phase and vivijure-backend i2v_clip contract).

import type { ClipShotInput } from "./clip-job-model.js";
import type { Env } from "./platform/orchestrator-context.js";
import { presignR2Get } from "./presign.js";

/** Motion backends that read keyframe_key from R2 (not a presigned URL image field). */
export const BUCKET_KEYFRAME_MOTION_BACKENDS = new Set(["own-gpu", "local-gpu"]);

const RENDERS_KEYFRAME_RE = /^renders\/[^/]+\/keyframes\/[^/]+\.(png|jpe?g)$/i;

export function canonicalClipKeyframeKey(project: string, shotId: string): string {
  const safeProject = project.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project";
  const safeShot = shotId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "shot";
  return `renders/${safeProject}/keyframes/${safeShot}.png`;
}

export function isRendersKeyframeKey(key: string | undefined): boolean {
  return typeof key === "string" && RENDERS_KEYFRAME_RE.test(key);
}

async function loadKeyframeBytes(
  env: Env,
  shot: ClipShotInput,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  if (shot.keyframe_key) {
    const obj = await env.R2_RENDERS.get(shot.keyframe_key);
    if (obj) {
      const head = await env.R2_RENDERS.head(shot.keyframe_key);
      return {
        bytes: await obj.arrayBuffer(),
        contentType: head?.httpMetadata?.contentType ?? "image/png",
      };
    }
  }
  if (shot.keyframe_url) {
    const r = await fetch(shot.keyframe_url, { signal: AbortSignal.timeout(120_000) });
    if (r.ok) {
      return {
        bytes: await r.arrayBuffer(),
        contentType: r.headers.get("content-type") ?? "image/png",
      };
    }
  }
  return null;
}

/** Copy or confirm a bucket-local keyframe for own-gpu / local-gpu clip submits. */
export async function ensureClipKeyframeInR2(
  env: Env,
  project: string,
  shot: ClipShotInput,
): Promise<ClipShotInput> {
  const canonical = canonicalClipKeyframeKey(project, shot.shot_id);
  if (shot.keyframe_key && isRendersKeyframeKey(shot.keyframe_key)) {
    const key = shot.keyframe_key;
    const existing = await env.R2_RENDERS.head(key);
    if (existing) {
      const keyframe_url = shot.keyframe_url || (await presignR2Get(env, key, 1800));
      return { ...shot, keyframe_key: key, keyframe_url };
    }
  }
  const loaded = await loadKeyframeBytes(env, shot);
  if (!loaded) {
    throw new Error(
      `keyframe missing for ${shot.shot_id}: need keyframe_key under renders/ or a fetchable keyframe_url`,
    );
  }
  await env.R2_RENDERS.put(canonical, loaded.bytes, {
    httpMetadata: { contentType: loaded.contentType.includes("image/") ? loaded.contentType : "image/png" },
  });
  const keyframe_url = await presignR2Get(env, canonical, 1800);
  return { ...shot, keyframe_key: canonical, keyframe_url };
}
