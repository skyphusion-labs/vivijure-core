// A namespace can hold several studios' module scripts. A host that sets TENANT_MODULE_PREFIX (the plane
// that provisions it does) dispatches only to installed_modules rows whose script is under it. This is
// the core side of the studio's install check (vivijure-cf): a row written before that check existed,
// or by any other path, still never reaches another studio's script. Unset: every row, as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDispatchModules } from "../src/modules/registry.js";
import { MODULE_API } from "../src/modules/types.js";

afterEach(() => vi.restoreAllMocks());

const row = (name: string, script_name: string) => ({
  name,
  script_name,
  api: MODULE_API,
  manifest_json: JSON.stringify({ name, version: "1.0.0", api: MODULE_API, hooks: ["plan.enhance"] }),
});
const ROWS = [row("own", "ten-aaaa-own"), row("other", "ten-bbbb-other"), row("bare", "plain-script")];

function env(prefix?: string): Record<string, unknown> {
  return {
    MODULE_DISPATCH: { get: () => ({ fetch: async () => new Response("{}") }) },
    DB: { prepare: () => ({ all: async () => ({ results: ROWS }) }) },
    ...(prefix === undefined ? {} : { TENANT_MODULE_PREFIX: prefix }),
  };
}

describe("dispatch discovery honours the studio's own module prefix", () => {
  it("with a prefix, only rows under it are dispatched, and each skip is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mods = await discoverDispatchModules(env("ten-aaaa-") as never);
    expect(mods.map((m) => m.name)).toEqual(["own"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it("CONTROL: with no prefix every row is dispatched, as before", async () => {
    expect((await discoverDispatchModules(env() as never)).map((m) => m.name)).toEqual(["own", "other", "bare"]);
  });
  it("an empty prefix is treated as unset", async () => {
    expect((await discoverDispatchModules(env("  ") as never))).toHaveLength(3);
  });
});
