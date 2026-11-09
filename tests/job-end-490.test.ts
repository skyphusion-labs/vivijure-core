// core#490: a finished job reports its true runtime, however late it is first polled.
//
// Two halves. (1) A source scan: every terminal write in src/ goes through endJob / cancelJob in
// src/job-end.ts, so every terminal site stamps `ended_at`. The measurement on vivijure-core#490
// found 51 film sites and 15 scatter sites; 22 film sites did not end on the old phase stamp.
// The scan fails on a site that writes a terminal phase, or a cancel, any other way. Its planted
// controls prove each forbidden shape is seen, and the denominator proves it read the real files.
// (2) Behaviour: the poll views report `ended_at - created_at` for a finished job, including the
// out-of-tick writers the measurement named (cancel and the advance catch path).

import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cancelJob, endJob, jobElapsedMs } from "../src/job-end.js";
import { filmJobToPollView } from "../src/film-render-bridge.js";
import { advanceFilmJob, cancelFilmJob, filmJobDocKey } from "../src/film-orchestrator.js";
import { cancelScatterJob, scatterJobToPollView } from "../src/scatter-orchestrator.js";
import * as registry from "../src/modules/registry.js";
import type { FilmJob } from "../src/film-model.js";
import type { ScatterJob } from "../src/scatter-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SRC = join(import.meta.dirname, "..", "src");
const HELPER = "job-end.ts";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every line of `text` that writes a terminal phase or a cancel without the helper. Comment lines
 *  are skipped. Forms: `.phase = <expr naming "done" or "failed">` (a ternary included), an object
 *  literal `phase: "done"` / `phase: "failed"`, `.cancelled = true`, and `cancelled: true`. */
export function terminalBypasses(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    const assigns = [...line.matchAll(/\.phase\s*=(?!=)([^;]*)/g)];
    if (assigns.some((m) => /"(done|failed)"/.test(m[1]))) hits.push(line);
    else if (/\bphase\s*:\s*"(done|failed)"\s*(,|}|$)/.test(line)) hits.push(line);
    else if (/\.cancelled\s*=(?!=)\s*true\b/.test(line) || /\bcancelled\s*:\s*true\b/.test(line)) hits.push(line);
  }
  return hits;
}

describe("every terminal write goes through endJob / cancelJob (core#490)", () => {
  it("no file in src/ writes a terminal phase or a cancel any other way", () => {
    const files = tsFiles(SRC).filter((p) => !p.endsWith(`/${HELPER}`));
    expect(files.length).toBeGreaterThan(50); // the denominator: the scan read the tree
    const found: string[] = [];
    for (const p of files) {
      for (const hit of terminalBypasses(readFileSync(p, "utf8"))) found.push(`${relative(SRC, p)}: ${hit}`);
    }
    expect(found).toEqual([]);
  });

  it("the orchestrators reach their terminal sites through the helper (the measured sites)", () => {
    const count = (f: string, re: RegExp) => (readFileSync(join(SRC, f), "utf8").match(re) ?? []).length;
    // 51 film sites on vivijure-core#490: 49 endJob, the cancel, and the start placeholder (stamped
    // once when built, and again by each early return that keeps it).
    expect(count("film-orchestrator.ts", /\bendJob\(job, "(done|failed)"/g)).toBeGreaterThanOrEqual(50);
    expect(count("film-orchestrator.ts", /\bcancelJob\(job\)/g)).toBe(1);
    expect(count("scatter-orchestrator.ts", /\bendJob\(job, "(done|failed)"/g)).toBeGreaterThanOrEqual(14);
    expect(count("scatter-orchestrator.ts", /\bcancelJob\(job\)/g)).toBe(1);
  });

  it("control: each bypass shape is seen, and the helper call is not", () => {
    const planted = [
      `job.phase = "failed";`,
      `  job.phase = "done";`,
      `job.phase = job.clips_only ? "done" : "assemble";`,
      `job.phase = x ? "clips" : "failed";`,
      `if (!r.ok) { job.phase = "failed"; job.error = r.error; }`,
      `    phase: "failed",`,
      `const j = { phase: "done" }`,
      `job.cancelled = true;`,
      `const j = { cancelled: true, phase: "keyframe" };`,
    ];
    for (const p of planted) expect(terminalBypasses(p), p).toEqual([p.trim()]);
    const clean = [
      `endJob(job, "failed");`,
      `if (job.clips_only) endJob(job, "done"); else job.phase = "assemble";`,
      `if (job.phase === "done" || job.phase === "failed") return job;`,
      `job.phase = "clips";`,
      `phase: "keyframe" | "done" | "failed";`,
      `// job.phase = "failed" in a comment`,
      `if (job.cancelled === true) return;`,
      `cancelJob(job);`,
    ];
    for (const c of clean) expect(terminalBypasses(c), c).toEqual([]);
  });
});

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function film(over: Partial<FilmJob> = {}): FilmJob {
  return { film_id: "film-490", project: "p", bundle_key: "b", scenes: [], phase: "clips", created_at: T0, ...over } as unknown as FilmJob;
}
function scatter(over: Partial<ScatterJob> = {}): ScatterJob {
  return {
    scatter_id: "scatter-490", project: "p", bundle_key: "b", quality_tier: "draft",
    expected_shot_ids: [], shard_film_ids: [], shard_shots: [], phase: "gather", created_at: T0, ...over,
  } as ScatterJob;
}

describe("endJob / cancelJob / jobElapsedMs", () => {
  it("endJob sets the phase and the stamp", () => {
    const j = film();
    endJob(j, "done", T0 + 5 * MIN);
    expect(j).toMatchObject({ phase: "done", ended_at: T0 + 5 * MIN });
  });

  it("cancelJob fails the job, flags it cancelled, and stamps it", () => {
    const j = film();
    cancelJob(j, T0 + 2 * MIN);
    expect(j).toMatchObject({ phase: "failed", cancelled: true, ended_at: T0 + 2 * MIN });
  });

  it("a job that ends again is stamped again (the latest terminal write)", () => {
    const j = film();
    endJob(j, "failed", T0 + MIN);
    j.phase = "clips"; // the keyframes-reuse placeholder leaves failed when its clip job starts
    endJob(j, "done", T0 + 9 * MIN);
    expect(jobElapsedMs(j, T0 + DAY)).toBe(9 * MIN);
  });

  it("a running job reports now - created_at, whatever ended_at holds", () => {
    const j = film({ ended_at: T0 + MIN }); // a stale stamp on a running finish retry
    expect(jobElapsedMs(j, T0 + 7 * MIN)).toBe(7 * MIN);
  });

  it("a terminal doc from before core#490 keeps the old figure", () => {
    const j = film({ phase: "done" });
    expect(jobElapsedMs(j, T0 + 3 * MIN)).toBe(3 * MIN);
  });
});

describe("the poll views report a finished job's true runtime (core#490)", () => {
  it("a film first polled 5 days after it finished reports how long it ran", () => {
    const j = film();
    endJob(j, "done", T0 + 12 * MIN);
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 5 * DAY);
    expect(filmJobToPollView(j, null).executionTimeMs).toBe(12 * MIN);
  });

  it("control: the same film with no stamp reports the poll time, which is the drift", () => {
    const j = film({ phase: "done" });
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 5 * DAY);
    expect(filmJobToPollView(j, null).executionTimeMs).toBe(5 * DAY);
  });

  it("a failed and a cancelled film report their end too", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY);
    const f = film();
    endJob(f, "failed", T0 + 4 * MIN);
    expect(filmJobToPollView(f, null)).toMatchObject({ status: "FAILED", executionTimeMs: 4 * MIN });
    const c = film();
    cancelJob(c, T0 + 3 * MIN);
    expect(filmJobToPollView(c, null)).toMatchObject({ status: "CANCELLED", executionTimeMs: 3 * MIN });
  });

  it("a running film still reports now - created_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 6 * MIN);
    expect(filmJobToPollView(film(), null).executionTimeMs).toBe(6 * MIN);
  });

  it("a scatter job gets the same treatment", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 2 * DAY);
    const done = scatter();
    endJob(done, "done", T0 + 20 * MIN);
    expect(scatterJobToPollView(done).executionTimeMs).toBe(20 * MIN);
    const failed = scatter();
    endJob(failed, "failed", T0 + 8 * MIN);
    expect(scatterJobToPollView(failed)).toMatchObject({ status: "FAILED", executionTimeMs: 8 * MIN });
    expect(scatterJobToPollView(scatter()).executionTimeMs).toBe(2 * DAY);
  });
});

/** R2 and a D1 that grants every lease and accepts every write. */
function store(docs: Record<string, unknown>) {
  const stored: Record<string, string> = {};
  for (const [k, v] of Object.entries(docs)) stored[k] = JSON.stringify(v);
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    },
    R2_RENDERS: {
      head: async (k: string) => (k in stored ? { size: 1 } : null),
      get: async (k: string) => (k in stored ? { text: async () => stored[k] } : null),
      put: async (k: string, b: string) => { stored[k] = b; },
      delete: async (k: string) => { delete stored[k]; },
      list: async () => ({ objects: [] }),
    },
  } as unknown as Env;
  return { env, read: <T>(k: string) => JSON.parse(stored[k]) as T };
}

describe("the out-of-tick writers stamp the end (the sites the old phase stamp missed)", () => {
  it("a cancelled film reports when it was cancelled, not when its last phase began", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(registry, "discoverModules").mockResolvedValue([]);
    const key = filmJobDocKey("film-490");
    const { env, read } = store({ [key]: film({ phase_started_at: T0 }) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 48_000); // film-b741ee8: cancelled 48 s in, its doc read 0 s
    await cancelFilmJob(env, "film-490", { sleep: async () => {} });
    const doc = read<FilmJob>(key);
    expect(doc).toMatchObject({ cancelled: true, phase: "failed", ended_at: T0 + 48_000 });
    vi.setSystemTime(T0 + DAY);
    expect(filmJobToPollView(doc, null).executionTimeMs).toBe(48_000);
  });

  it("a film failed by the advance catch path reports when it failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(registry, "discoverModules").mockRejectedValueOnce(new Error("internal error"));
    const key = filmJobDocKey("film-490");
    const { env, read } = store({ [key]: film({ phase: "keyframe", phase_started_at: T0 }) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 1_428_000); // film-8a5d078: ran 1428 s, its doc read 0 s
    const r = await advanceFilmJob(env, "film-490");
    expect(r?.job.error).toMatch(/advance failed: internal error/);
    const doc = read<FilmJob>(key);
    expect(doc).toMatchObject({ phase: "failed", ended_at: T0 + 1_428_000 });
    vi.setSystemTime(T0 + DAY);
    expect(filmJobToPollView(doc, null).executionTimeMs).toBe(1_428_000);
  });

  it("a cancelled scatter job reports when it was cancelled", async () => {
    const key = "renders/scatter-490/scatter-job.json";
    const { env, read } = store({ [key]: scatter() });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 90_000);
    await cancelScatterJob(env, "scatter-490");
    const doc = read<ScatterJob>(key);
    expect(doc).toMatchObject({ cancelled: true, phase: "failed", ended_at: T0 + 90_000 });
    vi.setSystemTime(T0 + DAY); // read a day later, as a late poll does
    expect(scatterJobToPollView(doc)).toMatchObject({ status: "CANCELLED", executionTimeMs: 90_000 });
  });
});
