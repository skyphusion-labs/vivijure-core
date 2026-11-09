import { describe, expect, it } from "vitest";
import { normalizeProjectName } from "../src/storyboard-validate.js";

// vivijure-backend#487 contract: the render key of a board is core's normalizeProjectName(title). It is
// the SOURCE OF TRUTH: it builds bundles/<key>-<hex>.tar.gz, the studio remaps a render's project to
// <key>, and the backend writes renders/<key>/ and loras/<key>/. The backend then applies its own
// keys._slug to that key. The two must never disagree, so this pins:
//
//  1. core's rule, by a golden table (a change to it re-keys every stored artifact: change it on purpose);
//  2. the backend's rule, by the backend's own golden, copied below with its source sha;
//  3. backend _slug(core key) === core key, over the golden table and a fixed pseudo-random corpus.

// Core's rule. Each row is input -> key.
const CORE_GOLDEN: Array<[string, string]> = [
  ["Hero Film", "Hero_Film"],
  ["Hero_Film", "Hero_Film"],
  ["Hero/Film", "Hero_Film"],
  ["  Hero  Film ", "Hero_Film"],
  ["Neon  City", "Neon_City"],
  ["Two O'Clock Proof (43 shots)", "Two_O_Clock_Proof__43_shots_"],
  ["smoke-v1.28.0 post-deploy", "smoke-v1.28.0_post-deploy"],
  ["a..b", "a_b"],
  ["../etc/passwd", "etc_passwd"],
  ["x://y", "x___y"],
  ["._-lead", "lead"],
  ["café", "caf_"],
  ["", "project"],
  ["   ", "project"],
  ["...", "project"],
];

// The backend golden, copied from skyphusion-labs/vivijure-backend tests/fixtures/i2v_clip_contract.json
// ("slug_rule", "slug_examples") at 1d34ecead5800ae63767dd1774c81d9cc1d8852e. The backend pins it in
// tests/test_i2v_clip_conformance.py::test_slug_rule_matches_golden. A copy forks at copy time: if the
// backend changes its rule, update this copy and its sha in the same change.
const BACKEND_SLUG_RULE =
  "strip surrounding whitespace; collapse any internal whitespace run to a single '_'; replace '/' with '_'; an empty result becomes 'untitled'";
const BACKEND_GOLDEN: Record<string, string> = {
  "Neon  City": "Neon_City",
  "shot 01": "shot_01",
  "My  Film/x": "My_Film_x",
  "  ": "untitled",
  "": "untitled",
};

/** The backend's keys._slug, transcribed from BACKEND_SLUG_RULE and checked against BACKEND_GOLDEN below. */
function backendSlug(s: string): string {
  const out = s.trim().replace(/\s+/g, "_").replace(/\//g, "_");
  return out.length > 0 ? out : "untitled";
}

// Deterministic corpus: an LCG over an alphabet of the characters both rules treat specially.
const ALPHABET = ["a", "Z", "0", " ", "  ", "\t", "\n", "/", ".", "..", "-", "_", "'", "(", ")", ":", "é", "\u00a0", "\u3000", "*"];
function corpus(n: number, seed = 487): string[] {
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) % 2 ** 31);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = next() % 12;
    for (let j = 0; j < len; j++) s += ALPHABET[next() % ALPHABET.length];
    out.push(s);
  }
  return out;
}

describe("project key contract (vivijure-backend#487)", () => {
  it.each(CORE_GOLDEN)("core keys %j as %j", (input, key) => {
    expect(normalizeProjectName(input)).toBe(key);
  });

  it("the transcribed backend rule matches the backend golden", () => {
    expect(BACKEND_SLUG_RULE).toContain("'untitled'");
    for (const [input, want] of Object.entries(BACKEND_GOLDEN)) expect(backendSlug(input)).toBe(want);
  });

  it("the backend returns every core key unchanged (golden + 5000-string corpus)", () => {
    const inputs = [...CORE_GOLDEN.map(([i]) => i), ...Object.keys(BACKEND_GOLDEN), ...corpus(5000)];
    const keys = inputs.map(normalizeProjectName);
    expect(new Set(keys).size).toBeGreaterThan(100); // a real denominator, not 5000 copies of "project"
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(backendSlug(k)).toBe(k);
    }
  });

  it("control: the identity check can fail (a raw title the backend would key differently)", () => {
    expect(backendSlug("Two O'Clock (cut)")).not.toBe(normalizeProjectName("Two O'Clock (cut)"));
    expect(backendSlug(" padded ")).not.toBe(" padded ");
  });
});
