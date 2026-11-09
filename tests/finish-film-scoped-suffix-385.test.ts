// core#385: a suffix finish step (upscale `_up`, blender `_bl`, lip-sync `_ls`) derives its key from its
// input clip. When that input is a clip every film of the project shares, two films wrote one object, so
// one render could replace the clip another render had recorded. Same class as core#379 for shot_named.
import { describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { finishClipScope, finishStepOutputKey, type FinishShot } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const UP = { name: "finish-upscale", version: "1", api: "vivijure-module/2", hooks: ["finish"], binding: "MODULE_U",
  ui: { section: "finish", order: 2 }, finish_artifacts: { output_key: { kind: "append_suffix", suffix: "_up" }, applied: [] } } as unknown as RegisteredModule;
const RIFE = { name: "finish-rife", version: "1", api: "vivijure-module/2", hooks: ["finish"], binding: "MODULE_R",
  ui: { section: "finish", order: 1 }, finish_artifacts: { output_key: { kind: "shot_named", filename: "_finished.mp4" }, applied: [] } } as unknown as RegisteredModule;

// The input both films share: the project-level motion clip.
const SHARED = "renders/p/clips/s1_own-gpu.mp4";
const shot = (over: Partial<FinishShot> = {}): FinishShot =>
  ({ shot_id: "s1", clip_key: SHARED, chain: ["MODULE_U"], configs: [{}], idx: 0, status: "pending", applied: [], ...over }) as FinishShot;

describe("the key", () => {
  it("a suffix step on a shared input gets a different key per film", () => {
    expect(finishStepOutputKey("p", shot(), [UP], finishClipScope({ film_id: "film-a" }))).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
    expect(finishStepOutputKey("p", shot(), [UP], finishClipScope({ film_id: "film-b" }))).toBe("renders/p/clips/film-b/s1_own-gpu_up.mp4");
  });

  it("a retry gets its own folder", () => {
    expect(finishStepOutputKey("p", shot(), [UP], finishClipScope({ film_id: "film-a", finish_retry_gen: 2 }))).toBe("renders/p/clips/film-a/r2/s1_own-gpu_up.mp4");
  });

  it("a suffix step after a film-scoped step stays in the same folder", () => {
    const after = shot({ clip_key: "renders/p/clips/film-a/s1_finished.mp4" });
    expect(finishStepOutputKey("p", after, [UP], "film-a")).toBe("renders/p/clips/film-a/s1_finished_up.mp4");
  });

  it("a legacy UPSCALE binding with no declaration is scoped too", () => {
    expect(finishStepOutputKey("p", shot({ chain: ["MODULE_UPSCALE"] }), [], "film-a")).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
  });

  it("no scope still gives the key beside the input, which adoption reads as the fallback", () => {
    expect(finishStepOutputKey("p", shot(), [UP])).toBe("renders/p/clips/s1_own-gpu_up.mp4");
  });
});

// Two films, one project, one shared R2 bucket. The upscale module behaves as finish-upscale does on the
// credentialed path: it writes to `input.output_key` and reports that key as its clip.
function twoFilms() {
  const store: Record<string, string> = { [SHARED]: "raw motion clip" };
  for (const id of ["film-a", "film-b"]) {
    store[filmJobDocKey(id)] = JSON.stringify({
      film_id: id, project: "p", phase: "finish", created_at: Date.now() - 1000, phase_started_at: Date.now(),
      scenes: [], bundle_key: "b", finish_shots: [shot()],
    });
  }
  const sent: Record<string, unknown>[] = [];
  const e = {
    R2_RENDERS: {
      head: async (k: string) => (k in store ? { size: 4096, etag: "e" } : null),
      get: async (k: string) => (k in store ? { body: store[k], text: async () => store[k] } : null),
      put: async (k: string, b: string) => { store[k] = b; },
      delete: async (k: string) => { delete store[k]; },
      list: async ({ prefix }: { prefix: string }) => ({ objects: Object.keys(store).filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })), truncated: false }),
    },
    MODULE_U: {
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return Response.json(UP);
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown>; film_id?: string };
        const inp = body.input ?? {};
        sent.push(inp);
        const out = String(inp.output_key ?? "");
        if (!out) return Response.json({ ok: false, error: "no output_key" });
        // Each film's upscale is different content: which film wrote it is the payload.
        store[out] = `upscaled for ${sent.length === 1 ? "film-a" : "film-b"}`;
        return Response.json({ ok: true, output: { shot_id: "s1", clip_key: out, out_fps: 24, frames: 48, applied: ["upscale"] } });
      },
    },
  } as unknown as Env;
  return { e, store, sent };
}

describe("two renders of one project finish the same shot", () => {
  it("neither overwrites the other", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { e, store, sent } = twoFilms();
    const a = (await advanceFilmJob(e, "film-a", [UP]))?.job.finish_shots![0];
    const aKey = a?.clip_key;
    const aBytes = aKey ? store[aKey] : undefined;
    const b = (await advanceFilmJob(e, "film-b", [UP]))?.job.finish_shots![0];

    expect(a?.error).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(sent[0].output_key).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
    expect(sent[1].output_key).toBe("renders/p/clips/film-b/s1_own-gpu_up.mp4");
    expect(a?.status).toBe("done");
    expect(b?.status).toBe("done");
    expect(aKey).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
    expect(b?.clip_key).toBe("renders/p/clips/film-b/s1_own-gpu_up.mp4");
    // Film B finishing after A leaves the clip A recorded exactly as A wrote it.
    expect(aBytes).toBe("upscaled for film-a");
    expect(store[aKey as string]).toBe("upscaled for film-a");
    expect(store[b?.clip_key as string]).toBe("upscaled for film-b");
    // And the shared input is untouched.
    expect(store[SHARED]).toBe("raw motion clip");
    expect(store["renders/p/clips/s1_own-gpu_up.mp4"]).toBeUndefined();
  });

  it("a chain of suffix then shot-named keeps every step in the film folder", () => {
    const fs = shot({ chain: ["MODULE_U", "MODULE_R"] });
    expect(finishStepOutputKey("p", fs, [UP, RIFE], "film-a")).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
    const next = { ...fs, idx: 1, clip_key: "renders/p/clips/film-a/s1_own-gpu_up.mp4" } as FinishShot;
    expect(finishStepOutputKey("p", next, [UP, RIFE], "film-a")).toBe("renders/p/clips/film-a/s1_finished.mp4");
  });
});
