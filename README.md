# Local AI Document Assistant

A fully offline, air-gapped desktop application that lets you ask questions about a local document library. Uses a locally-running LLM (deepseek-r1:8b via Ollama) to agentically search and read documents — the model decides what to look for rather than using pre-built RAG/vector search.

## Architecture

```
Electron App
├── main.js                          ← starts Ollama + Node API, opens window
├── api/
│   └── chat.js                      ← Node.js HTTP server, AI SDK + tools
├── app/                             ← Next.js app directory (static export)
│   ├── layout.jsx                   ← Root layout
│   ├── page.jsx                     ← Chat UI (AI Elements + Streamdown)
│   └── globals.css                  ← Tailwind + shadcn CSS variables
├── components/
│   ├── ai-elements/                 ← Chat UI components
│   │   ├── conversation.jsx         ← Auto-scrolling chat container
│   │   ├── message.jsx              ← Message bubbles with avatars
│   │   ├── prompt-input.jsx         ← Input with auto-resize textarea
│   │   └── tool.jsx                 ← Collapsible tool call badges
│   └── ui/                          ← shadcn/ui base components
│       ├── button.jsx
│       ├── collapsible.jsx
│       └── scroll-area.jsx
├── lib/
│   └── utils.js                     ← cn() utility
├── resources/                       ← bundled assets (not in git)
│   ├── ollama/                      ← Ollama binary (platform-specific)
│   ├── models/                      ← Model files from ~/.ollama/models
│   └── documents/                   ← Your document library
│       └── example.md
├── package.json
├── next.config.js
└── tailwind.config.js
```

## How It Works

```
User types question in React UI
        ↓
useChat (Vercel AI SDK) POSTs to http://localhost:3001/chat
        ↓
api/chat.js receives messages, calls streamText with tools
        ↓
deepseek-r1:8b model thinks, decides what documents to read
        ↓
Model calls tools: listFiles → searchText → readFile
        ↓
Model streams final answer back
        ↓
Streamdown renders markdown answer with animations in UI
```

The model has access to three tools:

| Tool | Description |
|------|-------------|
| `listFiles` | Lists all documents in the library |
| `searchText` | Searches for keywords across all documents (case-insensitive) |
| `readFile` | Reads full content of a specific file (truncated at 8000 chars) |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron |
| LLM runtime | Ollama (bundled binary) |
| Model | deepseek-r1:8b |
| API server | Node.js `http` module (port 3001) |
| AI SDK | `ai` + `ollama-ai-provider` (tool calling, streaming) |
| Frontend | React 18 + Next.js (static export) |
| Chat state | `@ai-sdk/react` `useChat` hook |
| Chat UI | AI Elements pattern (Conversation, Message, Tool, PromptInput) |
| UI components | shadcn/ui (Button, ScrollArea, Collapsible) |
| Markdown | Streamdown + @streamdown/code (animated streaming) |
| Styling | Tailwind CSS + shadcn CSS variables |
| Packager | electron-builder |

## Prerequisites

- **Node.js** >= 18
- **Ollama** installed on your dev machine (`ollama.com/download`)
- **deepseek-r1:8b** model pulled: `ollama pull deepseek-r1:8b`

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up resources (one-time, not in git)

```bash
# Pull the model if you haven't already
ollama pull deepseek-r1:8b

# Copy model files into project
cp -r ~/.ollama/models ./resources/models

# Download Ollama binary for your platform from https://ollama.com/download
# Place at:
#   Linux/macOS: ./resources/ollama/ollama
#   Windows:     ./resources/ollama/ollama.exe
mkdir -p ./resources/ollama
# cp /path/to/ollama ./resources/ollama/ollama
chmod +x ./resources/ollama/ollama   # Linux/macOS only
```

### 3. Add your documents

Place your documents (`.md`, `.txt`, `.json`, etc.) in `resources/documents/`. A sample `example.md` is included.

## Running

### Quick start (build + launch)

```bash
npm start
```

This runs `next build` to compile the renderer, then launches Electron.

### Development (separate terminals)

```bash
# Terminal 1 — run Ollama
ollama serve

# Terminal 2 — build Next.js and watch for changes
npx next dev

# Terminal 3 — start the API server
DOCS_PATH=./resources/documents node api/chat.js

# Terminal 4 — start Electron
npx electron .
```

### Dev mode (concurrent)

```bash
npm run dev
```

## Building an Installer

```bash
npm run build
```

Output files:
- **Linux**: `dist/Document Assistant.AppImage`
- **Windows**: `dist/Document Assistant Setup.exe`
- **macOS**: `dist/Document Assistant.dmg`

Copy the output file to a USB drive and run on an air-gapped device. No internet required.

## Adding Pages

Next.js file-based routing makes it easy to add new pages:

```
app/
├── page.jsx           ← / (Chat - existing)
├── settings/
│   └── page.jsx       ← /settings
├── documents/
│   └── page.jsx       ← /documents
└── history/
    └── page.jsx       ← /history
```

Just create a folder with a `page.jsx` file — it automatically becomes a route.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_PATH` | `./resources/documents` | Path to your document library |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Ollama server address |
| `OLLAMA_MODELS` | `./resources/models` | Path to bundled model files |

### Customizing the Model

Edit `api/chat.js` line 7:

```js
const MODEL = 'deepseek-r1:8b'  // Change to any Ollama-supported model
```

### Customizing the System Prompt

Edit the `SYSTEM_PROMPT` constant in `api/chat.js` to change how the assistant behaves.

## Key Implementation Details

- **Air-gapped**: Everything runs locally — Ollama binary, model weights, and documents are all bundled
- **Path security**: All file access is validated to stay within `DOCS_PATH` (prevents path traversal)
- **Context window**: `readFile` truncates at 8000 chars; the model can use `searchText` for targeted lookups
- **Multi-step tool calling**: `maxSteps: 10` allows the model to chain `listFiles → searchText → readFile`
- **Streaming protocol**: `pipeDataStreamToResponse` sends the full Vercel AI SDK protocol; `useChat` understands it natively
- **Static export**: Next.js builds to plain HTML/JS/CSS in `out/` — no server at runtime, just Electron loading static files

## Project Structure

```
.
├── api/chat.js                     # HTTP server + AI SDK tools
├── app/                            # Next.js pages
│   ├── globals.css                 # Tailwind + theme variables
│   ├── layout.jsx                  # Root HTML layout
│   └── page.jsx                    # Chat page
├── components/
│   ├── ai-elements/                # Chat-specific components
│   └── ui/                         # shadcn/ui primitives
├── lib/utils.js                    # Utility functions
├── resources/documents/            # Your documents go here
├── main.js                         # Electron entry point
├── next.config.js                  # Next.js config (static export)
├── tailwind.config.js              # Tailwind + shadcn theme
├── postcss.config.js               # PostCSS config
├── components.json                 # shadcn/ui config
├── jsconfig.json                   # Path aliases (@/)
└── package.json                    # Dependencies + scripts
```

## License

Private — not licensed for redistribution.
