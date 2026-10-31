import { describe, expect, it } from "vitest";
import { archiveExistingClipTakes, clipsToArchive, MAX_CLIP_TAKES, takesToPrune, type ClipShot } from "../src/render-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// core#395. Measured 2026-10-30 on `break-1030-silent`: 28 takes, 210 MB of 349 MB under clips/, with two 45 MB
// copies of an `_up` clip. Every render copied every live clip for the shot, and nothing pruned.

const dir = "renders/p/clips/";
const k = (name: string) => dir + name;

function bucket(names: string[]) {
  const store = new Set(names.map(k));
  const ops = { puts: [] as string[], deletes: [] as string[] };
  const env = { R2_RENDERS: {
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...store].filter((x) => x.startsWith(prefix)).sort().map((key) => ({ key })) }),
    get: async (key: string) => (store.has(key) ? { body: "bytes" } : null),
    put: async (key: string) => { store.add(key); ops.puts.push(key); },
    delete: async (key: string) => { store.delete(key); ops.deletes.push(key); },
  } } as unknown as Env;
  return { env, store, ops };
}
const shot = (over: Partial<ClipShot> = {}) => ({ shot_id: "s1", motion_backend: "cf-hailuo", ...over }) as ClipShot;

describe("what a render copies", () => {
  const live = ["s1_cf-hailuo.mp4", "s1_cf-kling-v4.mp4", "s1_cf-hailuo_up.mp4", "s1_finished.mp4", "s1_cf-hailuo_bl.mp4", "s1_cf-hailuo.mp4.prov", "s1_cf-hailuo_take5.mp4"].map(k);

  it("only the clip its own door is about to replace", () => {
    expect(clipsToArchive(live, shot())).toEqual([k("s1_cf-hailuo.mp4")]);
  });
  it("a door with a differently named file still has its clip protected", () => {
    expect(clipsToArchive(live, shot({ motion_backend: "minimax-hailuo" }))).toEqual([k("s1_cf-hailuo.mp4"), k("s1_cf-kling-v4.mp4")]);
  });
  it("never a finish output, a sidecar or a take", () => {
    expect(clipsToArchive(live, shot({ motion_backend: undefined }))).toEqual([k("s1_cf-hailuo.mp4"), k("s1_cf-kling-v4.mp4")]);
  });
  it("does not mistake a door whose name starts the same", () => {
    expect(clipsToArchive([k("s1_cf-hailuo-pro.mp4"), k("s1_cf-hailuo.mp4")], shot())).toEqual([k("s1_cf-hailuo.mp4")]);
  });
});

describe("what is kept", () => {
  it("the newest takes of each clip, whatever order they come in", () => {
    const keys = [3, 1, 5, 2, 4].map((n) => k(`s1_a_take${n}.mp4`)).concat(k("s1_b_take1.mp4"));
    expect(takesToPrune(keys, 3).sort()).toEqual([k("s1_a_take1.mp4"), k("s1_a_take2.mp4")]);
  });
  it("numbers, not text: 10 is newer than 9", () => {
    expect(takesToPrune([k("s1_a_take9.mp4"), k("s1_a_take10.mp4")], 1)).toEqual([k("s1_a_take9.mp4")]);
  });
  it("no copy of a finish output, which older renders made", () => {
    expect(takesToPrune([k("s1_cf-hailuo_up_take1.mp4"), k("s1_finished_take2.mp4")]).sort()).toEqual([k("s1_cf-hailuo_up_take1.mp4"), k("s1_finished_take2.mp4")]);
  });
  it("a live clip is never a take", () => {
    expect(takesToPrune([k("s1_a.mp4"), k("s1_a.mp4.prov")], 0)).toEqual([]);
  });
});

describe("archiveExistingClipTakes", () => {
  it("the measured case: one copy of the clip, the 45 MB copies go, and the live clips stay", async () => {
    const { env, store, ops } = bucket(["s1_cf-hailuo.mp4", "s1_cf-kling-v4.mp4", "s1_cf-hailuo_up.mp4", "s1_cf-hailuo_up_take1.mp4", "s1_cf-hailuo_up_take2.mp4"]);
    const s = shot();
    await archiveExistingClipTakes(env, "p", s);
    expect(ops.puts).toHaveLength(1);
    expect(ops.puts[0]).toMatch(/s1_cf-hailuo_take\d+\.mp4$/);
    expect(ops.deletes.sort()).toEqual([k("s1_cf-hailuo_up_take1.mp4"), k("s1_cf-hailuo_up_take2.mp4")]);
    for (const live of ["s1_cf-hailuo.mp4", "s1_cf-kling-v4.mp4", "s1_cf-hailuo_up.mp4"]) expect(store.has(k(live))).toBe(true);
    expect(s.takes).toHaveLength(1);
  });

  it("many renders hold the takes at the cap", async () => {
    const old = Array.from({ length: 10 }, (_, i) => `s1_cf-hailuo_take${1000 + i}.mp4`);
    const { env, store } = bucket(["s1_cf-hailuo.mp4", ...old]);
    await archiveExistingClipTakes(env, "p", shot());
    expect([...store].filter((x) => /_take\d+/.test(x))).toHaveLength(MAX_CLIP_TAKES);
    expect(store.has(k("s1_cf-hailuo_take1009.mp4"))).toBe(true);
    expect(store.has(k("s1_cf-hailuo_take1000.mp4"))).toBe(false);
  });

  it("another shot is not touched, and s1 does not match s10", async () => {
    const { env, ops } = bucket(["s10_cf-hailuo.mp4", "s10_cf-hailuo_up_take1.mp4", "s1_cf-hailuo.mp4"]);
    await archiveExistingClipTakes(env, "p", shot());
    expect(ops.puts).toHaveLength(1);
    expect(ops.puts[0]).toContain("/s1_cf-hailuo_take");
    expect(ops.deletes).toEqual([]);
  });

  it("reads every page, so a large listing cannot hide the door's clip", async () => {
    const puts: string[] = [];
    const env = { R2_RENDERS: {
      list: async ({ cursor }: { cursor?: string }) => cursor
        ? { objects: [{ key: k("s1_cf-hailuo.mp4") }], truncated: false }
        : { objects: [{ key: k("s1_a.mp4") }], truncated: true, cursor: "next" },
      get: async () => ({ body: "b" }),
      put: async (key: string) => { puts.push(key); },
      delete: async () => {},
    } } as unknown as Env;
    await archiveExistingClipTakes(env, "p", shot());
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain("s1_cf-hailuo_take");
  });
});
