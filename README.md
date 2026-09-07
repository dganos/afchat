# Local AI Document Assistant

A fully offline desktop app that answers questions about your local documents. It runs an LLM locally via Ollama — no internet required.

## Requirements

- **Node.js** >= 18
- **Ollama** — download from [ollama.com/download](https://ollama.com/download)

## Installation

### 1. Clone and install

```bash
git clone <repo-url>
cd afchat
npm install
```

### 2. Set up Ollama and the model

```bash
# Pull the model
ollama pull deepseek-r1:1.5b

# Copy model files into the project
cp -r ~/.ollama/models ./resources/models

# Copy the Ollama binary into the project
mkdir -p ./resources/ollama

# Linux/macOS:
cp $(which ollama) ./resources/ollama/ollama
chmod +x ./resources/ollama/ollama

# Windows:
# Copy ollama.exe to ./resources/ollama/ollama.exe
```

### 3. Add your documents

Put your files (`.md`, `.txt`, `.json`, etc.) into `resources/documents/`.

A sample `example.md` is already included for testing.

## Running the App

```bash
npm start
```

This builds the UI and launches the Electron app. On startup it will:
1. Start the bundled Ollama server
2. Start the API server on port 3001
3. Wait for both to be ready
4. Open the chat window

### Development mode

```bash
npm run dev
```

Runs Next.js dev server and Electron concurrently with hot reload.

### Manual development (separate terminals)

```bash
# Terminal 1 — Ollama
ollama serve

# Terminal 2 — API server
DOCS_PATH=./resources/documents node api/chat.js

# Terminal 3 — Electron
npx electron .
```

## Using the App

1. Type a question in the input field at the bottom
2. The assistant searches your documents automatically — you'll see tool badges appear:
   - **listFiles** — browsing available documents
   - **searchText** — searching for keywords
   - **readFile** — reading a specific file
3. The answer streams in with formatted markdown and code highlighting
4. Press **Enter** to send, **Shift+Enter** for a new line

### Example questions

- "What documents do you have?"
- "What are the system requirements?"
- "How do I install the application?"
- "What should I do if the app fails to start?"

## Building an Installer

```bash
npm run build
```

Produces a standalone installer:

| Platform | Output |
|----------|--------|
| Linux | `dist/Document Assistant.AppImage` |
| Windows | `dist/Document Assistant Setup.exe` |
| macOS | `dist/Document Assistant.dmg` |

Copy to a USB drive and run on any machine. No internet needed.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_PATH` | `./resources/documents` | Path to your document folder |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Ollama server address |
| `OLLAMA_MODELS` | `./resources/models` | Path to model files |

### Changing the model

Edit `api/chat.js`:

```js
const MODEL = 'deepseek-r1:1.5b'  // Change to any Ollama-supported model
```

Then pull the new model with `ollama pull <model-name>` and copy the updated model files to `resources/models/`.

### Changing the system prompt

Edit the `SYSTEM_PROMPT` constant in `api/chat.js`.

### Adding your own documents

Drop files into `resources/documents/`. The assistant picks them up immediately — no restart needed. Supported formats: any text-based file (`.md`, `.txt`, `.csv`, `.json`, `.xml`, `.html`, etc.).

## Troubleshooting

### App won't start

- Check that `resources/ollama/ollama` exists and is executable (`chmod +x`)
- Check that `resources/models/` contains model files (run `ollama pull deepseek-r1:1.5b` and copy again)
- Check the terminal for `[ollama]` log output

### "Service not ready" error

The app waits up to 20 seconds for Ollama and the API server to start. If your machine is slow, the timeout may be too short. Edit `main.js` and increase the `retries` parameter in `waitForPort()`.

### Model gives wrong answers

- Make sure your documents are in `resources/documents/`
- Try asking "what documents do you have?" to verify the assistant can see your files
- Large files are truncated at 8000 characters — split long documents into smaller files

### Port already in use

If port 3001 or 11434 is already in use, kill the existing process:

```bash
# Find and kill process on port 3001
lsof -ti:3001 | xargs kill
# Find and kill process on port 11434
lsof -ti:11434 | xargs kill
```

## License

Private — not licensed for redistribution.

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
