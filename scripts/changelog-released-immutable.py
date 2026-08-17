#!/usr/bin/env python3
"""
A RELEASED changelog section is immutable (core#231).

WHY THIS EXISTS. Ported from vivijure-cf scripts/changelog-released-immutable.py (cf#551 piece 2),
itself ported unchanged in mechanism from vivijure-control-plane (cp#219, cp#245). This repo already
had the other half of that two-part gate (scripts/changelog-entry-required.mjs, core#178 / core#202).
entry-required asks whether a PR added an entry; this asks whether a released section still says
what it said when its tag was cut. core#212 is the failure this one sees and that one cannot: a PR
branched before a heading closed lands its diff INSIDE the published section, the merge is clean,
and the entry-required check is green because an entry exists (under the wrong heading).

WHAT IT CHECKS, and note it is a property of the TREE rather than of a diff. For every released
heading that has a matching git tag, the section body here must be byte-identical to the same
section in CHANGELOG.md AT THAT TAG. No base ref, no diff parsing, no question of which lines this
PR touched: the released text either still says what it said when it shipped, or it does not.

THE ONE EXCEPTION, and it is DECLARED rather than inferred. A released section may be corrected in
place when the original note was WRONG about what shipped. A rule forbidding all edits would forbid
that honesty too.

THE EXCEPTION DOES NOT LIVE IN THE CHANGELOG. Ported reasoning from cp#245, control-plane own
regression: the waiver used to be a marker string tested as a substring anywhere in the section body,
and a section that merely QUOTED the marker inside backticks while documenting the mechanism disarmed
immutability for its own section, silently, because a waiver and a pass look identical downstream. So
the waiver moved OUT of the file being checked, into scripts/changelog-corrections.txt, and drift now
needs BOTH:

  1. the version listed in that file, the waiver, reviewable as its own line in a diff, and
     unreachable by anything a changelog entry can say;
  2. a line in that section BEGINNING at column 0 with the marker below, what tells a READER of the
     changelog that the text moved after the tag.

Listed but undeclared is refused: the record would be silently corrected and the reader never told.
Declared but unlisted is refused: that is the cp#245 defect itself, reproduced here as a mutation test
rather than assumed absent. Neither half waives anything on its own, and an edit with neither is the
case the original incident produced.

DIALECT, THIS REPO ONLY. The sibling script matches `## vX.Y.Z` against git tags named `vX.Y.Z`.
This repo writes `## [X.Y.Z] -- date` (and a few older `## vX.Y.Z` headings) and cuts tags named
`vivijure-core-vX.Y.Z`. Copied unchanged, the sibling regex and tag glob match ZERO sections here
and the guard refuses on "compared ZERO released sections" forever, which is a red that cannot go
green. Heading parse and tag lookup are the only adaptations; everything below them (byte compare,
both-halves waiver, duplicate-heading refusal, empty-comparison refusal) is the sibling mechanism.

NOT PORTED: the sibling "CHANGELOG.md has no `## Unreleased` heading" refusal. This repo's release
cut RENAMES the open heading and leaves main on a tagged version with no Unreleased section
(scripts/changelog-assemble.mjs, core#146). A permanent Unreleased anchor would fire
tests/changelog-version.test.ts (spent-version) after every cut. The incident that check exists for
in the siblings (next merge has nowhere to land but under the released heading) is the comparison
above, which still refuses an entry added under a tagged section.

ADVISORY AGAINST THE LIVE TREE FOR NOW (core#231, same shape as cf#551). Measured at port time
against origin/main 25d4a87: three released sections already drift (v1.18.0, v1.13.0, v1.3.0),
plus several older tags whose CHANGELOG.md either predates the file or has no section for that
version (reported UNCHECKED, not counted as a pass). Wiring the live-repo step as a blocking gate
today would fail every open and future PR on pre-existing debt that a maintenance sweep has no
authority to resolve unilaterally. See .github/workflows/changelog.yml (continue-on-error on the
live run; the mutation-test step is a real bar) until that debt is an editorial call.

Exit 0 and print nothing when every released section is untouched; exit 1 and name each drift.
"""
import re
import subprocess
import sys
import pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# Sibling (cf / control-plane) form is `## vX.Y.Z`. This repo's form is `## [X.Y.Z]` (see
# tests/changelog-version.test.ts). Accept both; normalize to vX.Y.Z so messages, the
# corrections allowlist, and the mutation tests stay in the sibling dialect.
# No trailing \b after `]`: word-boundary fails between ] and space/newline (same note as
# topChangelogClaim in tests/changelog-version.test.ts).
HEADING = re.compile(r"^## (?:\[v?(\d+\.\d+\.\d+)\]|(v\d+\.\d+\.\d+)\b)")

# What tells a READER that a released section was corrected. Required at the START of a line
# (column 0), never matched as a substring: an indented or backticked mention is prose ABOUT the
# mechanism, not a declaration by it (cp#245). This alone waives nothing; see the file below.
CORRECTION_MARKER = "**CORRECTED AFTER PUBLICATION"

# The waiver itself, deliberately OUTSIDE the file being checked, so no changelog text can grant it.
CORRECTIONS_FILE = "scripts/changelog-corrections.txt"

TAG_PREFIX = "vivijure-core-"


def heading_version(line):
    """vX.Y.Z for a released heading, or None. Unreleased-shaped headings do not match."""
    m = HEADING.match(line)
    if not m:
        return None
    if m.group(1):
        return "v" + m.group(1)
    return m.group(2)


def declared_corrections(root):
    """Versions allowed to drift, read from CORRECTIONS_FILE. Returns (versions, file_present).

    A MISSING file is an EMPTY allowlist rather than an error: that direction fails closed (every
    drift is then refused), and the refusal names the file so the reason is not a mystery. The
    opposite default would let deleting one file silently unlock every released section.
    """
    path = root / CORRECTIONS_FILE
    if not path.exists():
        return set(), False
    versions = set()
    for line in path.read_text().split("\n"):
        line = line.split("#", 1)[0].strip()
        if line:
            versions.add(line.split()[0])
    return versions, True


def declares_correction(body):
    """Does this section TELL A READER it was corrected? Anchored at column 0, never a substring."""
    return any(line.startswith(CORRECTION_MARKER) for line in body.split("\n"))


def sections(text):
    """Map version -> section body, for every released heading in a changelog.

    Returns (sections, duplicates). DUPLICATES ARE RETURNED RATHER THAN SWALLOWED: a dict keyed by
    version silently keeps the LAST occurrence, so a changelog carrying the same version heading
    twice would have one of them compared and the other ignored entirely. That is not theoretical.
    A bad merge produced exactly that in control-plane, twice, and this function passed it: the
    second heading matched its tag, so the guard reported ok while the first one carried entries
    that did not belong to that release at all. The comparison was right about the section it looked
    at and blind to the one that was wrong.
    """
    lines = text.split("\n")
    starts = [(i, heading_version(l)) for i, l in enumerate(lines) if heading_version(l)]
    out = {}
    seen = []
    duplicates = []
    for i, version in starts:
        if version in seen:
            duplicates.append(version)
        seen.append(version)
        end = len(lines)
        for j in range(i + 1, len(lines)):
            if lines[j].startswith("## "):
                end = j
                break
        out[version] = "\n".join(lines[i:end]).rstrip()
    return out, duplicates


def git(*args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
    )


def released_tags():
    """Normalize git tags to vX.Y.Z keys.

    This repo cuts `vivijure-core-vX.Y.Z`. Sibling fixtures (and the original cf / control-plane
    scripts) cut `vX.Y.Z`. Both name the same released heading. `v*` alone would also match
    unrelated tags that merely contain a v; `v[0-9]*` plus the repo prefix is the pair that
    cannot silently pick up `verify-v*` / similar.
    """
    listed = git("tag", "--list", TAG_PREFIX + "v*").stdout.split() + git(
        "tag", "--list", "v[0-9]*"
    ).stdout.split()
    out = set()
    for t in listed:
        t = t.strip()
        if not t:
            continue
        if t.startswith(TAG_PREFIX):
            t = t[len(TAG_PREFIX) :]
        if re.fullmatch(r"v\d+\.\d+\.\d+", t):
            out.add(t)
    return out


def show_changelog_at(version):
    """CHANGELOG.md at the tag for this version. Prefer the repo prefix, then a bare v* tag."""
    last = None
    for ref in (TAG_PREFIX + version, version):
        shown = git("show", ref + ":CHANGELOG.md")
        last = shown
        if shown.returncode == 0:
            return shown
    return last


text = (root / "CHANGELOG.md").read_text()
head, head_dupes = sections(text)
tags = released_tags()
corrections, corrections_present = declared_corrections(root)
problems = []
checked = 0

for version, body in head.items():
    if version not in tags:
        # Not released yet. Nothing to be immutable against.
        continue
    shown = show_changelog_at(version)
    if shown is None or shown.returncode != 0:
        # A tag predating the changelog, or a clone without tag objects. Refusing would fail every
        # shallow CI checkout; staying silent would let this pass vacuously on a clone that can see
        # nothing. So it is reported as UNCHECKED rather than counted as a pass.
        print("changelog-immutable: cannot read CHANGELOG.md at " + version + "; NOT checked")
        continue
    at_tag = sections(shown.stdout)[0].get(version)
    if at_tag is None:
        print("changelog-immutable: " + version + " has no section in its own tagged file; NOT checked")
        continue
    checked += 1
    if at_tag != body:
        # BOTH halves, and the two failures are reported DIFFERENTLY on purpose: "you forgot the
        # waiver" and "you forgot to tell the reader" send a person to different places, and one
        # message covering both would send half of them to the wrong one.
        declared = declares_correction(body)
        allowed = version in corrections
        if allowed and declared:
            print(
                "changelog-immutable: " + version + " is an allowlisted post-publication "
                "correction and says so; drift permitted"
            )
            continue
        if allowed and not declared:
            problems.append(
                "the " + version + " section has CHANGED and " + CORRECTIONS_FILE + " allows it, "
                "but the section carries no line BEGINNING with " + CORRECTION_MARKER + ". The "
                "allowlist is for this script; the marker is for the person reading the changelog, "
                "who would otherwise see corrected text presented as what shipped. Add the "
                "declaration, at column 0, inside that section."
            )
            continue
        if declared and not allowed:
            problems.append(
                "the " + version + " section has CHANGED and declares a correction, but "
                + CORRECTIONS_FILE + " does not list it"
                + ("" if corrections_present else " (that file is MISSING entirely)")
                + ". The waiver deliberately does NOT live in the changelog: a section that merely "
                "MENTIONED the marker used to disarm this check for itself (cp#245). Add the "
                "version to that file in the same PR, where a reviewer sees it as its own line."
            )
            continue
        problems.append(
            "the " + version + " section has CHANGED since the tag was cut. A released section "
            "records what that artifact actually contains, so editing it makes the changelog assert "
            "something the tag does not have. If this entry belongs to work merged AFTER " + version
            + ", it goes under the `## Unreleased` heading. If the original note was WRONG about "
            "what shipped, correct it in place, mark the section with a line BEGINNING at column 0 "
            "with " + CORRECTION_MARKER + ", AND list the version in " + CORRECTIONS_FILE + ". Both "
            "are required; neither waives anything alone."
        )

# NOTHING TO CHECK AND EVERYTHING CHECKS OUT MUST NOT BE THE SAME OUTPUT.
#
# The sibling script printed ok having compared ZERO sections, because a bare actions/checkout is
# shallow with no tags, so every released heading failed the "is it released" test and the loop did
# nothing. The guard was inert in CI while reading green, which is the same failure as a roll-up
# reporting rows_ingested 0 as success, or a meter reporting complete on a reading it never made.
#
# So an empty comparison is a REFUSAL. If this repo genuinely has no released version yet, that is a
# one-line allowance to add deliberately, not a silence to inherit.
for version in sorted(set(head_dupes)):
    problems.append(
        "CHANGELOG.md carries the heading for " + version + " MORE THAN ONCE. Only one of them can "
        "be compared against the tag, so the other is invisible to this check entirely, which is "
        "how a bad merge hides misattributed entries behind a section that happens to match. "
        "Duplicate version headings are almost always a merge that produced two, and the fix is to "
        "keep one and move the stray entries under `## Unreleased`."
    )

if checked == 0:
    problems.append(
        "compared ZERO released sections, so this run proves nothing. Every version heading in "
        "CHANGELOG.md failed to match a git tag, which in CI almost always means the checkout is "
        "shallow and carries no tags: use `fetch-depth: 0` (or `fetch-tags: true`). Refusing "
        "rather than reporting a pass it did not earn."
    )

if problems:
    for p in problems:
        print("changelog-immutable: " + p)
    sys.exit(1)
sys.exit(0)
