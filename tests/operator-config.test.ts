import { describe, it, expect } from "vitest";
import {
  installSubschema,
  hasInstallConfig,
  installFieldKeys,
  droppedInstallKeys,
  clampInstallPatch,
  clampInstallPatchDetailed,
} from "../src/operator-config.js";
import type { ConfigSchema } from "../src/modules/types.js";

// A schema with one install-scope field and one render-scope field -- the exact mix the store must
// separate (notify_email is install; quality_tier-style knobs are render).
const MIXED: ConfigSchema = {
  notify_email: { type: "string", default: "", label: "recipient", scope: "install" },
  quality_tier: { type: "enum", values: ["draft", "final"], default: "draft" }, // scope omitted => render
  retries: { type: "int", default: 1, min: 0, max: 5, scope: "render" },
};

describe("installSubschema", () => {
  it("keeps ONLY scope:install fields (render + scope-omitted are excluded)", () => {
    const sub = installSubschema(MIXED);
    expect(Object.keys(sub)).toEqual(["notify_email"]);
  });
  it("is empty for an undefined schema or an all-render schema", () => {
    expect(installSubschema(undefined)).toEqual({});
    expect(installSubschema({ a: { type: "bool", default: false } })).toEqual({});
  });
});

describe("hasInstallConfig / installFieldKeys", () => {
  it("reports install presence + keys", () => {
    expect(hasInstallConfig(MIXED)).toBe(true);
    expect(hasInstallConfig(undefined)).toBe(false);
    expect(hasInstallConfig({ a: { type: "bool", default: false } })).toBe(false);
    expect(installFieldKeys(MIXED)).toEqual(["notify_email"]);
  });
});

describe("clampInstallPatch (the write clamp = store->invoke round-trip)", () => {
  it("round-trips an install field through the contract", () => {
    const out = clampInstallPatch(MIXED, {}, { notify_email: "ops@example.org" });
    expect(out).toEqual({ notify_email: "ops@example.org" });
  });

  it("REJECTS a render-scope key (not writable via the install store)", () => {
    const out = clampInstallPatch(MIXED, {}, { quality_tier: "final", retries: 9 });
    // Pure clamp still drops; host PATCH routes should 400 via droppedInstallKeys before write.
    expect(out).toEqual({ notify_email: "" });
    expect(out).not.toHaveProperty("quality_tier");
    expect(out).not.toHaveProperty("retries");
  });

  it("drops unknown keys and clamps the install field's type", () => {
    const out = clampInstallPatch(MIXED, {}, { notify_email: 12345, bogus: "x" });
    // a non-string notify_email falls back to its schema default ("") via validateConfig
    expect(out).toEqual({ notify_email: "" });
  });

  it("merges a patch over current stored values", () => {
    const current = { notify_email: "old@example.org" };
    const out = clampInstallPatch(MIXED, current, {}); // empty patch keeps current
    expect(out).toEqual({ notify_email: "old@example.org" });
    const out2 = clampInstallPatch(MIXED, current, { notify_email: "new@example.org" });
    expect(out2).toEqual({ notify_email: "new@example.org" });
  });

  it("an all-render / no-install schema yields {} (the store is a clean no-op)", () => {
    const renderOnly: ConfigSchema = { quality_tier: { type: "enum", values: ["a", "b"], default: "a" } };
    expect(clampInstallPatch(renderOnly, {}, { quality_tier: "b" })).toEqual({});
  });
});

describe("droppedInstallKeys / clampInstallPatchDetailed (strict operator PATCH)", () => {
  it("reports nothing when every key is install-scope (or the patch is empty)", () => {
    expect(droppedInstallKeys(MIXED, { notify_email: "ops@example.org" })).toEqual([]);
    expect(droppedInstallKeys(MIXED, {})).toEqual([]);
    expect(droppedInstallKeys(MIXED, undefined)).toEqual([]);
    const { next, dropped } = clampInstallPatchDetailed(MIXED, {}, { notify_email: "ops@example.org" });
    expect(dropped).toEqual([]);
    expect(next).toEqual({ notify_email: "ops@example.org" });
  });

  it("names unknown AND render-scope keys (the silent-discard bug, cf#387)", () => {
    // Nested body shape operators often guess: { config: { notify_email: "..." } } drops `config`.
    expect(droppedInstallKeys(MIXED, { config: { notify_email: "x@y.z" } })).toEqual(["config"]);
    expect(droppedInstallKeys(MIXED, { quality_tier: "final", retries: 9, bogus: "x" })).toEqual([
      "quality_tier",
      "retries",
      "bogus",
    ]);
    const { next, dropped } = clampInstallPatchDetailed(
      MIXED,
      { notify_email: "old@example.org" },
      { config: { notify_email: "new@example.org" }, quality_tier: "final" },
    );
    // next is unchanged (patch had no install keys); dropped lists what the clamp discarded.
    expect(next).toEqual({ notify_email: "old@example.org" });
    expect(dropped).toEqual(["config", "quality_tier"]);
  });

  it("a mixed patch: valid install key applied, invalid keys still listed in dropped", () => {
    const { next, dropped } = clampInstallPatchDetailed(
      MIXED,
      {},
      { notify_email: "ops@example.org", bogus: 1 },
    );
    expect(next).toEqual({ notify_email: "ops@example.org" });
    expect(dropped).toEqual(["bogus"]);
  });

  it("an all-render schema reports every patch key as dropped", () => {
    const renderOnly: ConfigSchema = { quality_tier: { type: "enum", values: ["a", "b"], default: "a" } };
    expect(droppedInstallKeys(renderOnly, { quality_tier: "b" })).toEqual(["quality_tier"]);
    const { next, dropped } = clampInstallPatchDetailed(renderOnly, {}, { quality_tier: "b" });
    expect(next).toEqual({});
    expect(dropped).toEqual(["quality_tier"]);
  });
});
