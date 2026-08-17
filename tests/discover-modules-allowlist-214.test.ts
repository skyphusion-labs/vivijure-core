// core#214: every `await discoverModules` in src/ is either a request-entry or a
// `?? await discoverModules` fallback. A new bare discover below a request
// boundary fails this test.
//
// Rule: every call site BELOW a request boundary takes a threaded registry.
// Request-entry may discover once, then must thread the result down.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Functions that sit on an HTTP / host request boundary and MAY call
 * discoverModules once. A new name here is a deliberate decision, not a
 * silent addition. Everything else must take `preModules` and only discover
 * when that argument is absent (`preModules ?? await discoverModules`).
 *
 *   startScatterRender  -- scatter submit; threads into startFilmJob
 *   advanceScatterJob   -- scatter poll/gather; threads into shards + finalize
 *   cancelFilmJob       -- user cancel; threads into cancelInFlightKeyframe/Clips
 */
const REQUEST_ENTRY = new Set([
  "startScatterRender",
  "advanceScatterJob",
  "cancelFilmJob",
]);

const DISCOVER = /await\s+discoverModules\b/;
const FALLBACK = /\?\?\s*await\s+discoverModules\b/;
const FN = /^(?:export\s+)?async\s+function\s+(\w+)/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function enclosingFn(lines: string[], idx: number): string | null {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(FN);
    if (m) return m[1];
  }
  return null;
}

describe("discoverModules call sites (core#214)", () => {
  it("bare discovers live only in allowlisted request-entry functions", () => {
    const srcRoot = join(import.meta.dirname, "../src");
    const sites: { file: string; line: number; fn: string | null; text: string }[] = [];
    for (const file of walkTs(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (!DISCOVER.test(text)) return;
        sites.push({ file: file.slice(srcRoot.length + 1), line: i + 1, fn: enclosingFn(lines, i), text: text.trim() });
      });
    }

    // CONTROL: the matcher sees real sites, so an empty list would be a dead instrument.
    expect(sites.length).toBeGreaterThan(0);

    const bare = sites.filter((s) => !FALLBACK.test(s.text));
    const unexpected = bare.filter((s) => !s.fn || !REQUEST_ENTRY.has(s.fn));
    expect(unexpected, `bare discoverModules outside request-entry allowlist:\n${unexpected.map((s) => `  ${s.file}:${s.line} in ${s.fn ?? "?"}`).join("\n")}`).toEqual([]);

    const allowlisted = new Set(bare.map((s) => s.fn));
    for (const name of REQUEST_ENTRY) {
      expect(allowlisted.has(name), `allowlisted request-entry ${name} has no bare discover (update the allowlist)`).toBe(true);
    }
  });
});
