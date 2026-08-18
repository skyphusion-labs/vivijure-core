// cf#312 / core#154: attachFinishPresigns EMITTED-KEY-SET guard.
//
// WHY THIS FILE EXISTS. The suite that shipped with this feature (finish-presign-312.test.ts) asserts
// only speechEnhancedAudioKey, a pure string helper, and drives NOTHING in the presign transport. It
// is symbol-existence red against the parent commit: it fails 4/4 with
// "TypeError: speechEnhancedAudioKey is not a function", which is a claim about the symbol and not
// about the transport. Measured: deleting the lipsync audio_url presign outright, and corrupting the
// hash sidecar key to a wrong constant, BOTH leave that suite unchanged at 48 passed / 1 failed.
//
// So this file drives attachFinishPresigns itself against a stub presigner -- the SAME function the
// orchestrator calls, at its one real injected seam (env.PRESIGNER) -- and asserts the set of keys
// actually handed to the presigner, plus the exact fields left on the input. A key set is the only
// observation that distinguishes a correct transport from a plausible one.

import { describe, expect, it } from "vitest";
import { attachFinishPresigns, attachSpeechPresigns } from "../src/film-orchestrator.js";
import type { FilmJob, FinishShot } from "../src/film-model.js";
import type { FinishInput, SpeechInput } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const PROJECT = "neon";
const CLIP = "renders/neon/clips/shot_01.mp4";
const AUDIO = "renders/neon/dialogue/shot_01.wav";
// Legacy UPSCALE convention (finishStepOutputKey: no finish_artifacts decl -> `_up` before the ext).
const OUT = "renders/neon/clips/shot_01_up.mp4";

const JOB = { film_id: "f1", project: PROJECT } as unknown as FilmJob;

function shot(): FinishShot {
  return {
    shot_id: "shot_01",
    clip_key: CLIP,
    chain: ["MODULE_FINISH_UPSCALE"],
    idx: 0,
    status: "pending",
    applied: [],
  };
}

/** A presigner that RECORDS every key it is asked for, and refuses the ones `refuse` names. Recording
 *  is the point: `refuse` lets a test reproduce a mid-presign failure without inventing a fake env. */
function stubEnv(refuse: (key: string) => boolean = () => false) {
  const gets: string[] = [];
  const puts: string[] = [];
  const env = {
    PRESIGNER: {
      presignGet: async (k: string) => {
        gets.push(k);
        if (refuse(k)) throw new Error(`presign refused GET ${k}`);
        return `https://get.invalid/${k}`;
      },
      presignPut: async (k: string) => {
        puts.push(k);
        if (refuse(k)) throw new Error(`presign refused PUT ${k}`);
        return `https://put.invalid/${k}`;
      },
    },
  } as unknown as Env;
  return { env, gets, puts };
}

function lipsyncInput(): FinishInput {
  return { shot_id: "shot_01", clip_key: CLIP, audio_key: AUDIO, output_hash: "a".repeat(64) };
}

describe("attachFinishPresigns emitted key set (cf#312)", () => {
  it("presigns the hash sidecar at `<output_key>.hash`, the key the #583 adoption gate reads", async () => {
    const { env, gets, puts } = stubEnv();
    const input = lipsyncInput();
    await attachFinishPresigns(env, JOB, shot(), input, []);

    // CONTROL, co-located with the claim and read first: the stub is reached at all, so a key-set
    // assertion below is a statement about the transport rather than about an inert recorder.
    expect({ gets: gets.length, puts: puts.length }).toEqual({ gets: 2, puts: 2 });

    // THE CLAIM. Derived from the emitted output_key, never transcribed, so the two cannot drift:
    // finishArtifactHashMatches reads `${artifactKey}.hash` and upscale/musetalk write
    // f"{output_key}.hash". A `<output_key minus .mp4>.hash` is the .srt/.meta.json convention and is
    // the wrong one here -- it makes every presigned step permanently unadoptable (#166 recovery and
    // the final-artifact adoption both refuse), silently re-running paid GPU work.
    expect(input.output_key).toBe(OUT);
    expect(puts).toEqual([OUT, `${input.output_key}.hash`]);
    expect(gets).toEqual([CLIP, AUDIO]);
    // Own-iron finish (RIFE, video upscale) reads R2 by clip_key. Hosted does not
    // run lipsync. Keep the keys; URLs stay additive.
    expect(input.clip_key).toBe(CLIP);
    expect(input.audio_key).toBe(AUDIO);
  });

  it("keeps clip_key after a complete presign so own-iron RIFE can run", async () => {
    const { env } = stubEnv();
    const input = lipsyncInput();
    await attachFinishPresigns(env, JOB, shot(), input, []);

    expect(input.video_url).toBe(`https://get.invalid/${CLIP}`);
    expect(input.output_url).toBe(`https://put.invalid/${OUT}`);
    expect(input.audio_url).toBe(`https://get.invalid/${AUDIO}`);
    expect(input.clip_key).toBe(CLIP);
    expect(input.audio_key).toBe(AUDIO);
  });

  it("applies presigned transport ALL-OR-NOTHING: a refusal on any leg leaves the input key-only", async () => {
    // musetalk's presigned branch REQUIRES audio_url and returns a top-level `error` without it, which
    // is a hard job failure -- so a partial application (video_url + output_url set, audio_url absent)
    // is strictly worse than not presigning at all, and the finish.presign_skip log line calls it a
    // skip when it was a partial application. Its sibling attachSpeechPresigns already does this
    // correctly with Promise.all; this pins the same posture here.
    const { env, gets, puts } = stubEnv((k) => k === AUDIO);
    const input = lipsyncInput();
    await attachFinishPresigns(env, JOB, shot(), input, []);

    // CONTROL first: the refusal path was actually exercised. True under both the sequential and the
    // Promise.all shapes, so it discriminates a reached refusal from a test that never got there.
    expect(gets).toContain(AUDIO);

    // CLAIM 1, the harm itself: nothing is assigned. A sequential shape leaves video_url + output_url
    // + output_key set with audio_url absent, which is the body musetalk hard-fails on.
    expect({
      video_url: input.video_url,
      output_url: input.output_url,
      output_key: input.output_key,
      audio_url: input.audio_url,
      hash_url: input.hash_url,
    }).toEqual({
      video_url: undefined,
      output_url: undefined,
      output_key: undefined,
      audio_url: undefined,
      hash_url: undefined,
    });
    // CLAIM 2, the mechanism: every leg is STARTED before anything is assigned (the Promise.all
    // posture), which is what makes claim 1 hold for a refusal on ANY leg and not just this one.
    // Under the sequential shape puts is [OUT] only.
    expect({ gets: gets.length, puts: puts.length }).toEqual({ gets: 2, puts: 2 });
    // And the key-only fallback is intact, so the satellite takes its R2 branch.
    expect(input.clip_key).toBe(CLIP);
    expect(input.audio_key).toBe(AUDIO);
  });

  it("emits only the legs the input calls for (silent shot, no provenance hash)", async () => {
    // Discriminates "always emits four" from "emits what this step needs": no audio_key => no
    // audio_url leg, no output_hash => no hash_url leg. Without this row the two rules above pass
    // identically under an implementation that presigns everything unconditionally.
    const { env, gets, puts } = stubEnv();
    const input: FinishInput = { shot_id: "shot_01", clip_key: CLIP };
    await attachFinishPresigns(env, JOB, shot(), input, []);

    expect(gets).toEqual([CLIP]);
    expect(puts).toEqual([OUT]);
    expect(input.audio_url).toBeUndefined();
    expect(input.hash_url).toBeUndefined();
    expect(input.video_url).toBe(`https://get.invalid/${CLIP}`);
    expect(input.output_url).toBe(`https://put.invalid/${OUT}`);
    expect(input.clip_key).toBe(CLIP);
  });

  it("presigns nothing when the step's output key is unmodelled", async () => {
    // finishStepOutputKey returns null for a convention the core does not model (text-overlay), and an
    // unmodelled step must get NO presigned transport rather than a guessed key. Negative control for
    // the three rows above: it proves the stub can report ZERO, so their non-zero counts discriminate.
    const { env, gets, puts } = stubEnv();
    const fs = shot();
    fs.chain = ["MODULE_FINISH_TEXT_OVERLAY"];
    const input = lipsyncInput();
    await attachFinishPresigns(env, JOB, fs, input, []);

    expect({ gets: gets.length, puts: puts.length }).toEqual({ gets: 0, puts: 0 });
    expect(input.output_key).toBeUndefined();
    expect(input.clip_key).toBe(CLIP);
    expect(input.audio_key).toBe(AUDIO);
  });
});

describe("attachSpeechPresigns emitted key set (cf#312 / core#191)", () => {
  it("omits audio_key after a complete presign so audio-upscale takes the credentialless branch", async () => {
    const { env, gets, puts } = stubEnv();
    const input: SpeechInput = { shot_id: "shot_01", audio_key: AUDIO };
    await attachSpeechPresigns(env, input);

    expect(gets).toEqual([AUDIO]);
    expect(puts).toEqual(["renders/neon/dialogue/shot_01_enh.wav"]);
    expect(input.audio_url).toBe(`https://get.invalid/${AUDIO}`);
    expect(input.output_url).toBe("https://put.invalid/renders/neon/dialogue/shot_01_enh.wav");
    expect("audio_key" in input).toBe(false);
  });

  it("keeps audio_key when a speech presign leg refuses (R2 fallback)", async () => {
    const { env } = stubEnv((k) => k === AUDIO);
    const input: SpeechInput = { shot_id: "shot_01", audio_key: AUDIO };
    await attachSpeechPresigns(env, input);

    expect(input.audio_url).toBeUndefined();
    expect(input.output_url).toBeUndefined();
    expect(input.audio_key).toBe(AUDIO);
  });
});
