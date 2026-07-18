// The image.generate hook contract (cf#129 phase 2).
//
// Two things are pinned here. First the conformance checker, because a module that returns a
// well-formed ENVELOPE with a junk payload is the failure this harness exists to catch. Second the
// forward-compatibility behaviour that decided this is a MINOR release and not a contract-epoch
// bump: an older core meeting a manifest that names a hook it has never heard of must fail HONESTLY
// and say which hook, rather than accepting it silently.

import { describe, it, expect, vi } from "vitest";
import {
  HOOK_NAMES,
  HOOK_CARDINALITY,
  HOOK_BLURBS,
  MODULE_API,
} from "../src/modules/types.js";
import { checkHookOutput } from "../src/modules/conformance.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { discoverModules, _resetModuleDiscoveryCache } from "../src/modules/registry.js";

describe("image.generate is a first-class hook", () => {
  it("is registered with pick_one cardinality and a blurb", () => {
    expect(HOOK_NAMES).toContain("image.generate");
    expect(HOOK_CARDINALITY["image.generate"]).toBe("pick_one");
    expect(HOOK_BLURBS["image.generate"]).toBeTruthy();
  });
});

describe("image.generate output conformance", () => {
  const ok = { image: { bytes_b64: "aGVsbG8=", mime: "image/png" } };

  it("accepts a well-formed inline image", () => {
    expect(checkHookOutput("image.generate", ok).pass).toBe(true);
  });

  // Each of these is a shape a real module could plausibly return. The checker exists so they fail
  // at the seam instead of becoming a stored object that only looks wrong to a human eye.
  it.each([
    ["missing image object", {}],
    ["image is not an object", { image: "aGVsbG8=" }],
    ["missing bytes", { image: { mime: "image/png" } }],
    ["empty bytes", { image: { bytes_b64: "", mime: "image/png" } }],
    ["missing mime", { image: { bytes_b64: "aGVsbG8=" } }],
    ["empty mime", { image: { bytes_b64: "aGVsbG8=", mime: "" } }],
  ])("rejects: %s", (_label, payload) => {
    // Assert pass===false, NOT merely truthy: checkHookOutput returns a ConformanceCheck OBJECT in
    // both directions, so a truthiness assertion here would pass even when the checker ACCEPTED the
    // payload. My first draft made exactly that mistake and every rejection case went green.
    const check = checkHookOutput("image.generate", payload as Record<string, unknown>);
    expect(check.pass).toBe(false);
    expect(check.detail).toBeTruthy();
  });

  // Positive control for the rejection block above: proves pass===false actually discriminates,
  // rather than every call happening to return a falsy pass.
  it("control: the checker reports pass===true for the good payload it just rejected variants of", () => {
    expect(checkHookOutput("image.generate", ok).pass).toBe(true);
    expect(checkHookOutput("image.generate", {}).pass).toBe(false);
  });

  // A data: URL decodes to garbage rather than an image. It is the single most likely thing for a
  // module author to hand back, because it is what the chat image path passes around internally.
  it("rejects a data: URL masquerading as base64", () => {
    const check = checkHookOutput("image.generate", {
      image: { bytes_b64: "data:image/png;base64,aGVsbG8=", mime: "image/png" },
    });
    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/raw base64/);
  });
});

// ---------------------------------------------------------------- forward compatibility
//
// This is the evidence behind "additive, no MODULE_API epoch bump". The risk direction is NOT an
// old manifest against a new core (trivially fine); it is a self-host running core N-1 that
// installs a NEW module serving image.generate. That must degrade honestly.
describe("older core meeting an unknown hook (the epoch-bump question)", () => {
  const futureHookManifest = {
    name: "acme-imagegen",
    version: "1.0.0",
    api: MODULE_API,
    hooks: ["definitely.not.a.real.hook"],
    provides: [{ id: "img", label: "ACME Image" }],
  };

  it("rejects the manifest and NAMES the unknown hook", () => {
    const r = validateManifest(futureHookManifest);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("definitely.not.a.real.hook");
  });

  it("drops the module at discovery and warns loudly, naming it", async () => {
    _resetModuleDiscoveryCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = {
      fetch: async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === "/module.json"
          ? new Response(JSON.stringify(futureHookManifest), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("{}", { status: 404 }),
    };
    const mods = await discoverModules({ MODULE_ACME: binding } as unknown as Record<string, unknown>);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(mods).toEqual([]);
    // Silence would be the epoch-bump trigger: a module that vanishes with no explanation.
    expect(warnings.some((w) => w.includes("definitely.not.a.real.hook"))).toBe(true);
  });

  // The nuance worth pinning: rejection is ALL-OR-NOTHING per module. A module that serves one known
  // hook AND one unknown hook loses BOTH on an older core. That is honest (it warns) but it is why a
  // new hook should ship as its own module rather than being bolted onto an existing one.
  it("rejects the WHOLE module when only one of its hooks is unknown", async () => {
    _resetModuleDiscoveryCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mixed = { ...futureHookManifest, name: "acme-mixed", hooks: ["plan.enhance", "definitely.not.a.real.hook"] };
    const binding = {
      fetch: async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === "/module.json"
          ? new Response(JSON.stringify(mixed), { status: 200, headers: { "content-type": "application/json" } })
          : new Response("{}", { status: 404 }),
    };
    const mods = await discoverModules({ MODULE_MIXED: binding } as unknown as Record<string, unknown>);
    warn.mockRestore();
    expect(mods).toEqual([]);
  });
});
