#!/usr/bin/env bash
# Build a Windows x64 portable zip of 124 Chat Agent on macOS.
#
# Output: dist/124-Chat-Agent-Windows.zip
# Usage:  ./scripts/build-windows.sh           # incremental — skip if up-to-date
#         BUILD_FORCE=1 ./scripts/build-windows.sh   # force rebuild
#
# Hash-based cache:
#   - Hashes all build inputs (source, configs, kept model manifests, this script)
#   - Stores result in .build-cache/win-zip.sha256
#   - Skips the entire build if the hash matches the previous successful build
#   - Override with BUILD_FORCE=1 or by deleting the cache file

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STASH="$ROOT/.build-stash"
CACHE_DIR="$ROOT/.build-cache"
HASH_FILE="$CACHE_DIR/win-zip.sha256"
OLLAMA_ZIP="${TMPDIR:-/tmp}/ollama-win.zip"
OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip"
EXCLUDE_FAMILY="gemma4"   # model family to leave out of the build
OUTPUT_ZIP="$ROOT/dist/124-Chat-Agent-Windows.zip"
SCRIPT_PATH="scripts/build-windows.sh"

[[ "$(uname)" == "Darwin" ]] || { echo "ERROR: this script must run on macOS." >&2; exit 1; }

# ── Hash all build inputs ────────────────────────────────────────────────────
# Ollama blobs are content-addressed (sha256 in filename), so hashing the
# manifests captures any model-content change. We don't hash the blob files
# themselves — that would mean re-reading 4 GB on every script run.
compute_input_hash() {
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

  {
    [[ ${#existing[@]} -gt 0 ]] && find "${existing[@]}" -type f
    find resources/models/manifests -type f -not -path "*/$EXCLUDE_FAMILY/*"
  } 2>/dev/null \
    | sort -u \
    | tr '\n' '\0' \
    | xargs -0 shasum -a 256 2>/dev/null \
    | sort \
    | shasum -a 256 \
    | awk '{print $1}'
}

mkdir -p "$CACHE_DIR"
INPUT_HASH=$(compute_input_hash)

if [[ "${BUILD_FORCE:-}" == "1" ]]; then
  echo "==> BUILD_FORCE=1 — skipping cache check"
elif [[ -f "$HASH_FILE" && -f "$OUTPUT_ZIP" && "$INPUT_HASH" == "$(cat "$HASH_FILE")" ]]; then
  size=$(du -sh "$OUTPUT_ZIP" | cut -f1)
  echo "✓ $OUTPUT_ZIP is up-to-date  ($size)"
  echo "  Inputs unchanged since last build (hash: ${INPUT_HASH:0:12}…)"
  echo "  Force rebuild with: BUILD_FORCE=1 $0"
  exit 0
fi

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
  if [[ $code -eq 0 ]]; then
    echo "    done"
  else
    echo "    done (build failed with exit $code)"
  fi
}
trap restore EXIT

# ── Pre-flight ───────────────────────────────────────────────────────────────
free_gb=$(df -g "$ROOT" | awk 'NR==2 {print $4}')
if (( free_gb < 15 )); then
  echo "WARNING: only ${free_gb} GB free. Build needs ~15 GB headroom." >&2
fi

# ── 1. Stash gemma4 models ───────────────────────────────────────────────────
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

if [[ ! -d dist/win-unpacked ]]; then
  echo "ERROR: dist/win-unpacked was not produced." >&2
  exit 1
fi

# ── 4. Zip it up ─────────────────────────────────────────────────────────────
echo "==> [5/5] Creating zip"
( cd dist && zip -r0 -q "$(basename "$OUTPUT_ZIP")" win-unpacked )

# Persist the input hash only on success — a failed build leaves the previous
# hash intact so the next run still rebuilds.
echo "$INPUT_HASH" > "$HASH_FILE"

size=$(du -sh "$OUTPUT_ZIP" | cut -f1)
echo
echo "✓ Build complete"
echo "  $OUTPUT_ZIP  ($size)"
echo "  cache hash: ${INPUT_HASH:0:12}…"
echo
echo "On Windows: extract the zip, run 124 Chat Agent.exe inside."
