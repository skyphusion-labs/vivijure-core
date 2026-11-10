import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// fleet-chezmoi#2083 done condition: no rest.runpod.io in src/. RunPod REST v1 retires 2026-11-15
// and its successor is https://api.runpod.io/v2. This is a guard over shipped source, so it is the
// CI check that keeps the grep empty; the behaviour is pinned in runpod-endpoint-reconcile.test.ts.
// Comments count too: a comment naming the retired host is how a reader is sent back to it.
//
// HOW IT MATCHES. Each file is split into host-shaped tokens and a token is compared to the
// retired host by EQUALITY (or as a subdomain of it), never by substring. A substring test on a
// hostname is the js/incomplete-url-substring-sanitization shape CodeQL flags, and the same
// unanchored-matcher defect tests/runpod-proxy-route.test.ts documents. The positive controls
// below prove each written form still turns this red.
//
// Not in scope and NOT matched: https://api.runpod.ai/v2/<id>/run|status|cancel|health, the
// serverless invoke API (.ai, a different product, no retirement notice).

const SRC = resolve(__dirname, "../src");
const RETIRED_HOST = "rest.runpod.io";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs|json)$/.test(name)) out.push(p);
  }
  return out;
}

/** True when the text names the retired host (or a subdomain of it) as a token. */
export function namesRetiredHost(text: string): boolean {
  for (const raw of text.split(/[^A-Za-z0-9.-]+/)) {
    const tok = raw.replace(/^[.-]+|[.-]+$/g, "").toLowerCase();
    if (tok === RETIRED_HOST || tok.endsWith("." + RETIRED_HOST)) return true;
  }
  return false;
}

describe("namesRetiredHost (the matcher must be able to FAIL)", () => {
  it("POSITIVE controls: every form the host is written in", () => {
    expect(namesRetiredHost('const B = "https://rest.runpod.io/v1";')).toBe(true);
    expect(namesRetiredHost("// a call to rest.runpod.io (see x)")).toBe(true);
    expect(namesRetiredHost("// ends a sentence at rest.runpod.io.")).toBe(true);
    expect(namesRetiredHost("`rest.runpod.io/v1/endpoints`")).toBe(true);
    expect(namesRetiredHost("https://REST.RunPod.io/v1")).toBe(true);
    expect(namesRetiredHost("https://eu.rest.runpod.io/v1")).toBe(true);
  });
  it("NEGATIVE controls: the v2 hosts and look-alikes", () => {
    expect(namesRetiredHost('const B = "https://api.runpod.io/v2";')).toBe(false);
    expect(namesRetiredHost("https://api.runpod.ai/v2/ep/run")).toBe(false);
    expect(namesRetiredHost("https://rest.runpod.io.example/")).toBe(false);
    expect(namesRetiredHost("restXrunpodXio")).toBe(false);
  });
});

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
      .filter((f) => namesRetiredHost(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
