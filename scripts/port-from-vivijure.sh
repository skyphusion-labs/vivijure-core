#!/usr/bin/env bash
# Port host orchestration files from vivijure into vivijure-core with import rewrites.
set -euo pipefail

UP="${VIVIJURE_SRC:-../vivijure}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$UP/src"

if [[ ! -d "$SRC" ]]; then
  echo "port-from-vivijure: missing $SRC" >&2
  exit 2
fi

FILES=(
  voices.ts
  dialogue-lines.ts
  bundle-storyboard.ts
  scatter.ts
  scatter-orchestrator-types.ts
  scatter-notify.ts
  lora-bundle.ts
  cast-loras.ts
  cast-lora-train.ts
  runpod-submit.ts
  beat-analyze.ts
  render-sweep.ts
  render-adopt.ts
  render-mux.ts
  scatter-orchestrator.ts
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "port-from-vivijure: SKIP missing upstream $f" >&2
    continue
  fi
  cp "$SRC/$f" "$ROOT/src/$f"
  echo "port-from-vivijure: copied $f"
done

# Import rewrites (vivijure host paths -> core ICD paths).
while IFS= read -r -d '' f; do
  perl -pi -e '
    s|from "\./env"|from "./platform/orchestrator-context.js"|g;
    s|from "\./r2-presign"|from "./presign.js"|g;
    s|from "\./secret-store"|from "./secret-store.js"|g;
    s|from "\./shared"|from "./key-safety.js"|g;
    s|from "\./runpod-submit"|from "./runpod-submit.js"|g;
    s|from "\./runpod-types"|from "./runpod-types.js"|g;
    s|from "\./modules/types"|from "./modules/types.js"|g;
    s|from "\./modules/registry"|from "./modules/registry.js"|g;
    s|from "\./beat-sync-types"|from "./beat-sync-types.js"|g;
    s|from "\./(\.\./[^"]+)"|from "./$1.js"|g;
    s|from "\./([^"]+)"(?!\.js")|from "./$1.js"|g;
  ' "$f"
done < <(printf '%s\0' "${FILES[@]/#/$ROOT/src/}")

echo "port-from-vivijure: done (${#FILES[@]} files)"
