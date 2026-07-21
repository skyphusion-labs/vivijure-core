import { describe, expect, it, vi } from "vitest";
import { updateRenderFromView } from "../src/renders-db.js";
import type { Env } from "../src/platform/orchestrator-context.js";

describe("updateRenderFromView output_key backfill (#99)", () => {
  it("adopts deterministic film.mp4 key on COMPLETED when envelope omitted output_key", async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...binds: unknown[]) {
              return {
                async run() {
                  runs.push({ sql, binds });
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
      R2_RENDERS: {
        async head(key: string) {
          return key === "renders/film-abc/film.mp4" ? { key } : null;
        },
      },
    } as unknown as Env;

    await updateRenderFromView(env, {
      jobId: "film-abc",
      status: "COMPLETED",
      statusRaw: "done",
      output: { mode: "full", project: "demo", output_key: null },
    });

    expect(runs.length).toBeGreaterThan(0);
    const update = runs.find((r) => r.sql.includes("UPDATE renders SET"));
    expect(update).toBeTruthy();
    expect(update!.binds[1]).toBe("renders/film-abc/film.mp4");
  });

  it("does not invent output_key when the assembled film is absent from store", async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...binds: unknown[]) {
              return {
                async run() {
                  runs.push({ sql, binds });
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
      R2_RENDERS: {
        head: vi.fn(async () => null),
      },
    } as unknown as Env;

    await updateRenderFromView(env, {
      jobId: "film-missing",
      status: "COMPLETED",
      statusRaw: "done",
      output: { mode: "full", project: "demo" },
    });

    const update = runs.find((r) => r.sql.includes("UPDATE renders SET"));
    expect(update!.binds[1]).toBeNull();
  });
});
