#!/usr/bin/env bash
# RETIRED 2026-07-16 -- flatliners Hetzner box deleted. Do not run.
# Historical: sync vivijure-core + vivijure sibling clones on flatliners from GitHub main.
#
#   ssh flatliners 'bash -s' < scripts/flatliners-sync.sh
#   BRANCH=feat/vivijure-parity-p0 ssh flatliners 'bash -s' < scripts/flatliners-sync.sh
#
# Requires: gh auth, git, node 22+, ~/dev layout below.

set -euo pipefail

echo "flatliners-sync: RETIRED (box deleted 2026-07-16). Use propagandhi / laptop clones." >&2
exit 1

DEV="${DEV:-$HOME/dev}"
BRANCH="${BRANCH:-main}"
ORG="skyphusion-labs"

clone_or_pull() {
  local name="$1"
  local dir="$DEV/$name"
  if [[ ! -d "$dir/.git" ]]; then
    mkdir -p "$DEV"
    gh repo clone "$ORG/$name" "$dir"
  fi
  git -C "$dir" fetch origin
  git -C "$dir" checkout "$BRANCH"
  git -C "$dir" pull --ff-only "origin" "$BRANCH"
  echo "flatliners-sync: $name @ $(git -C "$dir" rev-parse --short HEAD) ($BRANCH)"
}

mkdir -p "$DEV"
clone_or_pull vivijure-core
clone_or_pull vivijure-cf   # module manifests for the quality-tier-drift test

echo "flatliners-sync: npm ci + verify (vivijure-core)"
cd "$DEV/vivijure-core"
npm ci
npm run typecheck
npm test
echo "flatliners-sync: OK"
