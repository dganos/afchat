# Aristo — offline document QA

A fully offline desktop app (Electron + Next.js) that answers questions about
your local documents, in your language (Hebrew-first). It runs open LLMs
locally through a **bundled, private Ollama** — no internet, no cloud, no
telemetry.

## How it works

- **Agentic answering**: the model is never handed your documents wholesale.
  It works with three read-only tools — `list_directory` (a catalog of every
  document's title + section headings), `search_content` (structure-aware
  grep: matches return their whole table/paragraph with a heading breadcrumb,
  ranked by BM25 on wide searches), and `read_text_file` — iterating up to 8
  steps until it can give a grounded answer with a file citation.
- **Semantic supplement**: a local embedding model (`bge-m3`) indexes the
  corpus so searches also surface passages that match by *meaning* — e.g. a
  question wording in Hebrew finding a value labeled in English. The index is
  built explicitly from the Documents panel (with progress) and invalidates
  automatically when documents change.
- **The agent package** (`packages/gemma4-qa/`) is the single source of truth
  for everything the agent *is*: model, system prompt, tool contracts, runtime
  knobs, and error-recovery policy. The app and the benchmark lab
  (`afchat_lab/`) both load the same package, so lab results predict
  production behavior (**SAME AGENT rule** — never tune agent behavior
  anywhere else).
- **Model menu**: the package's `agentic_models` list is exactly what the user
  can choose from. Models ship as standalone release assets; installed ones
  are selectable, missing ones appear greyed with a download hint.

Current menu: `gemma-4-e4b` (custom build, validated at 91% on the internal
50-question benchmark), `qwen3:30b-a3b` and `gemma4:26b-a4b-it-qat` (24 GB-VRAM
targets, validation per `afchat_lab/Z4-VALIDATION.md`).

## Repository layout

| Path | What |
|---|---|
| `main.js`, `preload.js` | Electron shell; spawns the bundled Ollama on a private port |
| `api/chat.js` | The API server (port 3001): agent loop, tools, embeddings, model management |
| `app/`, `components/` | Next.js UI (chat, documents panel, settings, model picker) |
| `packages/gemma4-qa/` | **The agent package** — model id, prompts, tools, runtime + recovery policy |
| `resources/` | Runtime resources: `documents/`, `models/` (Ollama store), `ollama/` (runtime) |
| `afchat_lab/` | Benchmark lab: 50Q document-QA benchmark, judge, candidate models, RAG experiments |
| `scripts/` | Build + release tooling (see Releasing below) |

## Requirements (development)

- **Node.js ≥ 18**
- **Ollama runtime + models staged under `resources/`** — `resources/ollama`
  and `resources/models` may be real dirs or symlinks to a shared store. The
  production model `gemma-4-e4b` is a **custom build distributed via the
  GitHub release assets** (not the public registry); `bge-m3` comes from the
  registry (`ollama pull bge-m3`).

## Running

```bash
npm install
npm run dev        # Next.js dev server + Electron, hot reload
# or
npm start          # production build + Electron
```

Startup sequence: bundled Ollama on a **private port (11435** — never the
system default, so a system Ollama is never touched) → API server on 3001 →
model warm-up (weights + prompt prefix; the UI blocks input until ready) →
window.

## Using the app

- Ask questions in the chat; tool badges show the agent working (עיון בתיקייה /
  חיפוש במסמכים / קריאת קובץ). Answers stream with the reasoning collapsible.
- **Documents panel**: upload (`.md`, `.txt`, `.pdf`, `.docx`, and other text
  formats — legacy `.doc` is rejected), delete, and build the **semantic
  index** (status chip: עדכני / דורש בנייה / נבנה…). Grep-based search works
  without the index; semantic matching and best quality need it fresh.
- **Model picker** (top bar): shows the package menu with installed state;
  switching evicts the old model and eager-loads the new one (the embedder
  stays resident).
- **Settings**: speed check (tokens/sec gauge), system-prompt editor (runtime
  override of the package prompt), clear history. Context meter supports
  Claude-style compaction of long conversations.

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DOCS_PATH` | `./resources/documents` | Documents folder |
| `ARISTO_OLLAMA_PORT` | `11435` | Private port for the bundled Ollama |
| `ARISTO_DATA_DIR` | app userData | Writable dir for user edits (e.g. prompt override) |
| `ARISTO_NUM_THREAD` | unset | Per-machine CPU thread override (tune with the tps bench) |
| `ARISTO_KV_CACHE_TYPE` | `f16` on Apple Silicon, `q8_0` elsewhere | KV-cache quantization (hardware-dependent; measured) |

### Changing the model / prompt / tools

Edit **the agent package** (`packages/gemma4-qa/package.json` +
`system_prompt.md`) — never the app code. The package also carries the
error-recovery policy (empty-turn nudge, refusal-pointer nudge, max-steps
final answer) shared verbatim with the lab; cross-runtime conformance tests
(`api/loop-conformance.test.js`, `afchat_lab/tests/test_loop_conformance.py`)
keep the two loops from drifting.

## The lab (`afchat_lab/`)

A benchmark harness that runs the *same agent* over a 32-document Hebrew
corpus with 50 questions, judged by a hosted LLM (judge only — all production
inference is local/open). Use it for any retrieval or model change:
qualify on the 10Q subset first, then the full 50Q; scores wobble ±4 pts, so
decide on stable per-question deltas. See `afchat_lab/README.md`,
`Z4-VALIDATION.md` (new-hardware model validation), and the classic-RAG
pipeline (`harness/rag_eval.py`) kept as a lab experiment.

## Releasing (checklist)

The app and the models ship as **separate assets in one GitHub release**: the
installer contains no chat models; each model is its own download, and the app's
model picker shows the full menu (installed models selectable, missing ones
greyed with a download hint). Details: [RELEASE-ASSETS.md](RELEASE-ASSETS.md).

### 1. Build the model assets (any machine with the models pulled)

- [ ] `python3 scripts/package-model-assets.py`
      → `dist/Aristo-model-*.zip[.partNN]` + `.sha256` for every model in the
      package's `agentic_models` menu, plus the **required** core zip (bge-m3).

### 2. Build the installer (on Windows)

- [ ] `git pull`
- [ ] `powershell -File scripts\build-windows-on-windows.ps1 -SkipModels`
      → `dist\Aristo-Setup-<ver>.exe` (no models inside; the build stage-checks
      the menu models and warns if any is missing from the local store — that's
      fine with `-SkipModels`).

### 3. Publish

- [ ] Create the GitHub release; upload the installer **and** every
      `Aristo-model-*` file (parts + `.sha256` sidecars).
      `scripts/upload-release-assets.ps1` auto-discovers `dist\` assets and
      streams multi-GB files reliably.
- [ ] Paste the operator instructions from
      [RELEASE-ASSETS.md](RELEASE-ASSETS.md) into the release notes
      (rejoin command, extract into `resources\models`, restart).

### 4. Smoke-test an install

- [ ] Run the installer on a clean machine, extract the core zip + ONE model
      zip into `<install>\resources\models`, start Aristo.
- [ ] Picker shows all menu models; only the installed one is selectable.
- [ ] Ask a document question (grounded answer with a file citation), then
      stop an answer mid-stream and ask again (should respond at normal speed —
      the log line `client disconnected mid-response` confirms the abort fired).

### Model promotion (when the Z4 validation picks a winner)

- [ ] Run the 50Q on the target hardware per
      [afchat_lab/Z4-VALIDATION.md](afchat_lab/Z4-VALIDATION.md) (bar: ≥ 89–91%).
- [ ] Set `model.id` in `packages/gemma4-qa/package.json` to the winner.
- [ ] Re-run steps 1–4.

## Troubleshooting

- **App starts but can't answer**: no allowlisted model installed — the error
  names the model packages to download; extract into `resources/models`.
- **"Not enough free RAM" on model load**: close other apps, or pick a smaller
  menu model; the picker shows a fit indicator per model.
- **Semantic search seems off / RAG-quality answers missing values**: check the
  Documents panel — if the index chip says דורש בנייה, build it.
- **A response seems stuck**: check the API log; `client disconnected
  mid-response` means an abort was handled (normal). A genuinely wedged Ollama
  shows in `[ollama]` log lines.
- **Ports in use** (3000/3001/11435): kill leftovers —
  `lsof -ti:3001 | xargs kill`.

## License

Private — not licensed for redistribution.
