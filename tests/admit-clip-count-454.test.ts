// vivijure-core#454 (vivijure-cf#1122 stage 2): the container's clip cap is checked by admission, so a
// film over it is refused at submit, before any keyframe or clip is bought.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/bundle-storyboard.js", async (original) => ({
  ...(await original<typeof import("../src/bundle-storyboard.js")>()),
  readBundleStoryboardYaml: async () => "use_characters: []\n",
}));

import { admitAssemble, ASSEMBLE_MAX_CLIPS, type AssembleSecondsBasis } from "../src/assemble-admission.js";
import { startFilmJob } from "../src/film-orchestrator.js";
import { STORYBOARD_MAX_SCENES, STORYBOARD_MAX_SECONDS } from "../src/storyboard-validate.js";
import { PLANNER_ASK_MAX_SCENES } from "../src/planner-prompt.js";

const basis = (seconds: number): AssembleSecondsBasis => ({ seconds, measured: 0, planned: 1, unknown: 0 });

describe("admitAssemble counts clips (vivijure-core#454)", () => {
  it("refuses one clip over the cap with a count reason, even when the bytes fit", () => {
    const a = admitAssemble({ clipCount: ASSEMBLE_MAX_CLIPS + 1, width: 1280, height: 720, basis: basis(60) });
    expect(a.admitted).toBe(false);
    expect(a.reason).toContain(`${ASSEMBLE_MAX_CLIPS + 1} clips, and one assemble takes at most ${ASSEMBLE_MAX_CLIPS}`);
    expect(a.reason).not.toMatch(/Its size is also over/);
  });
  it("CONTROL: admits exactly the cap when the bytes fit", () => {
    expect(admitAssemble({ clipCount: ASSEMBLE_MAX_CLIPS, width: 1280, height: 720, basis: basis(60) }).admitted).toBe(true);
  });
  it("names both when both are over", () => {
    const a = admitAssemble({ clipCount: ASSEMBLE_MAX_CLIPS + 1, width: 1920, height: 1080, fps: 48, basis: basis(2700) });
    expect(a.admitted).toBe(false);
    expect(a.reason).toContain(`${ASSEMBLE_MAX_CLIPS + 1} clips`);
    expect(a.reason).toMatch(/Its size is also over: assemble refused/);
  });
  it("CONTROL: a size refusal under the cap carries no count reason", () => {
    const a = admitAssemble({ clipCount: 10, width: 1920, height: 1080, fps: 48, basis: basis(2700) });
    expect(a.admitted).toBe(false);
    expect(a.reason).not.toMatch(/one assemble takes at most/);
  });
});

describe("a film over the clip cap is refused at submit (vivijure-core#454)", () => {
  function harness() {
    const invokes: string[][] = [];
    const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    const manifest = {
      name: "keyframe", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_KEYFRAME",
      hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 10 }, cancelable: true,
    };
    const env = {
      KEYFRAME_PARALLEL: "4",
      MODULE_KEYFRAME: {
        fetch: async (url: string, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (String(url).endsWith("/module.json")) return json(manifest);
          if (String(url).endsWith("/invoke")) {
            invokes.push(body.input?.shot_ids ?? []);
            return json({ ok: true, pending: true, poll: `p${invokes.length}`, jobId: `j${invokes.length}` });
          }
          return new Response("no", { status: 404 });
        },
      },
      R2_RENDERS: {
        async put() {},
        async get() { return null; },
        async list() { return { objects: [], truncated: false }; },
      },
    };
    return { env: env as never, invokes };
  }
  const scenes = (n: number) =>
    Array.from({ length: n }, (_u, i) => ({ shot_id: `shot_${String(i + 1).padStart(3, "0")}`, prompt: `p${i}`, seconds: 2 }));
  const start = (env: never, n: number, over: Record<string, unknown> = {}) =>
    startFilmJob(env, { project: "film", bundle_key: "bundles/film.tar.gz", scenes: scenes(n), delivery_width: 1280, delivery_height: 720, ...over } as never);

  it("one shot over the cap: failed at start, no keyframe job bought", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const job = await start(h.env, ASSEMBLE_MAX_CLIPS + 1);
    expect(job.phase).toBe("failed");
    expect(job.error).toContain(`${ASSEMBLE_MAX_CLIPS + 1} clips, and one assemble takes at most ${ASSEMBLE_MAX_CLIPS}`);
    expect(h.invokes).toHaveLength(0);
  });
  it("CONTROL: exactly the cap starts its keyframes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const job = await start(h.env, ASSEMBLE_MAX_CLIPS);
    expect(job.phase).toBe("keyframe");
    expect(h.invokes.length).toBeGreaterThan(0);
  });
  it("CONTROL: a keyframes-only film over the cap is not priced, because it never assembles", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const job = await start(h.env, ASSEMBLE_MAX_CLIPS + 1, { keyframes_only: true });
    expect(job.phase).toBe("keyframe");
  });
});

describe("the feature-length caps (vivijure-core#455)", () => {
  it("a board the validator takes is a film assemble takes: the two caps are one number", () => {
    expect(ASSEMBLE_MAX_CLIPS).toBe(STORYBOARD_MAX_SCENES);
  });
  it("is 600 shots, 60 minutes stated, and the planner still asks for 50 in one turn", () => {
    expect(STORYBOARD_MAX_SCENES).toBe(600);
    expect(STORYBOARD_MAX_SECONDS).toBe(3600);
    expect(PLANNER_ASK_MAX_SCENES).toBe(50);
  });
});
