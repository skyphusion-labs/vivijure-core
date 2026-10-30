// #767 regression (keyframe leg): keyframes are project-scoped and motion-backend-agnostic (SDXL), so two
// renders that differ only in motion backend legitimately SHARE them. But a render with a DIFFERENT keyframe
// config must NOT adopt another config's keyframe. The keyframe provenance sidecar gates listProjectKeyframes
// (the R2-presence reclaim source) the same way the clip sidecar gates reclaimClipsFromR2.

import { describe, it, expect } from "vitest";
import { listProjectKeyframes, stampKeyframeProvenance } from "../src/film-orchestrator.js";
import type { FilmJob, FilmScene } from "../src/film-model.js";
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
  it("never adopts another job's job-scoped keyframe, even with a matching sidecar (cf#1059)", async () => {
    const { env, seed } = memR2();
    await stamp(seed, "renders/proj/keyframes/other-job/shot_01.png", { quality_tier: "final" });
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_A);
    expect(kfs).toEqual([]);
  });

  it("does NOT adopt a keyframe a different-keyframe-config render wrote", async () => {
    const { env, seed } = memR2();
    await stamp(seed, KF, { quality_tier: "draft" });
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, { quality_tier: "final" }, BUNDLE_A);
    expect(kfs.length).toBe(0); // mismatch -> regenerate, never adopt the draft keyframe for a final render
  });

  it("adopts THIS film's own job-scoped still, and prefers it to a flat one (cf#1059)", async () => {
    const { env, seed } = memR2();
    const own = "renders/proj/keyframes/kf-1/shot_01.png";
    seed("renders/proj/keyframes/kf-2/shot_01.png");
    seed(own);
    seed(KF);
    const kfs = await listProjectKeyframes(env, "proj", SCENES, NOW, undefined, BUNDLE_A, ["kf-1"]);
    expect(kfs).toEqual([{ shot_id: "shot_01", keyframe_key: own }]);
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

describe("provenance is stamped only on a still drawn this run", () => {
  const job = { keyframe_config: { quality_tier: "final" }, bundle_key: BUNDLE_A } as unknown as FilmJob;

  function recording() {
    const puts: string[] = [];
    const env = { R2_RENDERS: { put: async (k: string) => { puts.push(k); } } } as unknown as Env;
    return { env, puts };
  }

  it("stamps a still with no reused flag, so a module that always draws is unchanged", async () => {
    const { env, puts } = recording();
    await stampKeyframeProvenance(env, job, { project: "proj", keyframes: [{ shot_id: "shot_01", keyframe_key: KF }] });
    expect(puts).toEqual([provKey(KF)]);
  });

  it("leaves a reused still's sidecar alone, and still stamps the drawn one beside it", async () => {
    const { env, puts } = recording();
    const drawn = "renders/proj/keyframes/shot_02.png";
    await stampKeyframeProvenance(env, job, {
      project: "proj",
      keyframes: [{ shot_id: "shot_01", keyframe_key: KF, reused: true }, { shot_id: "shot_02", keyframe_key: drawn }],
    });
    expect(puts).toEqual([provKey(drawn)]);
  });
});

describe("lost-poll adoption against the key shape a real worker wrote", () => {
  // Measured 2026-10-30 on image 1.1.2: RunPod's /run returned these ids, the keyframe module stores
  // that id unchanged, and the handler wrote these keys. The -uN suffix is on both sides.
  const OWN_JOB = "eb68fae9-1801-42b2-9933-b98a79aaaf5a-u2";
  const SIBLING = "d8d893fa-68ef-406f-8d63-99cc8a90d037-u2";
  const P = "renders/fs1030-trial/keyframes";

  function bucket() {
    const { env, seed } = memR2();
    seed(`${P}/${OWN_JOB}/shot_01.png`);
    seed(`${P}/${SIBLING}/shot_01.png`);
    seed(`${P}/shot_01.latest.json`);
    seed(`${P}/shot_01.png`, { uploaded: NOW - 1_000 });
    seed(`${P}/shot_01.hash`, { uploaded: NOW - 1_000 });
    return env;
  }

  it("adopts this film's still when the stored id carries the suffix", async () => {
    const kfs = await listProjectKeyframes(bucket(), "fs1030-trial", SCENES, NOW, undefined, BUNDLE_A, [OWN_JOB]);
    expect(kfs).toEqual([{ shot_id: "shot_01", keyframe_key: `${P}/${OWN_JOB}/shot_01.png` }]);
  });

  it("adopts nothing when the stored id lost the suffix, so a mismatch is a failure and not a wrong film", async () => {
    const kfs = await listProjectKeyframes(bucket(), "fs1030-trial", SCENES, NOW, undefined, BUNDLE_A, [OWN_JOB.replace(/-u\d+$/, "")]);
    expect(kfs).toEqual([]);
  });
});
