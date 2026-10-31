import { describe, expect, it } from "vitest";
import { invokeModule } from "../src/modules/registry.js";

// vivijure-cf#1141: a detailed image answered "module /invoke body rejected: response exceeded 1048576
// bytes" after the provider was paid. The cap is per hook, and a module is still untrusted (F5).

const MB = 1024 * 1024;
function fetcherOf(bytes: number) {
  return {
    fetch: async () => new Response(JSON.stringify({ ok: true, output: { pad: "x".repeat(bytes) } })),
  };
}
const call = (hook: string, bytes: number) =>
  invokeModule(fetcherOf(bytes) as never, { hook, input: {} } as never);

describe("the module response cap", () => {
  it("lets a 5 MB image through on image.generate", async () => {
    expect((await call("image.generate", 5 * MB)).ok).toBe(true);
  });
  it("still bounds image.generate", async () => {
    const r = await call("image.generate", 33 * MB);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("response exceeded 33554432 bytes");
  });
  it("keeps 1 MB on every other hook", async () => {
    const r = await call("motion.backend", 2 * MB);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("response exceeded 1048576 bytes");
  });
  it("CONTROL: a small response passes on any hook", async () => {
    expect((await call("motion.backend", 1000)).ok).toBe(true);
  });
});
