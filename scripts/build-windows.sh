#!/usr/bin/env bash
# Build Windows x64 portable bundles of 124 Chat Agent on macOS.
#
# Outputs (split so model changes don't force re-uploading the whole bundle):
#   dist/124-Chat-Agent-Windows-app.zip      ~800 MB  (code + Electron + ollama runtime)
#   dist/124-Chat-Agent-Windows-models.zip   ~3.6 GB  (resources/models only)
#
# On Windows, extract BOTH zips to the same folder. They merge cleanly because
# they don't share any files — only the empty parent dirs overlap.
#
# Usage:  ./scripts/build-windows.sh           # incremental
#         BUILD_FORCE=1 ./scripts/build-windows.sh   # force rebuild of both
#
# Hash-based cache:
#   - Two independent hashes: app inputs vs model manifests
#   - Stored in .build-cache/win-app.sha256 and win-models.sha256
#   - Re-zips only the portion(s) whose inputs changed
#   - Failed builds leave previous hashes intact

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STASH="$ROOT/.build-stash"
CACHE_DIR="$ROOT/.build-cache"
APP_HASH_FILE="$CACHE_DIR/win-app.sha256"
MODELS_HASH_FILE="$CACHE_DIR/win-models.sha256"

# Ollama runtime cache lives under .build-cache so macOS doesn't clean it
# (vs $TMPDIR which differs from /tmp and can be auto-purged).
OLLAMA_ZIP="$CACHE_DIR/ollama-win.zip"
OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip"

EXCLUDE_FAMILY="gemma4"   # model family to leave out of the build
APP_ZIP="$ROOT/dist/124-Chat-Agent-Windows-app.zip"
MODELS_ZIP="$ROOT/dist/124-Chat-Agent-Windows-models.zip"
SCRIPT_PATH="scripts/build-windows.sh"

[[ "$(uname)" == "Darwin" ]] || { echo "ERROR: this script must run on macOS." >&2; exit 1; }
mkdir -p "$CACHE_DIR"

# ── Hashes ───────────────────────────────────────────────────────────────────
# Model blobs are content-addressed (sha256 in filename), so manifests capture
# any content change without rereading the blobs themselves.
hash_files() { sort -u | tr '\n' '\0' | xargs -0 shasum -a 256 2>/dev/null | sort | shasum -a 256 | awk '{print $1}'; }

compute_app_hash() {
  local paths=(
    main.js preload.js
    api app components lib
    package.json package-lock.json
    next.config.js tailwind.config.js postcss.config.js
    jsconfig.json components.json
    resources/documents
    "$SCRIPT_PATH"
  )
  local existing=()
  local p
  for p in "${paths[@]}"; do [[ -e "$p" ]] && existing+=("$p"); done
  [[ ${#existing[@]} -gt 0 ]] || { echo "EMPTY"; return; }
  find "${existing[@]}" -type f 2>/dev/null | hash_files
}

compute_models_hash() {
  find resources/models/manifests -type f -not -path "*/$EXCLUDE_FAMILY/*" 2>/dev/null | hash_files
}

APP_HASH=$(compute_app_hash)
MODELS_HASH=$(compute_models_hash)

is_fresh() {
  local hash_file=$1 expected=$2 zip=$3
  [[ -f "$hash_file" && -f "$zip" && "$expected" == "$(cat "$hash_file")" ]]
}

APP_FRESH=false
MODELS_FRESH=false
is_fresh "$APP_HASH_FILE"    "$APP_HASH"    "$APP_ZIP"    && APP_FRESH=true
is_fresh "$MODELS_HASH_FILE" "$MODELS_HASH" "$MODELS_ZIP" && MODELS_FRESH=true

if [[ "${BUILD_FORCE:-}" == "1" ]]; then
  echo "==> BUILD_FORCE=1 — forcing both rebuilds"
  APP_FRESH=false
  MODELS_FRESH=false
fi

if [[ "$APP_FRESH" == "true" && "$MODELS_FRESH" == "true" ]]; then
  echo "✓ Both bundles up-to-date"
  printf "    %s  (%s)\n" "$APP_ZIP"    "$(du -sh "$APP_ZIP"    | cut -f1)"
  printf "    %s  (%s)\n" "$MODELS_ZIP" "$(du -sh "$MODELS_ZIP" | cut -f1)"
  echo "  Force rebuild with: BUILD_FORCE=1 $0"
  exit 0
fi

echo "==> Build plan:"
echo "    app    zip: $([ "$APP_FRESH"    = "true" ] && echo "skip (fresh)" || echo "REBUILD")"
echo "    models zip: $([ "$MODELS_FRESH" = "true" ] && echo "skip (fresh)" || echo "REBUILD")"

# ── Cleanup on exit ──────────────────────────────────────────────────────────
restore() {
  local code=$?
  echo
  echo "==> Restoring local state..."
  if [[ -d "$STASH/manifests/$EXCLUDE_FAMILY" ]]; then
    mkdir -p "resources/models/manifests/registry.ollama.ai/library/$EXCLUDE_FAMILY"
    mv "$STASH/manifests/$EXCLUDE_FAMILY"/* \
       "resources/models/manifests/registry.ollama.ai/library/$EXCLUDE_FAMILY/" 2>/dev/null || true
  fi
  if [[ -d "$STASH/blobs" ]]; then
    mv "$STASH/blobs"/* resources/models/blobs/ 2>/dev/null || true
  fi
  if [[ -f "$STASH/ollama-mac" ]]; then
    mv "$STASH/ollama-mac" resources/ollama/ollama
    chmod +x resources/ollama/ollama
  fi
  rm -f resources/ollama/ollama.exe resources/ollama/vc_redist.x64.exe
  rm -rf resources/ollama/lib
  rm -rf "$STASH"
  if [[ $code -eq 0 ]]; then echo "    done"; else echo "    done (build failed with exit $code)"; fi
}
trap restore EXIT

# ── Pre-flight ───────────────────────────────────────────────────────────────
free_gb=$(df -g "$ROOT" | awk 'NR==2 {print $4}')
if (( free_gb < 15 )); then
  echo "WARNING: only ${free_gb} GB free. Build needs ~15 GB headroom." >&2
fi

# ── 1. Stash gemma4 models + Mac ollama ──────────────────────────────────────
echo "==> [1/5] Stashing $EXCLUDE_FAMILY models"
mkdir -p "$STASH/manifests/$EXCLUDE_FAMILY" "$STASH/blobs"

excl_dir="resources/models/manifests/registry.ollama.ai/library/$EXCLUDE_FAMILY"
if [[ -d "$excl_dir" ]] && [[ -n "$(ls -A "$excl_dir" 2>/dev/null)" ]]; then
  excl_blobs=$(grep -hoE 'sha256:[a-f0-9]{64}' "$excl_dir"/* 2>/dev/null | sed 's/sha256://' | sort -u)
  keep_blobs=$(find resources/models/manifests -type f -not -path "*/$EXCLUDE_FAMILY/*" \
               -exec grep -hoE 'sha256:[a-f0-9]{64}' {} + 2>/dev/null | sed 's/sha256://' | sort -u)
  unique_blobs=$(comm -23 <(echo "$excl_blobs") <(echo "$keep_blobs"))

  for f in "$excl_dir"/*; do
    [[ -f "$f" ]] && mv "$f" "$STASH/manifests/$EXCLUDE_FAMILY/"
  done
  while IFS= read -r h; do
    [[ -n "$h" ]] && mv "resources/models/blobs/sha256-$h" "$STASH/blobs/" 2>/dev/null || true
  done <<< "$unique_blobs"

  echo "    stashed $(ls "$STASH/manifests/$EXCLUDE_FAMILY" | wc -l | tr -d ' ') manifest(s), $(ls "$STASH/blobs" | wc -l | tr -d ' ') blob(s)"
else
  echo "    no $EXCLUDE_FAMILY models to stash"
fi

mv resources/ollama/ollama "$STASH/ollama-mac"

# ── 2. Get Windows ollama runtime ────────────────────────────────────────────
echo "==> [2/5] Fetching Windows ollama runtime"
if [[ -f "$OLLAMA_ZIP" ]] && unzip -t "$OLLAMA_ZIP" >/dev/null 2>&1; then
  echo "    using cached $OLLAMA_ZIP"
else
  echo "    downloading $OLLAMA_URL ..."
  curl -L --fail -o "$OLLAMA_ZIP" "$OLLAMA_URL"
fi

echo "==> [3/5] Extracting CPU-only runtime"
unzip -o "$OLLAMA_ZIP" \
  "ollama.exe" "vc_redist.x64.exe" \
  "lib/ollama/ggml-base.dll" "lib/ollama/ggml-cpu-*.dll" \
  -d resources/ollama/ >/dev/null
echo "    $(du -sh resources/ollama | cut -f1) total"

# ── 3. Build win-unpacked ────────────────────────────────────────────────────
echo "==> [4/5] Building win-unpacked (electron-builder --dir)"
rm -rf dist
npx next build >/dev/null 2>&1
npx electron-builder --win --x64 --dir 2>&1 | grep -E "•|warning|error" || true

[[ -d dist/win-unpacked ]] || { echo "ERROR: dist/win-unpacked was not produced." >&2; exit 1; }

# ── 4. Zip selectively ───────────────────────────────────────────────────────
echo "==> [5/5] Creating zip(s)"

if [[ "$APP_FRESH" != "true" ]]; then
  echo "    app zip..."
  rm -f "$APP_ZIP"
  ( cd dist && zip -r0 -q "$(basename "$APP_ZIP")" win-unpacked -x "win-unpacked/resources/models/*" )
  echo "$APP_HASH" > "$APP_HASH_FILE"
  echo "      $(du -sh "$APP_ZIP" | cut -f1)"
fi

if [[ "$MODELS_FRESH" != "true" ]]; then
  echo "    models zip..."
  rm -f "$MODELS_ZIP"
  ( cd dist && zip -r0 -q "$(basename "$MODELS_ZIP")" win-unpacked/resources/models )
  echo "$MODELS_HASH" > "$MODELS_HASH_FILE"
  echo "      $(du -sh "$MODELS_ZIP" | cut -f1)"
fi

echo
echo "✓ Build complete"
[[ -f "$APP_ZIP"    ]] && echo "  $APP_ZIP    ($(du -sh "$APP_ZIP"    | cut -f1))"
[[ -f "$MODELS_ZIP" ]] && echo "  $MODELS_ZIP ($(du -sh "$MODELS_ZIP" | cut -f1))"
echo
echo "On Windows: extract BOTH zips into the same folder, then run"
echo "            win-unpacked/124 Chat Agent.exe"
