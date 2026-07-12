import type { OrchestratorEnv } from "./platform/orchestrator-context.js";
import { readTar } from "./tar.js";
import { parseShotDurations } from "./shot-durations-parse.js";

function chunkForStream(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = bytes.slice();
  return chunk as Uint8Array<ArrayBuffer>;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(chunkForStream(bytes)).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(chunkForStream(bytes)).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function readShotDurationsFromBundle(
  env: OrchestratorEnv,
  bundleKey: string,
): Promise<Record<string, number>> {
  try {
    const src = await env.R2_RENDERS.get(bundleKey);
    if (!src) return {};
    const tarBytes = await gunzipBytes(new Uint8Array(await src.arrayBuffer()));
    for (const e of readTar(tarBytes)) {
      if (e.name === "storyboard.yaml") {
        return parseShotDurations(new TextDecoder().decode(e.content));
      }
    }
  } catch {
    // best-effort
  }
  return {};
}
