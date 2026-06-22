# Aristo — Windows bundle validation (for the Claude Code agent on the validation box)

**Goal:** prove the self-contained production **bundle** runs on a clean Windows box
with **nothing else installed** — no Node.js, no npm, no separately-installed Ollama.
Production deploys this exact bundle, so the validation must mirror that: extract and
run, nothing more. (Do **not** `git clone` + `npm run dev` here — that's a developer
path, not what ships.)

## What the bundle is
Two zips, built on a Mac by `scripts/build-windows.sh`:
- **`Aristo-Windows-app.zip`** (~800 MB) — the packaged app: Electron, the API server,
  the **bundled Ollama runtime** (`resources/ollama/ollama.exe` + `lib/ollama/*.dll`),
  and the documents (`resources/documents/`).
- **`Aristo-Windows-models.zip`** (~3.6 GB) — the gemma4 model (`resources/models/`).

They contain no overlapping files and **merge into one `win-unpacked/` folder** when
extracted to the same location. The result is fully self-contained: the app spawns its
own bundled Ollama and loads the bundled model — the box needs no internet and no other
software.

## Steps
0. **Do NOT install Node, npm, or Ollama.** The whole point is to confirm the bundle is
   self-sufficient. (Validating on a box that has Ollama installed would hide a missing
   dependency — if anything, uninstall/stop a system Ollama first so `:11434` is free.)

1. **Download the bundle from the GitHub Release** `win-bundle-20260616` in
   `dganos/afchat`. The model is split into parts (GitHub caps assets at 2 GiB). With
   the GitHub CLI authenticated:
   ```
   gh release download win-bundle-20260616 -R dganos/afchat -D bundle
   ```
   You should get, in `bundle\`: `Aristo-Windows-app.zip`,
   `Aristo-Windows-models.zip.part00`, `.part01`, `.part02`. (No `gh`? Download the 4
   assets from the Release page in a browser.)

2. **Reassemble the model zip** (cmd, inside `bundle\`):
   ```
   copy /b Aristo-Windows-models.zip.part00 + Aristo-Windows-models.zip.part01 + Aristo-Windows-models.zip.part02 Aristo-Windows-models.zip
   ```
   Optional integrity check against the Release notes' sha256:
   `certutil -hashfile Aristo-Windows-models.zip SHA256`

3. **Extract BOTH zips into the same folder**, e.g. `C:\Aristo\`. After extracting both
   you should have `C:\Aristo\win-unpacked\` containing `Aristo.exe` and a `resources\`
   folder with `ollama\`, `models\`, and `documents\`.

   Sanity check before launching:
   - `win-unpacked\resources\ollama\ollama.exe` exists
   - `win-unpacked\resources\ollama\lib\ollama\` contains ~45+ `*.dll` files
     (ggml-base.dll, ggml-cpu-*.dll, …). **If `lib\ollama` is missing or nearly empty,
     the bundle is bad** — report it; it needs a rebuild.
   - `win-unpacked\resources\models\` is populated (manifests + blobs, ~4.8 GB)
   - `win-unpacked\resources\documents\` has the `yanshuf-*.md` files

4. **Launch** `win-unpacked\Aristo.exe`.

## What "seamless" looks like (verify each)
- The window opens; on startup it shows a loader (**"טוען את המודל…"**) with the input
  disabled while the **bundled** Ollama loads the model, then the input enables. (No
  system Ollama is needed — the app started its own.)
- Ask (Hebrew): `מהאף ועד קצה הזנב, כמה ארוך המסוק?` → the answer contains **19.76 מטר**.
  (Behind the scenes it calls `list_directory` then `search_content`.)
- While generating, a live timer ticks; when the answer arrives the elapsed time stays
  **pinned above the answer bubble**.
- Click **מסמכים** (Documents) in the header → single-click a document → a modal shows
  its full content.
- Ask a second question → it's fast (the model stays resident).
- The in-app logs panel shows `[ollama]` and `[api]` lines (e.g. `warmed up model …`,
  `using agent-package model: gemma-4-e4b:latest`).

## Report back
State clearly: did it launch and answer correctly from the bundle alone? Note anything
that required manual intervention (that's a seamlessness gap). Specifically flag:
- "bundled ollama is incomplete / missing inference DLLs" → the bundle was built before
  the `lib/ollama` fix; it must be rebuilt on the Mac.
- a "**vcruntime140.dll / msvcp140.dll** missing" error → the bundle ships these runtime
  DLLs in `lib\ollama`, but if Windows still can't find them, install the **Microsoft
  Visual C++ 2015–2022 x64 Redistributable** once (the box has internet). Flag it.
- model didn't load / out-of-memory → note the RAM and any Ollama error from the logs.
- any step where you had to install or configure something — production can't do that.

## Boundaries
- This box only **validates**; the bundle is **built on a Mac** (`scripts/build-windows.sh`).
- Don't add Node/Ollama/npm to make it work — if it needs them, that's the finding.
