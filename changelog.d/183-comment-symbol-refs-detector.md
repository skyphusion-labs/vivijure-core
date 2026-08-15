### ci(comments): detect comments naming a consumer-side file that no longer exists (core#183)

A census of `src/` measured **1424 comment blocks, 650 of which make a falsifiable claim about
another component, and 7 measurably false**. Verifying a claim costs a human read; verifying that a
NAMED FILE still exists costs a filesystem lookup. That is the one axis of the census worth
automating, and it had the highest yield per unit cost of the three tried.

`scripts/comment-symbol-refs.mjs` flags a comment in `src/` that names `<something>.py` when no live
consumer repo contains a file by that name. It runs in `ci` against the five satellite/backend repos
plus `vivijure-cf`.

**What it detects, stated narrowly:** a STALE REFERENCE. That is a **superset** of the false-claim
class and not the same thing -- a stale name can sit above a perfectly true sentence, which is why
the census counted 8 such comments separately. The tool does not claim a flagged comment is WRONG,
only that it points at something that is gone. Overclaiming here would make the number useless.

**Failure posture, which is the whole design:**

- **Refuses (exit 2) when no consumer root is declared**, and **also when only SOME resolve.** Five
  of six checkouts is not a clean sweep, it is a narrower one reporting the same green.
- **A two-way control runs on EVERY invocation, before any verdict:** a known-present file must
  resolve and a known-absent one must not. Either failing exits 2, because a resolver that cannot see
  is indistinguishable from a tree with nothing stale in it.
- **`tests/comment-symbol-refs.test.ts` drives the SHIPPED script** through nine constructed cases --
  clean tree, stale reference, no roots, partial roots, blind control, string-literal-not-a-comment,
  exclusion honoured, exclusion drift, malformed exclusion. So CI watches the detector fail on every
  run rather than only watching it pass.

**Exclusions carry a reason AND an expected count**, both required or the script refuses. The count
is what stops an allowlist growing coverage holes: an exclusion covers a KNOWN set of references, so
a new mention of an already-excluded file trips the gate instead of being absorbed.

Ten current references across four symbols are excluded and tracked in core#183, each with its
reason recorded: `rp_handler.py` (3), `core.py` (5), `characters.py` (1), `studio_service.py` (1).
Most name the retired `vivijure-serverless` worker, so the file is gone with its repo rather than
missing from a live one. **The known-false comments are deliberately NOT fixed here** -- fixing a
detector's findings in the same change that ships it leaves the detector never observed firing on
real data.

**One correction to the reasoning that motivated this.** The census reported that searching `docs/`
masked `rp_handler.py`. Measured while building this: for a FILENAME resolver, excluding `docs/`
changes nothing -- identical results with and without, on all nine symbols. That masking was a
CONTENT match, and a filename match is immune to it by construction. The `docs/` exclusion is kept
as cheap insurance against a doc file literally named for a consumer module, not because it is
load-bearing.

**What it cannot see, so green is not mistaken for coverage:** dotted symbol references
(`r2_io.download_and_extract`) are out of scope, because the looser form matches ordinary property
access at a noise level that would get the guard switched off; claims naming no file and no symbol
are unreachable by any of this; nothing outside `src/` is scanned; and it says nothing about whether
a claim is TRUE, only whether the file it names still exists.
