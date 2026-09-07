# Release layout — standalone app + standalone models

One GitHub release carries everything; the operator downloads the installer plus
only the model(s) they want.

## Assets to upload

| Asset | Built by | Size | Required? |
|---|---|---|---|
| `Aristo-Setup-<ver>.exe` | `build-windows-on-windows.ps1 -SkipModels` (on Windows) | ~800 MB | ✅ always |
| `Aristo-model-core-embeddings.zip` (+`.sha256`) | `package-model-assets.py` | ~1.2 GB | ✅ always (bge-m3 — semantic search) |
| `Aristo-model-gemma-4-e4b-latest.zip.partaa/ab/ac` (+`.sha256`) | ″ | ~5.2 GB | one of the three |
| `Aristo-model-qwen3-30b-a3b.zip.part*` (+`.sha256`) | ″ | ~19 GB | one of the three |
| `Aristo-model-gemma4-26b-a4b-it-qat.zip.part*` (+`.sha256`) | ″ | ~16 GB | one of the three |

Model zips are STORED (uncompressed — GGUF doesn't compress) and split into
<2 GB `.partNN` files for GitHub's asset limit. The `.sha256` sidecar is the
checksum of the REJOINED zip.

## Operator install steps (put in the release notes)

1. Run `Aristo-Setup-<ver>.exe`.
2. Download `Aristo-model-core-embeddings.zip` and the model package(s) you want.
3. For split models, rejoin the parts (all parts in one folder):
   - PowerShell: `cmd /c copy /b Aristo-model-NAME.zip.part* Aristo-model-NAME.zip`
   - (optional) verify: `Get-FileHash Aristo-model-NAME.zip` vs the `.sha256` file
4. Extract the zip(s) **into `<install dir>\resources\models`** (the zip contains
   `manifests\...` and `blobs\...` at its root — extract as-is, no extra folder).
5. Start Aristo. The model picker shows all three menu models; the installed
   one(s) are selectable, the rest are greyed with a download hint. Adding a
   model later = repeat steps 2–4 and restart.

## Hardware guidance (for the release notes)

- `gemma-4-e4b` — the validated production model (91%); runs on modest hardware.
- `qwen3:30b-a3b` and `gemma4:26b-a4b-it-qat` — for 24 GB-VRAM GPUs (e.g. RTX
  A5000); pending final 50Q validation on that hardware (afchat_lab/Z4-VALIDATION.md).

## Build steps (maintainer)

```bash
# on the Mac (or any box with the models pulled into the store):
python3 scripts/package-model-assets.py            # all menu models + core → dist/
# on Windows:
powershell -File scripts\build-windows-on-windows.ps1 -SkipModels
# upload dist/Aristo-Setup-*.exe + dist/Aristo-model-* to the release
# (scripts/upload-release-assets.ps1 auto-discovers dist assets)
```
