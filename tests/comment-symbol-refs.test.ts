import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// core#183: the detector's OWN two-way control, run on every CI run rather than at build time.
//
// The point of this file is not that the script works today. It is that a detector which silently
// stops matching reads as a clean repo, so the failing cases have to be constructible and CI has to
// watch them fail. Every case below drives the shipped script -- not a copy of its logic -- against
// a synthetic tree, so a change to the script that breaks detection reddens here.
//
// The script also runs its own positive/negative control on EVERY invocation and refuses (exit 2)
// when either fails. That covers the production run; this covers whether the refusals work at all.

let work: string;
const SCRIPT = "scripts/comment-symbol-refs.mjs";

/** A fake consumer repo containing exactly the named .py files. */
function consumer(name: string, files: string[]): string {
  const root = join(work, name);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const f of files) writeFileSync(join(root, "src", f), "# fixture\n");
  return root;
}

/** A fake core src/ tree with one .ts file carrying the given comment text. */
function srcWith(comment: string): string {
  const dir = join(work, `src-${Math.abs(hash(comment))}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "thing.ts"), `// ${comment}\nexport const x = 1;\n`);
  return dir;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function exclusions(rows: unknown[]): string {
  const p = join(work, `excl-${Math.abs(hash(JSON.stringify(rows)))}.json`);
  writeFileSync(p, JSON.stringify(rows));
  return p;
}

/** Run the SHIPPED script and return its exit code plus output. */
function run(opts: { src: string; roots: string[]; excl?: string }): { code: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        VIVIJURE_SYMREF_SRC: opts.src,
        VIVIJURE_CONSUMER_ROOTS: opts.roots.join(":"),
        VIVIJURE_SYMREF_EXCLUSIONS: opts.excl ?? join(work, "empty.json"),
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "symref-"));
  writeFileSync(join(work, "empty.json"), "[]");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("core#183 stale-consumer-reference detector: it must be able to FAIL", () => {
  it("CONTROL (negative): a comment naming a file that EXISTS passes", () => {
    const c = consumer("live", ["handler.py", "present_thing.py"]);
    const r = run({ src: srcWith("the pod reads this in present_thing.py"), roots: [c] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no stale consumer references");
  });

  it("CONTROL (positive): a comment naming a file that does NOT exist FAILS", () => {
    const c = consumer("live2", ["handler.py"]);
    const r = run({ src: srcWith("the pod reads this in gone_forever.py"), roots: [c] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("gone_forever.py");
    expect(r.out).toContain("STALE CONSUMER REFERENCES");
  });

  it("REFUSES (exit 2) when no consumer root resolves, rather than reporting clean", () => {
    // The whole reason this exists: a missing checkout must not look like a healthy repo.
    const r = run({ src: srcWith("the pod reads this in gone_forever.py"), roots: ["/nonexistent/path"] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("REFUSED");
    expect(r.out).not.toContain("no stale consumer references");
  });

  it("REFUSES when its own positive control cannot resolve, so a blind index cannot pass", () => {
    // A consumer root with no handler.py: the resolver is reachable but cannot see the thing it is
    // calibrated on, which is indistinguishable from a tree with nothing stale in it.
    const c = consumer("blind", ["something_else.py"]);
    const r = run({ src: srcWith("mentions something_else.py"), roots: [c] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("CONTROL positive");
    expect(r.out).toContain("FAIL");
  });

  it("does NOT flag a filename that only appears inside a string literal", () => {
    // The claim class is what a COMMENT asserts. A filename in an error message is not a claim
    // about a consumer, and flagging it would make the guard fire on correct code.
    const c = consumer("live3", ["handler.py"]);
    const dir = join(work, "src-string");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "thing.ts"), 'export const msg = "could not read gone_forever.py";\n');
    const r = run({ src: dir, roots: [c] });
    expect(r.code).toBe(0);
  });

  it("an exclusion suppresses its known references", () => {
    const c = consumer("live4", ["handler.py"]);
    const excl = exclusions([{ symbol: "gone_forever.py", expected: 1, reason: "tracked in core#183" }]);
    const r = run({ src: srcWith("the pod reads this in gone_forever.py"), roots: [c], excl });
    expect(r.code).toBe(0);
    expect(r.out).toContain("EXCLUDED gone_forever.py");
  });

  it("an exclusion does NOT absorb a NEW reference: the count drifts and it trips", () => {
    // The failure mode of every allowlist is growing coverage holes silently. An exclusion covers a
    // known SET of references, so a second mention of an excluded file has to be looked at.
    const c = consumer("live5", ["handler.py"]);
    const dir = join(work, "src-drift");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "// first mention of gone_forever.py\nexport const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "// second mention of gone_forever.py\nexport const b = 2;\n");
    const excl = exclusions([{ symbol: "gone_forever.py", expected: 1, reason: "tracked in core#183" }]);
    const r = run({ src: dir, roots: [c], excl });
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXCLUSION DRIFT");
    expect(r.out).toContain("expected 1 excluded references, found 2");
  });

  it("REFUSES when only SOME declared roots resolve, so partial coverage cannot read as clean", () => {
    // Five of six consumers checked out is not a clean sweep, it is a narrower one reporting the
    // same green. The refusal is what keeps a checkout that quietly stopped working visible.
    const c = consumer("live7", ["handler.py"]);
    const r = run({ src: srcWith("mentions handler.py"), roots: [c, "/nonexistent/consumer"] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("MISSING");
    expect(r.out).toContain("REFUSED");
  });

  it("REFUSES an exclusion with no reason, and one with no expected count", () => {
    const c = consumer("live6", ["handler.py"]);
    const src = srcWith("the pod reads this in gone_forever.py");
    const noReason = exclusions([{ symbol: "gone_forever.py", expected: 1 }]);
    expect(run({ src, roots: [c], excl: noReason }).code).toBe(2);
    const noCount = exclusions([{ symbol: "gone_forever.py", reason: "because" }]);
    expect(run({ src, roots: [c], excl: noCount }).code).toBe(2);
  });
});
