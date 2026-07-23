import type { Env } from "./platform/orchestrator-context.js";
import { needsAudioCrossBucketCopy } from "./audio-routing.js";
import { isSafeRelKey } from "./key-safety.js";

/** Keys under R2_RENDERS that stageAudioKeyForRenders may return or copy into without cross-bucket I/O. */
const RENDERS_AUDIO_PREFIXES = ["audio/", "dialogue/", "renders/", "out/"] as const;

function assertStagedAudioKey(key: string): void {
  if (!isSafeRelKey(key)) throw new Error(`unsafe audioKey: ${key}`);
  if (needsAudioCrossBucketCopy(key)) {
    const rest = key.slice("out/".length);
    if (!rest || rest.includes("/") || rest.startsWith(".")) {
      throw new Error(`out/ audioKey must be a single segment under out/: ${key}`);
    }
    return;
  }
  if (!RENDERS_AUDIO_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      `audioKey must start with one of ${RENDERS_AUDIO_PREFIXES.join(", ")} (got ${key})`,
    );
  }
}

export async function stageAudioKeyForRenders(env: Env, audioKey: string): Promise<string> {
  const key = audioKey.trim();
  if (!key) throw new Error("audioKey required");
  assertStagedAudioKey(key);
  if (!needsAudioCrossBucketCopy(key)) {
    // #31: an already-in-renders key (audio/… , dialogue/…) was returned unchecked; a stale or never-staged
    // key then yields a MISSING object downstream -> a silent audio track shipped as success. Verify presence
    // and fail loudly on a miss, matching the out/ branch below.
    if (!(await env.R2_RENDERS.head(key))) throw new Error(`audio source not found: ${key}`);
    return key;
  }
  if (await env.R2_RENDERS.head(key)) return key;
  const src = await env.R2.get(key);
  if (!src) throw new Error(`audio source not found: ${key}`);
  const ext = key.split(".").pop() || "mp3";
  const dest = `audio/${crypto.randomUUID()}.${ext}`;
  const head = await env.R2.head(key);
  const mime = head?.httpMetadata?.contentType || "audio/mpeg";
  await env.R2_RENDERS.put(dest, await src.arrayBuffer(), { httpMetadata: { contentType: mime } });
  return dest;
}

export async function resolveStagedAudioKey(env: Env, audioKey: string | undefined): Promise<string | undefined> {
  if (!audioKey?.trim()) return undefined;
  return stageAudioKeyForRenders(env, audioKey.trim());
}
