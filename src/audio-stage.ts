import type { Env } from "./platform/orchestrator-context.js";
import { needsAudioCrossBucketCopy } from "./audio-routing.js";

export async function stageAudioKeyForRenders(env: Env, audioKey: string): Promise<string> {
  const key = audioKey.trim();
  if (!key) throw new Error("audioKey required");
  if (!needsAudioCrossBucketCopy(key)) return key;
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
