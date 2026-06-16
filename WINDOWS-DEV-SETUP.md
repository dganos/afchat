# Aristo — Windows dev-box setup (for the Claude Code agent on that machine)

You are setting up and running **Aristo** (a document-QA desktop app) on a Windows
dev machine (~16 GB RAM, has internet, **no USB**). This box mirrors the air-gapped
production machine, but here you can install things from the internet. Your job:
get the app running, verify it works, and report any problems. Work top to bottom;
stop and ask the user if a step can't complete.

## What this project is
- **Aristo** (repo root): an Electron + Next.js app. Backend API in `api/chat.js`
  (port 3001), UI in `app/` + `components/`, Electron entry `main.js`. It answers
  questions grounded in local documents using a local LLM via **Ollama**.
- The **agent** (model + system prompt + tool contracts + runtime) is the single
  source of truth at **`packages/gemma4-qa/`** — `package.json` + `system_prompt.md`.
  Do NOT hardcode prompts/tools anywhere; everything comes from that package.
- Documents the app answers over live in **`resources/documents/`** (now tracked in
  git — pull to get them).
- `afchat_lab/` is the Python evaluation harness (optional for app dev).

## Prerequisites (install from the internet if missing)
1. **Node.js LTS** (v18+). Verify: `node -v`, `npm -v`.
2. **Ollama for Windows** — download/run the official installer from
   https://ollama.com/download . After install it runs a background service on
   `http://localhost:11434`. Verify: `curl http://localhost:11434/api/version`
   (or open it in a browser). Installing via the official installer gives you the
   COMPLETE runtime + inference DLLs — do NOT hand-copy DLLs.
3. **git** (already used to clone).

## Steps
1. **Pull the latest code + docs**
   ```
   git pull
   ```
   Confirm `resources/documents/` now contains `yanshuf-*.md` (the corpus). If it's
   empty, the docs commit didn't reach you — tell the user.

2. **Install JS dependencies** (from the repo root)
   ```
   npm install
   ```

3. **Ensure the model is in Ollama**
   The app needs the tag **`gemma-4-e4b:latest`**. Check:
   ```
   ollama list
   ```
   - If `gemma-4-e4b:latest` is listed → good, continue.
   - If it is NOT listed → it's the project's ~4.8 GB gemma4 model. It is **not in
     git** (too large for free LFS) and is **not on the public registry**, so it
     must be imported from its GGUF file. If you have the GGUF on this box, import:
     ```
     # Modelfile (point FROM at the .gguf)
     FROM C:\path\to\gemma-4-e4b.gguf
     TEMPLATE """{{ .Prompt }}"""
     RENDERER gemma4
     PARSER gemma4
     PARAMETER stop "<turn|>"
     ```
     ```
     ollama create gemma-4-e4b:latest -f Modelfile
     ```
     If you do NOT have the GGUF on this machine, **stop and ask the user** how to
     obtain it (it can't come via USB here).
   - Confirm it generates: `ollama run gemma-4-e4b:latest "say OK"` (first run loads
     the model and may take 30-60 s on a cold start).

4. **Run the app (dev mode)** from the repo root:
   ```
   npm run dev
   ```
   This starts the Next dev server (`:3000`), the API server (`:3001`), and Electron.
   `main.js` detects there's no bundled Ollama runtime here and **uses the
   system-installed Ollama** on `:11434` automatically. On startup the API warms up
   the model (loads it at the package's 32k context) — the window shows a loader
   ("טוען את המודל…") with the input disabled until it's ready, then enables.

5. **Verify it works** (this is the main deliverable — confirm each):
   - The startup loader appears, then the input enables once the model is warm.
   - Ask (Hebrew): `מהאף ועד קצה הזנב, כמה ארוך המסוק?` → the answer should contain
     **19.76 מטר**. (The agent should call `list_directory` then `search_content`.)
   - While generating, a live timer ticks; when the answer arrives, the elapsed time
     stays **pinned above the answer bubble**.
   - Click **מסמכים** (Documents) in the header → single-click a document → a modal
     opens showing its full content.
   - Subsequent questions are fast (model stays resident); the first may be slower
     only if the warm-up was skipped.

## Troubleshooting
- **"missing inference DLLs" / Ollama won't run inference** — that's a *bundled*
  runtime problem; on this dev box you use the system Ollama, so just (re)install
  Ollama for Windows from the official installer, which includes all DLLs.
- **Model not found** — see step 3 (import from GGUF).
- **Port already in use (3000/3001/11434)** — stop the stale process or close other
  instances, then `npm run dev` again.
- **First answer very slow** — the model was loading (cold start). It stays resident
  after; only an idle eviction would reload it.

## Notes / boundaries
- Don't put the **model** or large binaries in git from this box.
- The agent definition is `packages/gemma4-qa/` — if you change the prompt or tools,
  edit it there (both the app and the lab read it); don't duplicate logic in
  `api/chat.js`.
- The **air-gapped USB bundle** is built on a **Mac** via `scripts/build-windows.sh`
  (it produces `Aristo-Windows-app.zip` + `Aristo-Windows-models.zip`). This dev box
  is for development/verification, not for producing that bundle.
