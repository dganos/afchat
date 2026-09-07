#!/usr/bin/env python3
"""Build STANDALONE model release assets: one zip per model + a required core zip.

Distribution model: the Aristo installer ships with NO chat models; each model in
the agent package's `agentic_models` becomes its own GitHub release asset, and the
end user downloads only the one(s) they choose. bge-m3 (the embedding model behind
semantic search) is required by every install, so it gets its own `core` zip.

Each zip contains store-relative paths (manifests/... + blobs/...), so extracting
it into the app's `resources/models` directory installs the model. Blobs are
resolved per-model from its manifest, so a zip is self-contained.

Usage (from the repo root; models must be present in the local store):
    python3 scripts/package-model-assets.py                 # all package models + core
    python3 scripts/package-model-assets.py gemma-4-e4b:latest   # just one
    MODELS_DIR=/path/to/ollama-models python3 scripts/package-model-assets.py

Outputs to dist/: Aristo-model-<safe-name>.zip (+ .sha256 sidecars).
Zips over 1.9GB are split with `split -b 1900m` into .partNN files (GitHub's
2GB/asset limit); `cat *.part* > file.zip` (or PowerShell Get-Content -Raw ...)
rejoins them — same convention the existing bundle uses.
"""

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("MODELS_DIR", ROOT / "resources" / "models"))
DIST = ROOT / "dist"
SPLIT_BYTES = 1900 * 1024 * 1024  # < GitHub's 2GB asset cap

CORE_MODELS = []  # filled from package embed_model


def manifest_path(model_id: str) -> Path:
    name, _, tag = model_id.partition(":")
    tag = tag or "latest"
    # hf.co/... ids live under manifests/<host>/<org>/<repo>/<tag>
    if "/" in name:
        return MODELS_DIR / "manifests" / Path(name) / tag
    return MODELS_DIR / "manifests" / "registry.ollama.ai" / "library" / name / tag


def model_files(model_id: str) -> list[Path]:
    mf = manifest_path(model_id)
    if not mf.exists():
        raise SystemExit(f"model '{model_id}' is not in the store ({mf}) — pull it first")
    m = json.loads(mf.read_text())
    digests = [l["digest"] for l in m.get("layers", [])]
    if m.get("config", {}).get("digest"):
        digests.append(m["config"]["digest"])
    files = [mf] + [MODELS_DIR / "blobs" / d.replace(":", "-") for d in digests]
    for f in files:
        if not f.exists():
            raise SystemExit(f"missing blob for {model_id}: {f}")
    return files


def safe_name(model_id: str) -> str:
    return model_id.replace("hf.co/", "").replace("/", "_").replace(":", "-")


def build_zip(model_ids: list[str], out_name: str) -> Path:
    DIST.mkdir(exist_ok=True)
    out = DIST / out_name
    files: list[Path] = []
    seen: set[Path] = set()
    for mid in model_ids:            # resolve first — a missing model must not leave a stub zip
        for f in model_files(mid):
            if f not in seen:
                seen.add(f)
                files.append(f)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:  # blobs are already compressed
        for f in files:
            z.write(f, f.relative_to(MODELS_DIR).as_posix())
    return out


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def finalize(out: Path) -> None:
    (out.with_suffix(out.suffix + ".sha256")).write_text(f"{sha256(out)}  {out.name}\n")
    size = out.stat().st_size
    if size > SPLIT_BYTES:
        subprocess.run(["split", "-b", "1900m", str(out), str(out) + ".part"], check=True)
        out.unlink()
        parts = sorted(DIST.glob(out.name + ".part*"))
        print(f"  {out.name}: {size/1e9:.2f} GB → {len(parts)} parts (<2GB each)")
    else:
        print(f"  {out.name}: {size/1e9:.2f} GB")


def main() -> None:
    pkg = json.loads((ROOT / "packages" / "gemma4-qa" / "package.json").read_text())
    embed_id = (pkg.get("embed_model") or {}).get("id")
    wanted = sys.argv[1:] or pkg.get("agentic_models", [])
    print(f"store: {MODELS_DIR}")
    print(f"models: {wanted} | core (required): {embed_id}")
    for mid in wanted:
        try:
            out = build_zip([mid], f"Aristo-model-{safe_name(mid)}.zip")
            finalize(out)
        except SystemExit as e:
            print(f"  SKIP {mid}: {e}")
    if embed_id and not sys.argv[1:]:
        try:
            out = build_zip([embed_id], "Aristo-model-core-embeddings.zip")
            finalize(out)
        except SystemExit as e:
            print(f"  SKIP core: {e}")
    print("done — upload dist/Aristo-model-* as release assets "
          "(end user: extract chosen zip(s) into resources\\models)")


if __name__ == "__main__":
    main()
