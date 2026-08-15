import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, startFilmJob, startFilmFromKeyframes, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { MODULE_API, type HookSelection } from "../src/modules/types.js";

// cf#537 WIRING. The pure `selectForChain` unit tests prove the POLICY. They cannot prove the policy
// is ON THE PATH, and that distinction is the entire defect: `dispatchChain` -- the function the issue
// body cites -- is never passed `finish` at any of its call sites estate-wide, so a gate added there
// would have tested green and changed nothing. The per-shot finish chain is minted in exactly one
// place: `enterFinishPhase`, from the LIVE registry, reading `job.finish_select`.
//
// So this suite drives `advanceFilmJob` against real module bindings and reads the PERSISTED job doc.
// Modules arrive through `discoverModules` -> `readManifest` -> `validateManifest`, exactly as in
// production, which also means the `participation` field has to survive manifest validation to work
// here at all. There is one un-stubbable seam and this is it.

const FILM = "film-cf537-wiring";
const CLIPS = "clips-cf537-wiring";

const manifest = (name: string, order: number, participation?: "default" | "opt_in") => ({
  name,
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["finish"],
  ui: { order, section: "finish" },
  ...(participation ? { participation } : {}),
});

const BINDING = (name: string) => "MODULE_" + name.toUpperCase().replace(/-/g, "_");

// Same non-default arrangement as the unit suite: opt_in is MID ui.order, one module leaves the field
// absent. A gate that dropped the tail, or ignored the field, would pass on a tidier fixture.
const MANIFESTS = [
  manifest("finish-rife", 10), //             absent  -> legacy default
  manifest("finish-blender", 18, "opt_in"), // the subject
  manifest("finish-upscale", 20, "default"), // explicit default
];

function finishEnv(finish_select?: HookSelection) {
  const job: Partial<FilmJob> & { film_id: string } = {
    film_id: FILM,
    project: "p",
    bundle_key: "bundles/p.tar.gz",
    scenes: [
      { shot_id: "shot_01", prompt: "a", seconds: 4 },
      { shot_id: "shot_02", prompt: "b", seconds: 4 },
    ],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    ...(finish_select ? { finish_select } : {}),
    keyframe_binding: null,
    phase: "clips",
    clip_job_id: CLIPS,
    created_at: 0,
  };
  const clipJob = {
    job_id: CLIPS,
    project: "p",
    shots: [
      { shot_id: "shot_01", status: "done", clip_key: "renders/" + FILM + "/shot_01.mp4" },
      { shot_id: "shot_02", status: "done", clip_key: "renders/" + FILM + "/shot_02.mp4" },
    ],
  };
  const store = new Map<string, string>([
    [filmJobDocKey(FILM), JSON.stringify(job)],
    ["renders/clip-jobs/" + CLIPS + ".json", JSON.stringify(clipJob)],
  ]);
  const jsonResp = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => {
        // Any clip-job key shape: find it by the job id rather than pinning the exact layout, so this
        // harness does not silently stop finding the doc if that key format moves.
        for (const [k, v] of store) if (k === key || (key.includes(CLIPS) && k.includes(CLIPS))) return { text: async () => v };
        return null;
      },
      head: async () => null,
      list: async () => ({ objects: [] }),
      put: async (key: string, val: string) => { store.set(key, val); },
    },
    PRESIGNER: {
      presignGet: async (k: string) => "https://presigned/" + k,
      presignPut: async (k: string) => "https://presigned-put/" + k,
    },
  };
  // Every non-manifest fetch to a module binding is an INVOKE. Recording them lets the suite assert
  // the EFFECT -- "was this module actually called?" -- instead of a phase label. advanceFilmJob runs
  // several phases in one tick, so the phase it ENDS on is a weaker and more fragile observable than
  // whether a door was ever knocked on, and "a module ran that nobody asked for" is the defect.
  const invoked: string[] = [];
  for (const m of MANIFESTS) {
    env[BINDING(m.name)] = {
      fetch: async (url: string) => {
        if (String(url).endsWith("/module.json")) return jsonResp(m);
        invoked.push(m.name);
        // Accept and stay pending: the film parks with finish_shots already built, which is the
        // artifact under test. Nothing here decides the selection.
        return jsonResp({ ok: true, pending: true, poll: "https://module/poll/x" });
      },
    };
  }
  return {
    env: env as unknown as Env,
    read: () => JSON.parse(store.get(filmJobDocKey(FILM)) as string) as FilmJob,
    invoked,
  };
}

/** The module NAMES the persisted chain resolves to, recovered from the bindings it stored. */
function chainNames(doc: FilmJob): string[] {
  const byBinding = new Map(MANIFESTS.map((m) => [BINDING(m.name), m.name]));
  const first = doc.finish_shots?.[0];
  return (first?.chain ?? []).map((b) => byBinding.get(b) ?? "UNKNOWN:" + b);
}

describe("cf#537 wiring: the participation gate is on the path the finish chain is actually minted on", () => {
  it("CONTROL: the harness reaches the finish phase at all and sees all three modules bound", async () => {
    // Run FIRST and deliberately: every assertion below is about a module being ABSENT from a chain,
    // and an absence is worthless until something has been shown PRESENT. If this row fails, nothing
    // beneath it is a finding -- it is a broken harness (a manifest that did not validate, an R2 key
    // that did not match, a clip job that never read complete) wearing a finding's clothes.
    const { env, read } = finishEnv({ mode: "named", modules: ["finish-rife", "finish-blender", "finish-upscale"] });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.finish_shots?.length, "DENOMINATOR: finish shots built from 2 done clips").toBe(2);
    expect(chainNames(doc)).toEqual(["finish-rife", "finish-blender", "finish-upscale"]);
    expect(chainNames(doc).length, `3 of ${MANIFESTS.length} bound finish modules in the chain`).toBe(3);
  });

  it("THE TICKET: with NO selection, finish-blender is not in the minted chain", async () => {
    const { env, read, invoked } = finishEnv();
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.finish_shots?.length, "DENOMINATOR: finish shots").toBe(2);
    expect(chainNames(doc)).toEqual(["finish-rife", "finish-upscale"]);
    expect(chainNames(doc)).not.toContain("finish-blender");
    // Second, INDEPENDENT witness: the door was never knocked on. The persisted chain and the invoke
    // log are different observables, so a defect that produced a correct-looking chain while still
    // dispatching blender would fail here and pass above.
    expect(invoked, "blender must not be invoked").not.toContain("finish-blender");
    // ...and the modules that are NOT opt_in are untouched. This is the half that makes the change
    // safe for every caller that predates it: no flag day, no silent loss of interpolation/upscale.
    expect(chainNames(doc).length, `2 of ${MANIFESTS.length} bound modules participate by default`).toBe(2);
  });

  it("with blender NAMED, it IS in the minted chain, in registry ui.order", async () => {
    const { env, read, invoked } = finishEnv({ mode: "named", modules: ["finish-upscale", "finish-blender"] });
    await advanceFilmJob(env, FILM);
    const doc = read();
    // The caller listed them backwards on purpose: the registry's ui.order decides, not the array.
    expect(chainNames(doc)).toEqual(["finish-blender", "finish-upscale"]);
    // And it really was dispatched -- naming an opt_in module means it RUNS, not merely that it
    // appears in a plan. This is the row that would still pass if the gate refused everything.
    expect(invoked, "blender must be invoked when named").toContain("finish-blender");
  });

  it("an EMPTY named selection runs ZERO finish modules -- no chain, no door knocked on", async () => {
    // NOTE ON THE OBSERVABLE, kept because the first draft of this row got it wrong. enterFinishPhase
    // sets phase "assemble" for an empty chain, but advanceFilmJob then RUNS assemble in the same
    // tick, so the phase the doc ends on is not "assemble". Asserting that label tested the tick
    // boundary rather than the gate. What the gate actually decides is whether any finish module is
    // INVOKED, so that is what this asserts, with the chain and the invoke log as two independent
    // witnesses.
    const { env, read, invoked } = finishEnv({ mode: "named", modules: [] });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.finish_shots, "no finish chain is minted at all").toBeUndefined();
    expect(invoked, `0 of ${MANIFESTS.length} bound finish modules invoked`).toEqual([]);
    expect(doc.phase).not.toBe("finish");
  });

  it("naming a module that is not bound FAILS the job with the name in the error", async () => {
    const { env, read } = finishEnv({ mode: "named", modules: ["finish-upscale", "finish-nonesuch"] });
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/finish-nonesuch/);
    // The diagnostic names the module, not just "a module": an operator reading the render's error
    // surface has to know WHICH one, or the message sends them looking at the wrong door.
    expect(doc.error).not.toMatch(/finish-upscale/);
  });

  it("finish_select ROUND-TRIPS through the persisted job doc", async () => {
    // The mint site re-derives the registry rather than reading the resolved plan, so this field is
    // the only carrier. A selection that lived only in the resolved plan would be discarded silently.
    const sel: HookSelection = { mode: "named", modules: ["finish-blender"] };
    const { env, read } = finishEnv(sel);
    await advanceFilmJob(env, FILM);
    expect(read().finish_select).toEqual(sel);
  });

  it("NEGATIVE CONTROL: no selection -> the field is ABSENT on the doc, not filled in with a default", async () => {
    const { env, read } = finishEnv();
    await advanceFilmJob(env, FILM);
    const doc = read();
    expect(doc.finish_select).toBeUndefined();
    expect("finish_select" in doc).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// MINT-SITE PERSISTENCE.
//
// This block exists because the mutation pass found the suite BLIND to it. Deleting
// `finish_select: args.finish_select` from BOTH start functions left every test above green: the
// harness up there pre-writes a job doc that already carries the field, so it exercises the CONSUMER
// and says nothing about the PRODUCER. A caller who named finish-blender would have had the request
// dropped on the floor at submit, and the film would have reported success without it.
//
// The failure direction is worth naming: dropping the field resolves to the default-participation
// set, so the render still LOOKS fine -- it is simply missing the module someone explicitly asked
// for, which is the cf#500 shape and exactly the kind of absence nothing in the estate would notice.

const DOC = (id: string) => filmJobDocKey(id);

function bareEnv() {
  const store = new Map<string, string>();
  const env = {
    R2_RENDERS: {
      get: async (k: string) => {
        const v = store.get(k);
        return v === undefined ? null : { text: async () => v };
      },
      head: async () => null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as unknown as Env;
  const read = (filmId: string): FilmJob => {
    const raw = store.get(DOC(filmId));
    // Fail loudly rather than defaulting: "no doc persisted" must never read as "a doc with no
    // selection", which is the exact conflation this whole change is about.
    if (raw === undefined) throw new Error("no film job doc persisted at " + DOC(filmId));
    return JSON.parse(raw) as FilmJob;
  };
  return { env, read };
}

const SCENES = [{ shot_id: "shot_01", prompt: "a", seconds: 4 }];
const SEL: HookSelection = { mode: "named", modules: ["finish-blender"] };

describe("cf#537 mint-site persistence: both start functions carry finish_select onto the job doc", () => {
  it("startFilmJob persists the selection it was given", async () => {
    const { env, read } = bareEnv();
    const job = await startFilmJob(env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES, finish_select: SEL,
    }, []);
    expect(read(job.film_id).finish_select).toEqual(SEL);
  });

  it("startFilmFromKeyframes persists the selection it was given", async () => {
    const { env, read } = bareEnv();
    const job = await startFilmFromKeyframes(env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES, keyframes: [],
      derive_mode: "finalized", finish_select: SEL,
    });
    expect(read(job.film_id).finish_select).toEqual(SEL);
  });

  it("NEGATIVE CONTROL: neither invents one -- the key is ABSENT, not an empty object", async () => {
    // The control for both rows above. Without it a probe that could only ever observe `undefined`
    // would pass here and would have passed identically against code that never wrote the field.
    const a = bareEnv();
    const j1 = await startFilmJob(a.env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES,
    }, []);
    const d1 = a.read(j1.film_id);
    expect(d1.finish_select).toBeUndefined();
    expect("finish_select" in d1).toBe(false);

    const b = bareEnv();
    const j2 = await startFilmFromKeyframes(b.env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES, keyframes: [],
      derive_mode: "finalized",
    });
    const d2 = b.read(j2.film_id);
    expect(d2.finish_select).toBeUndefined();
    expect("finish_select" in d2).toBe(false);
  });

  it("CONTROL: the docs really were persisted, so the two absences above are real", async () => {
    // A fixed-answer row. `read` throws when nothing was written, and both absences rest on it, so
    // this proves the harness produces a doc at all rather than an absence produced by an exception
    // nobody saw. If this fails, every row in this block is a harness fault, not a finding.
    const { env, read } = bareEnv();
    const job = await startFilmJob(env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES,
    }, []);
    const doc = read(job.film_id);
    expect(doc.film_id).toBe(job.film_id);
    expect(doc.scenes.length, "DENOMINATOR: scenes on the persisted doc").toBe(1);
  });
});
