#!/usr/bin/env node
// core#335: run a consumer's own suite against THIS core build, and say which of three things happened.
//
// Usage: node scripts/consumer-suite.mjs --core <core dir> --consumer <consumer dir> --name <label>
//
//   PASS        the consumer is green on its own pin AND green on this core build.        exit 0
//   FAIL        the consumer is green on its own pin and RED on this core build, or this
//               core build could not be packed or installed. Core's change broke it.      exit 1
//   UNMEASURED  the consumer could not be installed, or is RED on its own pin, or the
//               build under test could not be proven to be the one that ran. Nothing was
//               learned about core. By the lead's ruling this must not block a core PR.   exit 0
//
// WHY UNMEASURED IS ITS OWN WORD. This issue exists because "core's suite is green" and "core's
// change is safe for consumers" rendered identically, three times. An UNMEASURED that printed as a
// PASS would reproduce that in a new place. It exits 0 because a red consumer main is not core's
// defect (ruled 2026-11-09), so the distinction lives in the verdict line, the ::warning::
// annotation and the step summary, never in the exit status alone.
//
// WHY THE BASELINE. Without it, cf being red on its own would read as core breaking cf, and core's
// gate would depend on cf's health: the objection to option 1 in the issue.
//
// THE CANDIDATE MUST BE PROVEN TO HAVE LOADED. After installing the packed tarball, EVERY file the
// pack listed is compared by sha256 between this core tree and the consumer's installed copy. A test
// run against the registry copy, or a stale node_modules, is exactly the false PASS this exists to
// prevent, and it would look the same. Comparing the main file alone is NOT enough, and that was
// measured: dist/index.js is a re-export barrel, byte-identical between 1.41.3 on npm and main.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VERDICT = { PASS: "PASS", FAIL: "FAIL", UNMEASURED: "UNMEASURED" };

/** Pure: the verdict from what happened. Each stage is true (ok), false (failed) or undefined (not reached). */
export function decide(s) {
  if (s.consumerInstall !== true) return { verdict: VERDICT.UNMEASURED, reason: "the consumer could not be installed on its own pin" };
  if (s.baseline !== true) return { verdict: VERDICT.UNMEASURED, reason: "the consumer is red on its own pin (baseline), so nothing was learned about core" };
  if (s.pack !== true) return { verdict: VERDICT.FAIL, reason: "this core build could not be packed" };
  if (s.candidateInstall !== true) return { verdict: VERDICT.FAIL, reason: "this core build could not be installed into the consumer" };
  if (s.proven !== true) return { verdict: VERDICT.UNMEASURED, reason: "could not prove the consumer loaded this core build" };
  if (s.candidate !== true) return { verdict: VERDICT.FAIL, reason: "the consumer is green on its own pin and red on this core build" };
  return { verdict: VERDICT.PASS, reason: "green on its own pin and on this core build" };
}

export function exitCodeFor(verdict) {
  return verdict === VERDICT.FAIL ? 1 : 0;
}

function run(label, cmd, args, cwd) {
  console.log(`::group::${label}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  console.log("::endgroup::");
  const ok = r.status === 0;
  console.log(`consumer-suite: ${label} -> ${ok ? "ok" : `exit ${r.status ?? r.signal ?? "?"}`}`);
  return ok;
}

function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** The consumer's checks: typecheck if it declares one, then test. */
function checks(label, dir) {
  const scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
  if (!scripts.test) {
    console.log(`consumer-suite: ${label}: the consumer declares no test script`);
    return false;
  }
  if (scripts.typecheck && !run(`${label} typecheck`, "npm", ["run", "typecheck"], dir)) return false;
  return run(`${label} test`, "npm", ["test"], dir);
}

/** Every packed file must exist in both trees with the same sha256. package.json is excluded:
 *  npm rewrites it on install. */
export function proveInstalled(coreDir, installedDir, files) {
  const compared = files.filter((f) => f !== "package.json");
  if (compared.length === 0) return { ok: false, detail: "NOT proven: the pack listed no files to compare" };
  for (const f of compared) {
    const a = join(coreDir, f);
    const b = join(installedDir, f);
    if (!existsSync(a) || !existsSync(b) || sha256(a) !== sha256(b)) return { ok: false, detail: `NOT proven: ${f} differs or is missing` };
  }
  return { ok: true, detail: `all ${compared.length} packed files match this build` };
}

export function runConsumerSuite({ core, consumer }) {
  const s = {};
  const corePkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
  const name = corePkg.name;

  s.consumerInstall = run("consumer install (its own pin)", "npm", ["ci", "--no-audit", "--no-fund"], consumer);
  if (!s.consumerInstall) return decide(s);
  s.baseline = checks("baseline (its own pin)", consumer);
  if (!s.baseline) return decide(s);

  // core#526: the pack directory is removed on EVERY path out, including each early return below.
  // On a runner it is discarded anyway; on a laptop $TMPDIR is in the member's home and is not
  // cleared at boot, so without this every run left one more tarball behind.
  const dest = mkdtempSync(join(tmpdir(), "core-consumer-pack-"));
  try {
    return packAndProve(s, core, consumer, name, dest);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

function packAndProve(s, core, consumer, name, dest) {
  console.log(`::group::pack this core build: npm pack --json`);
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", dest], { cwd: core, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  console.log("::endgroup::");
  let files = [];
  try {
    const out = String(packed.stdout ?? "");
    files = (JSON.parse(out.slice(out.indexOf("[")))[0]?.files ?? []).map((f) => f.path);
  } catch {
    files = [];
  }
  const tgz = packed.status === 0 ? readdirSync(dest).filter((f) => f.endsWith(".tgz")) : [];
  s.pack = packed.status === 0 && tgz.length === 1 && files.length > 0;
  console.log(`consumer-suite: pack this core build -> ${s.pack ? `ok, ${files.length} files` : `exit ${packed.status}`}`);
  if (!s.pack) return decide(s);

  s.candidateInstall = run("install this core build", "npm", ["install", "--no-save", "--no-audit", "--no-fund", join(dest, tgz[0])], consumer);
  if (!s.candidateInstall) return decide(s);

  const proof = proveInstalled(core, join(consumer, "node_modules", ...name.split("/")), files);
  s.proven = proof.ok;
  console.log(`consumer-suite: candidate proof: ${proof.detail}`);
  if (!s.proven) return decide(s);

  s.candidate = checks("candidate (this core build)", consumer);
  return decide(s);
}

function report(label, { verdict, reason }) {
  const line = `consumer-suite ${label}: ${verdict} (${reason})`;
  const level = verdict === VERDICT.PASS ? "notice" : verdict === VERDICT.FAIL ? "error" : "warning";
  console.log(`::${level} title=consumer-${label}: ${verdict}::${reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### consumer ${label}: ${verdict}\n\n${reason}\n`);
    } catch {
      /* the summary is a convenience; the verdict line below is the record */
    }
  }
  console.log(line);
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i]] = argv[i + 1];
  if (!a["--core"] || !a["--consumer"] || !a["--name"]) {
    console.error("usage: consumer-suite.mjs --core <dir> --consumer <dir> --name <label>");
    return 2;
  }
  const core = resolve(a["--core"]);
  const consumer = resolve(a["--consumer"]);
  for (const d of [core, consumer]) {
    if (!existsSync(join(d, "package.json"))) {
      console.error(`consumer-suite: no package.json in ${d}`);
      return 2;
    }
  }
  const result = runConsumerSuite({ core, consumer });
  report(a["--name"], result);
  return exitCodeFor(result.verdict);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
