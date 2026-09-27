import { describe, it, expect, vi, afterEach } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { MODULE_API } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#834: the POST-CLIPS dialogue leg answered all six of its failure branches with a
// console.warn and a silent finish, while the pre-clip leg answers the same six with
// incompleteFilmError. Which leg a film takes is decided by its motion door declaring
// driving_audio, and 13 of the 15 installed doors (seedance, the hosted speed default, among them)
// take this one.
//
// NOTHING IN THE SUITE DROVE THIS LEG. Measured before writing it:
//   grep -rln "MODULE_DIALOGUE" tests/   -> tests/pre-clip-dialogue.test.ts only
//   grep -rn "driving_audio" tests/      -> that same file, and BOTH of its usage fixtures set
//                                           driving_audio: true, so every one of its cases takes
//                                           the PRE-CLIP branch.
// So there was no reachable world in which this leg's guard went red, because there was no guard
// and no test. This file is the missing world.
//
// The leg is reached through enterFinishPhase, which requires at least one FINISH module to be
// serving (it returns to "assemble" before the dialogue call when none is). The harness therefore
// binds one, and the first case proves the harness gets there at all.

const FILM = "film-cf834";
const CLIPS = "clips-cf834";
const DIALOGUE_BINDING = "MODULE_DIALOGUE";
const FINISH_BINDING = "MODULE_FINISH_RIFE";

type DialogueBehaviour =
  | { kind: "full" }
  | { kind: "partial" } // audio for shot_01 only
  | { kind: "empty" } // conformance-valid `audio: []`
  | { kind: "garbage" } // fails hookOutputViolation
  | { kind: "submit-fails" }
  | { kind: "pending-then-fail" }
  | { kind: "pending-then-unbound" }
  | { kind: "absent" }; // no dialogue module installed at all

const jsonResp = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const audioFor = (shotIds: string[]) =>
  shotIds.map((shot_id) => ({
    shot_id,
    audio_key: `renders/${FILM}/dialogue/${shot_id}.wav`,
    voice_id: "v1",
    duration_s: 2.5,
  }));

function harness(behaviour: DialogueBehaviour, over: Partial<FilmJob> = {}) {
  const job: Partial<FilmJob> & { film_id: string } = {
    film_id: FILM,
    project: "p",
    bundle_key: "bundles/p.tar.gz",
    scenes: [
      { shot_id: "shot_01", prompt: "a", seconds: 4 },
      { shot_id: "shot_02", prompt: "b", seconds: 4 },
    ],
    dialogue_lines: [
      { shot_id: "shot_01", text: "hello" },
      { shot_id: "shot_02", text: "goodbye" },
    ],
    motion_backend: "seedance", // a door that does NOT declare driving_audio: the 13-of-15 case
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "clips",
    clip_job_id: CLIPS,
    created_at: 0,
    ...over,
  };
  const clipJob = {
    job_id: CLIPS,
    project: "p",
    shots: [
      { shot_id: "shot_01", status: "done", clip_key: `renders/${FILM}/shot_01.mp4` },
      { shot_id: "shot_02", status: "done", clip_key: `renders/${FILM}/shot_02.mp4` },
    ],
  };
  const store = new Map<string, string>([
    [filmJobDocKey(FILM), JSON.stringify(job)],
    [`renders/clip-jobs/${CLIPS}.json`, JSON.stringify(clipJob)],
  ]);

  const dialogueCalls: string[] = [];
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => {
        for (const [k, v] of store) if (k === key || (key.includes(CLIPS) && k.includes(CLIPS))) return { text: async () => v };
        return null;
      },
      head: async () => null,
      list: async () => ({ objects: [] }),
      put: async (key: string, val: string) => { store.set(key, val); },
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
  };

  // One finish module, bound and pending, so enterFinishPhase reaches the dialogue leg and then
  // parks. It is scaffolding, not the subject.
  env[FINISH_BINDING] = {
    fetch: async (url: string) => {
      if (String(url).endsWith("/module.json")) {
        return jsonResp({ name: "finish-rife", version: "1.0.0", api: MODULE_API, hooks: ["finish"], ui: { order: 10, section: "finish" } });
      }
      return jsonResp({ ok: true, pending: true, poll: "https://module/poll/finish" });
    },
  };

  if (behaviour.kind !== "absent") {
    env[DIALOGUE_BINDING] = {
      fetch: async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/module.json")) {
          return jsonResp({ name: "dialogue-tts", version: "1.0.0", api: MODULE_API, hooks: ["dialogue"], ui: { order: 5, section: "audio" } });
        }
        const body = init?.body ? (JSON.parse(String(init.body)) as { poll?: string }) : {};
        const isPoll = typeof body.poll === "string";
        dialogueCalls.push(isPoll ? "poll" : "invoke");
        switch (behaviour.kind) {
          case "full":
            return jsonResp({ ok: true, output: { project: "p", audio: audioFor(["shot_01", "shot_02"]), applied: ["dialogue-tts"] } });
          case "partial":
            return jsonResp({ ok: true, output: { project: "p", audio: audioFor(["shot_01"]), applied: ["dialogue-tts"] } });
          case "empty":
            return jsonResp({ ok: true, output: { project: "p", audio: [], applied: ["dialogue-tts"] } });
          case "garbage":
            return jsonResp({ ok: true, output: { project: "p", applied: ["dialogue-tts"] } }); // no audio[]
          case "submit-fails":
            return jsonResp({ ok: false, error: "tts backend refused" });
          case "pending-then-fail":
            return isPoll
              ? jsonResp({ ok: false, error: "tts job died mid-batch" })
              : jsonResp({ ok: true, pending: true, poll: "https://module/poll/dialogue" });
          case "pending-then-unbound":
            return jsonResp({ ok: true, pending: true, poll: "https://module/poll/dialogue" });
          default:
            return jsonResp({ ok: false, error: "unreachable" });
        }
      },
    };
  }

  return {
    env: env as unknown as Env,
    read: () => JSON.parse(store.get(filmJobDocKey(FILM)) as string) as FilmJob,
    dialogueCalls,
    unbindDialogue: () => { delete env[DIALOGUE_BINDING]; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("cf#834: the post-clips dialogue leg records what happened, and fails what it cannot deliver", () => {
  it("CONTROL: the harness reaches the leg and a healthy batch voices every lined shot", async () => {
    // FIRST and deliberately. Every case below asserts a FAILURE, and a failure assertion is
    // worthless until something has been shown to succeed through the same path.
    const { env, read, dialogueCalls } = harness({ kind: "full" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(dialogueCalls, "DENOMINATOR: the dialogue module was actually invoked").toContain("invoke");
    expect(doc.phase).not.toBe("failed");
    expect(Object.keys(doc.dialogue_audio ?? {}).sort()).toEqual(["shot_01", "shot_02"]);
    expect(doc.dialogue_degraded).toBeUndefined();
  });

  it("an EMPTY audio set fails: `audio: []` is conformance-VALID, so nothing else could see it", async () => {
    const { env, read } = harness({ kind: "empty" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/incomplete film -- dialogue 0\/2/);
    expect(doc.error).toMatch(/shot_01, shot_02/);
  });

  it("a PARTIAL set fails and names the shot that would have shipped mute", async () => {
    const { env, read } = harness({ kind: "partial" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/incomplete film -- dialogue 1\/2/);
    expect(doc.error).toMatch(/shot_02/);
  });

  it("a submit failure fails the film instead of finishing silently", async () => {
    const { env, read } = harness({ kind: "submit-fails" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/tts backend refused/);
  });

  it("a contract violation fails the film instead of finishing silently", async () => {
    const { env, read } = harness({ kind: "garbage" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/audio/);
  });

  it("a poll failure fails the film instead of finishing silently", async () => {
    // One tick covers both halves: advanceFilmJob runs the phase blocks in sequence, so a submit
    // that parks at "dialogue" is polled by the SAME tick. The error text is the witness that this
    // verdict came from the POLL arm, since only the poll response carries it.
    const { env, read, dialogueCalls } = harness({ kind: "pending-then-fail" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(dialogueCalls).toContain("poll");
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/tts job died mid-batch/);
  });

  it("a module that vanishes between submit and poll fails the film", async () => {
    const { env, read, unbindDialogue } = harness({ kind: "pending-then-unbound" });
    await advanceFilmJob(env, FILM);
    expect(read().phase).toBe("dialogue");
    unbindDialogue();
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/no longer bound/);
  });

  it("NO dialogue module installed is the one DEGRADE, and it is declared on the doc and in the log", async () => {
    // The #519 shape: a retry cannot help and the clips still play, so the film ships. What cf#834
    // is about is that it used to ship with NOTHING recorded anywhere.
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    const { env, read } = harness({ kind: "absent" });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).not.toBe("failed");
    expect(doc.dialogue_degraded).toMatch(/no dialogue module installed/);
    const ev = lines.filter((l) => l.includes('"ev":"dialogue.unavailable"'));
    expect(ev.length, "the structured event, greppable in the log").toBe(1);
    expect(ev[0]).toContain('"lines":2');
  });

  it("a lineless establishing shot is not a hole (the pre-clip leg's predicate, same here)", async () => {
    const { env, read } = harness({ kind: "partial" }, {
      dialogue_lines: [
        { shot_id: "shot_01", text: "hello" },
        { shot_id: "shot_02", text: "   " }, // whitespace only: nothing to voice
      ],
    });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase, "1 of 1 LINED shots voiced is complete").not.toBe("failed");
    expect(Object.keys(doc.dialogue_audio ?? {})).toEqual(["shot_01"]);
  });
});
