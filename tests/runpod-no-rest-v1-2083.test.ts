import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// fleet-chezmoi#2083 done condition: no rest.runpod.io in src/. RunPod REST v1 retires 2026-11-15
// and its successor is https://api.runpod.io/v2. This is a STRING guard over shipped source, so it
// is the CI check that keeps the grep empty; the behaviour is pinned in
// runpod-endpoint-reconcile.test.ts. Comments count too: a comment naming the retired host is how a
// reader is sent back to it.
//
// Not in scope and NOT matched: https://api.runpod.ai/v2/<id>/run|status|cancel|health, the
// serverless invoke API (.ai, a different product, no retirement notice).

const SRC = resolve(__dirname, "../src");
const RETIRED = "rest.runpod.io";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no RunPod REST v1 host in src/ (fleet-chezmoi#2083)", () => {
  it("the walk sees the source tree (denominator)", () => {
    const files = walk(SRC);
    // A guard that walks an empty or wrong directory passes trivially. The reconcile and submit
    // files are where v1 lived, so their presence proves the walk reached them.
    const rel = files.map((f) => relative(SRC, f));
    expect(rel).toContain("runpod-endpoint-reconcile.ts");
    expect(rel).toContain("runpod-submit.ts");
    expect(files.length).toBeGreaterThan(50);
  });

  it("no file under src/ names rest.runpod.io", () => {
    const hits = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes(RETIRED))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
