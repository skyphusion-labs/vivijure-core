// cf#515 defect 2 -- `discoverModules` caches the SERVICE scan and never the DISPATCH set.
// This file is the contract that keeps that seam where it is.
//
// PROVENANCE: the instrument, the fixture and the CONTROL below are joan's, written red-first at
// vivijure-cf `560223aa` as `tests/discovery-cache-default-cf515.test.ts`. Moved here because in cf
// it consumes cf's PINNED `@skyphusion-labs/vivijure-core`, which makes it a PIN-BUMP DETECTOR, NOT
// A CONTRACT TEST: it stays red while the pin is old and turns green on a pin bump rather than on
// the behaviour changing. Beside `scatter-discovery-fanout-cf515.test.ts` (core#197) it tests the
// artifact directly.
//
// RED-FIRST, and it is what established the fact this fix rests on. joan's original asserted
// `secondPoll === 0` against the bare default. Driven against core `6bd84cac` it failed exactly as
// designed:
//     AssertionError: expected 27 to be +0   (tests/discovery-cache-default-cf515.test.ts:93)
// with the CONTROL passing FIRST, so the counter demonstrably could observe a zero second poll and
// the red was about the default rather than a broken instrument.
//
// WHY THE FIX IS A SEAM SPLIT AND NOT A BLANKET DEFAULT. `discoverModules` merges two populations
// with opposite volatility, and a single TTL forces one policy onto both:
//   * SERVICE scan -- N parallel subrequests (32 `MODULE_*` bindings in the shipped cf reference
//     config). Changes only on a STUDIO redeploy, which replaces the isolate and discards the cache
//     anyway. Expensive, structurally safe to cache.
//   * DISPATCH set -- ONE D1 query, mutated at RUNTIME by the operator install / uninstall /
//     enable routes with no redeploy. Cheap, unsafe to cache for any window.
// The expensive half is the safe half, so they were never in tension. Three shipped contracts rest
// on the dispatch half staying fresh, and the split keeps each true BY CONSTRUCTION rather than by
// tolerance -- a blanket TTL would have made a safety control's response time equal to the cache
// window, chosen for a performance reason and living nowhere near the kill switch:
//   installed-modules.ts:69-72   uninstall stops dispatch "on the next request"
//   installed-modules.ts:78-81   `enabled = 0` is the v1 fast-kill for a misbehaving module
//   docs/module-dispatch.md:286  an install is "live on the next request, no core redeploy"
//
// A DEGRADED SCAN IS NEVER CACHED, which is the other half of why a blanket TTL was wrong.
// `readManifest` returns null after MANIFEST_READ_ATTEMPTS transient failures and those nulls are
// filtered, so a scan landing during a module blip is silently SHORT. Measured on this fixture:
// pinning it held a 4-of-5 registry for the whole window while an unpinned one self-healed on the
// next call. Only a COMPLETE scan is stored.
//
// RESIDUAL, named here so nobody rediscovers it: a MODULE worker redeploying its OWN manifest is
// invisible for up to the window. That is a PLANNED OPERATOR ACTION, not an emergency control,
// which is exactly why it is acceptable where a stale dispatch set would not be.
//
// SEAM: readManifest is not injectable, so this counts the thing readManifest actually does --
// one `fetch("https://module/module.json")` per bound MODULE_* binding. That is one level CLOSER
// to the artifact than a stub of readManifest would be, and it cannot be satisfied by a stub.
//
// The counter and its denominator print in the SAME assertions as the claim (N120/N318): if the
// first discovery issues zero fetches the fixture is dead and any "second poll" result would be a
// HARNESS PASS, not a verdict.
import { describe, it, expect, beforeEach } from "vitest";
import {
  discoverModules,
  _resetModuleDiscoveryCache,
} from "../src/modules/registry.js";
import { MODULE_API, type ModuleManifest } from "../src/modules/types.js";


const manifest = (name: string): ModuleManifest => ({
  name,
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
});

/** A MODULE_* service binding that COUNTS every manifest read it serves. */
function countingModule(name: string, counter: { manifestReads: number }) {
  return {
    async fetch(input: Request | string): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) {
        counter.manifestReads++;
        return new Response(JSON.stringify(manifest(name)), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function envWithModules(n: number, counter: { manifestReads: number }) {
  const env: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) env[`MODULE_M${i}`] = countingModule(`m${i}`, counter);
  return env;
}

/** The fan-out width DERIVED from the fixture, never assumed from a catalogue size. A 28th
 *  `MODULE_*` binding in production must not break this test for an unrelated reason. */
function boundCount(env: Record<string, unknown>): number {
  return Object.keys(env).filter((k) => k.startsWith("MODULE_")).length;
}

// Fixture SIZE only (cf#515 quotes ~27 live bindings). Every ASSERTION derives its denominator
// from the fixture via boundCount(), so this number is an input and never a claim about production.
const BOUND_MODULES = 27;

describe("cf#515 defect 2 -- discoverModules cache default", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  // ---------------------------------------------------------------- POSITIVE CONTROL (sibling-green)
  // Run FIRST (N318). This proves the counter CAN observe a zero second poll, so the result below is
  // about the default and not about a broken instrument. If this goes red, nothing under it means
  // anything. UNCHANGED from joan's original.
  it("CONTROL: with an explicit cacheTtlMs, the second poll performs zero manifest reads", async () => {
    const counter = { manifestReads: 0 };
    const env = envWithModules(BOUND_MODULES, counter);

    const bound = boundCount(env); // DERIVED denominator, not a hardcoded catalogue size
    const mods1 = await discoverModules(env, { cacheTtlMs: 60_000, nowMs: 1_000 });
    const firstPoll = counter.manifestReads;
    // DENOMINATOR: the fixture must produce a REAL, POPULATED registry. An empty registry
    // still counts fetches, so without this the suite could pass about a population that
    // production cannot produce (a manifest rejected by validateManifest is skipped).
    expect(mods1.length).toBe(bound);
    // DENOMINATOR, asserted so a dead fixture is a harness failure and never a pass.
    expect(firstPoll).toBe(bound);

    await discoverModules(env, { cacheTtlMs: 60_000, nowMs: 9_000 }); // 8s later: inside the TTL
    const secondPoll = counter.manifestReads - firstPoll;
    expect(secondPoll).toBe(0);
  });

  // ---------------------------------------------------------------- THE CONTRACT
  // The render path calls discoverModules with NO opts, so this drives exactly the shape the render
  // path uses. The SERVICE scan -- the expensive half -- is cached by default: this is the cf#515
  // fan-out saving, and it goes RED if the seam split is reverted.
  it("the DEFAULT path serves the SERVICE scan from cache on the second poll", async () => {
    const counter = { manifestReads: 0 };
    const env = envWithModules(BOUND_MODULES, counter);

    // Poll 1 -- the render path's bare call, exactly as film-orchestrator makes it.
    const bound = boundCount(env); // DERIVED denominator, not a hardcoded catalogue size
    const mods1 = await discoverModules(env, { nowMs: 1_000 });
    const firstPoll = counter.manifestReads;
    expect(mods1.length).toBe(bound);
    expect(firstPoll).toBe(bound);

    // Poll 2 -- 8 seconds later, the panel's next render poll (POLL_BASE_MS = 8000).
    await discoverModules(env, { nowMs: 9_000 });
    const secondPoll = counter.manifestReads - firstPoll;
    expect(secondPoll).toBe(0);
  });

  it("cacheTtlMs: 0 still forces a cold scan", async () => {
    const counter = { manifestReads: 0 };
    const env = envWithModules(BOUND_MODULES, counter);
    const bound = boundCount(env);
    await discoverModules(env, { cacheTtlMs: 0, nowMs: 1_000 });
    const firstPoll = counter.manifestReads;
    expect(firstPoll).toBe(bound);
    await discoverModules(env, { cacheTtlMs: 0, nowMs: 9_000 });
    expect(counter.manifestReads - firstPoll).toBe(bound);
  });

  // ------------------------------------------------- THE HALF THAT MUST NEVER BE CACHED
  // Three shipped contracts rest on this and the split preserves each BY CONSTRUCTION:
  //   installed-modules.ts:69-72  uninstall stops dispatch "on the next request"
  //   installed-modules.ts:78-81  `enabled = 0` is the v1 fast-kill for a misbehaving module
  //   docs/module-dispatch.md:286 an install is "live on the next request, no core redeploy"
  // If the dispatch half is ever folded back under the cache, a safety control's response time
  // silently becomes the cache TTL. This test is what stops that.
  describe("the DISPATCH half is re-read on EVERY call, even at the default", () => {
    function dispatchEnv(rows: () => Record<string, unknown>[], counter: { d1Reads: number }) {
      const env: Record<string, unknown> = {
        MODULE_DISPATCH: { get: () => ({ fetch: async () => new Response("{}") }) },
        DB: {
          prepare() {
            return {
              async all() {
                counter.d1Reads++;
                return { results: rows() };
              },
            };
          },
        },
      };
      return env;
    }
    const row = (name: string) => ({
      name,
      script_name: `motion-${name}`,
      api: MODULE_API,
      manifest_json: JSON.stringify(manifest(name)),
    });

    it("queries D1 on every call at the default TTL", async () => {
      const counter = { d1Reads: 0 };
      const env = dispatchEnv(() => [row("a")], counter);
      await discoverModules(env, { nowMs: 1_000 });
      // DENOMINATOR: the fixture must really be reaching D1, or the delta below proves nothing.
      expect(counter.d1Reads).toBe(1);
      await discoverModules(env, { nowMs: 9_000 }); // inside the service-scan window
      expect(counter.d1Reads).toBe(2);
    });

    it("a runtime install is visible on the very next call (no redeploy, no window)", async () => {
      const counter = { d1Reads: 0 };
      let installed = [row("a")];
      const env = dispatchEnv(() => installed, counter);

      const before = await discoverModules(env, { nowMs: 1_000 });
      expect(before.map((m) => m.name)).toEqual(["a"]);

      installed = [row("a"), row("b")]; // operator POSTs /api/modules/install
      const after = await discoverModules(env, { nowMs: 9_000 });
      expect(after.map((m) => m.name).sort()).toEqual(["a", "b"]);
    });

    it("an uninstall / fast-kill takes effect on the very next call", async () => {
      const counter = { d1Reads: 0 };
      let installed = [row("a"), row("b")];
      const env = dispatchEnv(() => installed, counter);

      const before = await discoverModules(env, { nowMs: 1_000 });
      expect(before.map((m) => m.name).sort()).toEqual(["a", "b"]);

      installed = [row("a")]; // DELETE /api/modules/install/b, or PATCH enabled=0
      const after = await discoverModules(env, { nowMs: 9_000 });
      expect(after.map((m) => m.name)).toEqual(["a"]);
    });
  });

  // ---------------------------------------------------------------- THE REASON, MADE EXECUTABLE
  // Assert the reason, not just the status: this is WHY the default is 0, so a future reader
  // proposing a non-zero default has to delete a failing test rather than win an argument.
  describe("why: a non-zero default would pin a DEGRADED registry", () => {
    /** 503s its first `state.fails` manifest reads, then serves normally. */
    function blippyModule(name: string, state: { fails: number }) {
      return {
        async fetch(input: Request | string): Promise<Response> {
          const url = typeof input === "string" ? input : input.url;
          if (!url.endsWith("/module.json")) return new Response("not found", { status: 404 });
          if (state.fails > 0) {
            state.fails--;
            return new Response("busy", { status: 503 });
          }
          return new Response(JSON.stringify(manifest(name)), { status: 200 });
        },
      };
    }
    function healthyModule(name: string) {
      return {
        async fetch(input: Request | string): Promise<Response> {
          const url = typeof input === "string" ? input : input.url;
          if (!url.endsWith("/module.json")) return new Response("not found", { status: 404 });
          return new Response(JSON.stringify(manifest(name)), { status: 200 });
        },
      };
    }
    /** 4 healthy modules + 1 that blips out its whole retry budget on the first discovery. */
    function envWithOneBlip(state: { fails: number }) {
      const env: Record<string, unknown> = {};
      for (let i = 0; i < 4; i++) env[`MODULE_OK${i}`] = healthyModule(`ok${i}`);
      env.MODULE_BLIP = blippyModule("blip", state);
      return env;
    }
    const BOUND = 5;
    const DEGRADED = 4;

    it("a SHORT scan is never cached, so it self-heals on the very next call", async () => {
      const env = envWithOneBlip({ fails: 3 }); // exhausts MANIFEST_READ_ATTEMPTS
      const poll1 = await discoverModules(env, { nowMs: 1_000 });
      // DENOMINATOR: the blip must really have dropped a module, or this proves nothing.
      expect(poll1.length).toBe(DEGRADED);
      // Inside the service-scan window -- and it must STILL re-scan, because the short scan was
      // deliberately not stored.
      const poll2 = await discoverModules(env, { nowMs: 9_000 });
      expect(poll2.length).toBe(BOUND);
    });

    it("a COMPLETE scan taken after recovery is cached as normal", async () => {
      const env = envWithOneBlip({ fails: 3 });
      await discoverModules(env, { nowMs: 1_000 });            // short, not cached
      const good = await discoverModules(env, { nowMs: 9_000 }); // complete, cached
      expect(good.length).toBe(BOUND);
      const cachedPoll = await discoverModules(env, { nowMs: 17_000 });
      expect(cachedPoll.length).toBe(BOUND);
    });
  });
});
