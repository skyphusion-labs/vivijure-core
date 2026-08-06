// #767 regression (keyframe leg): keyframes are project-scoped and motion-backend-agnostic (SDXL), so two
// renders that differ only in motion backend legitimately SHARE them. But a render with a DIFFERENT keyframe
// config must NOT adopt another config's keyframe. The keyframe provenance sidecar gates listProjectKeyframes
// (the R2-presence reclaim source) the same way the clip sidecar gates reclaimClipsFromR2.

import { describe, it, expect } from "vitest";
import { listProjectKeyframes } from "../src/film-orchestrator.js";
import type { FilmScene } from "../src/film-model.js";
import { keyframeProvenanceHash, provKey } from "../src/clip-provenance.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const NOW = 5_000_000;
const KF = "renders/proj/keyframes/shot_01.png";
const SCENES: FilmScene[] = [{ shot_id: "shot_01", prompt: "a knight", seconds: 5 }];

function memR2() {
  const store = new Map<string, { body: string; uploaded: number }>();
  const seed = (key: string, o: { body?: string; uploaded?: number } = {}) =>
    store.set(key, { body: o.body ?? "", uploaded: o.uploaded ?? NOW + 1_000 });
  const env = {
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, uploaded: new Date(v.uploaded) })),
        truncated: false,
      }),
      get: async (key: string) => { const o = store.get(key); return o ? { text: async () => o.body } : null; },
    },
  } as unknown as Env;
  return { store, env, seed };
}

const BUNDLE_A = "bundles/aaa111bbbb2222.tar.gz";
const BUNDLE_B = "bundles/cccc3333dddd4444.tar.gz";

async function stamp(
  seed: ReturnType<typeof memR2>["seed"],
  key: string,
  keyframe_config: Record<string, unknown>,
  bundle_key: string = BUNDLE_A,
) {
  seed(key);
  seed(provKey(key), { body: await keyframeProvenanceHash({ keyframe_config, bundle_key }) });
}

describe("#767 keyframe-adoption provenance", () => {
  it("does NOT adopt a keyframe a different-keyframe-config render wrote", async () => {
    const { env, seed } = memR2();
    await stamp(seed, KF, { quality_tier: "draft" });
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_A);
    expect(kfs.length).toBe(0); // mismatch -> regenerate, never adopt the draft keyframe for a final render
  });

  it("adopts a keyframe stamped with the SAME keyframe config (legit cross-backend share preserved)", async () => {
    const { env, seed } = memR2();
    await stamp(seed, KF, { quality_tier: "final" });
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_A);
    expect(kfs).toEqual([{ shot_id: "shot_01", keyframe_key: KF }]);
  });

  it("adopts an UNSTAMPED legacy keyframe (absent sidecar -> #661 freshness path, back-compat)", async () => {
    const { env, seed } = memR2();
    seed(KF); // no .prov sidecar
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_A);
    expect(kfs).toEqual([{ shot_id: "shot_01", keyframe_key: KF }]);
  });

  it("no keyframeConfig passed -> ungated (back-compat with existing callers)", async () => {
    const { env, seed } = memR2();
    await stamp(seed, KF, { quality_tier: "draft" });
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW); // no config arg
    expect(kfs).toEqual([{ shot_id: "shot_01", keyframe_key: KF }]);
  });
});

describe("cf#388 keyframe provenance includes bundle identity", () => {
  it("same keyframe_config under two different bundles does NOT cross-adopt", async () => {
    // Caller-supplied project "proj" for both; only bundle_key differs. Pre-fix hash matched.
    const { env, seed } = memR2();
    await stamp(seed, KF, { quality_tier: "final" }, BUNDLE_A);
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_B);
    expect(kfs.length).toBe(0);
  });

  it("hashes differ when only bundle_key differs", async () => {
    const cfg = { quality_tier: "final" };
    const a = await keyframeProvenanceHash({ keyframe_config: cfg, bundle_key: BUNDLE_A });
    const b = await keyframeProvenanceHash({ keyframe_config: cfg, bundle_key: BUNDLE_B });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });
});
