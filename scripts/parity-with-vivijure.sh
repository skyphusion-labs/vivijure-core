#!/usr/bin/env bash
# Compare vivijure-core extracted files against skyphusion-labs/vivijure src/.
#
#   VIVIJURE_SRC=../vivijure npm run parity:vivijure
#   VIVIJURE_SRC=../vivijure npm run parity:vivijure:strict
#
# Default: verify modules/types.ts + list differing shared files (non-fatal except types.ts).
# --strict: exit 1 on ANY differing file in the shared manifest (for CI hard gate once green).

set -euo pipefail

STRICT=0
UP=""
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h|--help)
      echo "usage: parity-with-vivijure.sh [path-to-vivijure] [--strict]" >&2
      exit 0
      ;;
    *)
      if [[ -z "$UP" ]]; then UP="$arg"; else
        echo "unexpected arg: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

UP="${UP:-${VIVIJURE_SRC:-../vivijure}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$UP/src" ]]; then
  echo "parity-with-vivijure: upstream not found: $UP/src" >&2
  exit 2
fi

# Shared paths: same relative path in both repos (or documented alias).
FILES=(
  modules/conformance.ts
  modules/render-pipeline.ts
  modules/registry.ts
  preflight.ts
  planner-prompt.ts
  output-extract.ts
  public-id.ts
  srt.ts
  captions.ts
  finish-hash.ts
  film-model.ts
  film-orchestrator.ts
  film-render-bridge.ts
  render-orchestrator.ts
  render-module-config.ts
  bundle-assembler.ts
  cast-db.ts
  storyboard-projects-db.ts
  renders-db.ts
  render-log.ts
  storyboard-validate.ts
  planner-yaml.ts
  clip-validate.ts
  clip-content-validate.ts
  audio-stage.ts
  audio-routing.ts
  operator-config.ts
  d1-retry.ts
  secret-store.ts
  voices.ts
  dialogue-lines.ts
  bundle-storyboard.ts
  scatter.ts
  scatter-orchestrator-types.ts
  scatter-orchestrator.ts
  scatter-notify.ts
  lora-bundle.ts
  cast-loras.ts
  cast-lora-train.ts
  runpod-submit.ts
  beat-analyze.ts
  render-sweep.ts
  render-adopt.ts
  render-mux.ts
  tar.ts
)

# tar.ts in core == tar-emit.ts in vivijure (bundle tar, not cast vvcast reader).
TAR_ALIAS=1

fail=0

# Module contract: byte-identical required.
types_up="$UP/src/modules/types.ts"
types_core="$ROOT/src/modules/types.ts"
if diff -q "$types_up" "$types_core" >/dev/null 2>&1; then
  echo "parity-with-vivijure: OK modules/types.ts (byte-identical)"
else
  echo "parity-with-vivijure: DRIFT modules/types.ts (MUST be byte-identical)" >&2
  diff -u "$types_up" "$types_core" | head -40 >&2 || true
  fail=1
fi

drift=()
identical=()
for rel in "${FILES[@]}"; do
  [[ "$rel" == "modules/types.ts" ]] && continue
  core_path="$ROOT/src/$rel"
  if [[ "$rel" == "tar.ts" && $TAR_ALIAS -eq 1 ]]; then
    up_path="$UP/src/tar-emit.ts"
    label="tar.ts (core) vs tar-emit.ts (vivijure)"
  else
    up_path="$UP/src/$rel"
    label="$rel"
  fi
  if [[ ! -f "$up_path" ]]; then
    echo "parity-with-vivijure: SKIP missing upstream $label" >&2
    continue
  fi
  if [[ ! -f "$core_path" ]]; then
    echo "parity-with-vivijure: DRIFT missing core $label" >&2
    drift+=("$label")
    continue
  fi
  if diff -q "$up_path" "$core_path" >/dev/null 2>&1; then
    identical+=("$label")
  else
    drift+=("$label")
  fi
done

echo "parity-with-vivijure: identical (${#identical[@]}): ${identical[*]:-none}"
if [[ ${#drift[@]} -gt 0 ]]; then
  echo "parity-with-vivijure: differ (${#drift[@]}): ${drift[*]}" >&2
  if [[ $STRICT -eq 1 ]]; then
    fail=1
  else
    echo "parity-with-vivijure: (non-strict mode: import/platform drift may be expected; see docs/PARITY.md)" >&2
  fi
fi

if [[ $fail -ne 0 ]]; then
  echo "parity-with-vivijure: FAIL" >&2
  exit 1
fi
echo "parity-with-vivijure: PASS"
