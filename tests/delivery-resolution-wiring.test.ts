/// <reference types="node" />
// cf#507b WIRING: the delivery target must actually REACH the film.finish module.
//
// The resolver is unit-tested in delivery-resolution.test.ts. This file asserts the thing that
// makes the defect go away: that every seed the core emits CARRIES a target, so the panel modules'
// `width: input.width ?? 1920` arm becomes unreachable instead of silently load-bearing.
//
// Both probes are 1280x536, deliberately NOT 1920x1080. If the core stopped populating the field
// and the module fell back to its default, a test written against 1920 would still pass -- which is
// exactly how the original defect survived. Asserting a non-default value is the only form of this
// test that can fail.

import { describe, expect, it } from "vitest";
import { runFilmFinish } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";
import { DEFAULT_DELIVERY_WIDTH, DEFAULT_DELIVERY_HEIGHT } from "../src/film-model.js";

const FILM = "renders/p1/film.mp4";

const MOD: RegisteredModule = {
  name: "film-titles",
  version: "0.1.0",
  api: "vivijure-module/1",
  hooks: ["film.finish"],
  ui: { section: "finish", order: 10 },
  binding: "MODULE_FILM_TITLES",
} as unknown as RegisteredModule;

/** Captures the seed the core dispatches, so the assertion is on what went ON THE WIRE rather than
 *  on what the code looks like it would send. */
function envCapturing(seen: Record<string, unknown>[]) {
  return {
    R2_RENDERS: {
      head: async () => null,          // nothing pre-exists -> the step DISPATCHES rather than adopts
      get: async () => null,
      put: async () => undefined,
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://g/${k}`,
      presignPut: async (k: string) => `https://p/${k}`,
    },
    MODULE_FILM_TITLES: {
      fetch: async (_u: unknown, init: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { input?: Record<string, unknown> };
        if (body.input) seen.push(body.input);
        return new Response(JSON.stringify({ ok: true, output: { film_key: FILM, applied: [] } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as Env;
}

const base = { film_key: FILM, scenes: [], bundle_key: "bundles/p1.tar.gz", project: "p1", job_id: "j1" };

describe("cf507b wiring: the film.finish seed carries the delivery target", () => {
  it("a DECIDED target reaches the module verbatim", async () => {
    const seen: Record<string, unknown>[] = [];
    await runFilmFinish(envCapturing(seen), { ...base, delivery_width: 1280, delivery_height: 536 }, [MOD]);

    expect(seen.length).toBeGreaterThan(0);          // denominator: a zero here is a dead harness
    expect(seen[0].width).toBe(1280);
    expect(seen[0].height).toBe(536);
  });

  it("a film with NO target still carries one EXPLICITLY, so the module default is unreachable", async () => {
    // The load-bearing case. Today the core sends nothing and the module decides by falling back.
    // After this change the core always decides, even when it decides the default -- so the `??`
    // arm in film-titles/subtitle can never be what picks the resolution again.
    const seen: Record<string, unknown>[] = [];
    await runFilmFinish(envCapturing(seen), base, [MOD]);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].width).toBe(DEFAULT_DELIVERY_WIDTH);
    expect(seen[0].height).toBe(DEFAULT_DELIVERY_HEIGHT);
    // Present, not absent. `undefined` here would mean the module is still doing the deciding.
    expect(seen[0].width).toBeDefined();
    expect(seen[0].height).toBeDefined();
  });

  it("CONTROL: the capture DOES see a differing value, so the assertions above discriminate", async () => {
    const seen: Record<string, unknown>[] = [];
    await runFilmFinish(envCapturing(seen), { ...base, delivery_width: 1001, delivery_height: 337 }, [MOD]);
    expect(seen[0].width).toBe(1001);
    expect(seen[0].width).not.toBe(DEFAULT_DELIVERY_WIDTH);
  });
});
