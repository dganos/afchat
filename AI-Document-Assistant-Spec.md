# Local AI Document Assistant — Claude Code Specification

## Overview

Build a fully offline, air-gapped desktop application that allows users to ask questions about a local document library. The app uses an LLM running locally to agentically search and read documents — the model decides what to look for rather than using pre-built RAG/vector search.

## Architecture

```
Electron App
├── main.js                  ← starts Ollama + Node API, opens window
├── api/
│   └── chat.js              ← Node.js HTTP server, AI SDK + tools
├── renderer/
│   ├── index.html           ← Electron loads this
│   ├── src/
│   │   ├── index.jsx        ← React entry point
│   │   ├── index.css        ← Tailwind + Streamdown styles
│   │   └── App.jsx          ← Chat UI
├── resources/               ← bundled assets (not in git, set up manually)
│   ├── ollama/
│   │   └── ollama           ← Ollama binary (platform-specific)
│   ├── models/              ← model files copied from ~/.ollama/models
│   └── documents/           ← user's document library
│       └── example.md
├── package.json
└── vite.config.js
```

## Data Flow

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

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop shell | Electron | Packages app, spawns subprocesses |
| LLM runtime | Ollama (Go binary) | Runs the model locally |
| Model | deepseek-r1:8b | Reasoning + tool calling |
| API server | Node.js http module | Bridge between UI and Ollama |
| AI SDK | ai + ollama-ai-provider | Tool calling, streaming protocol |
| Frontend framework | React 18 | UI |
| Chat hook | @ai-sdk/react useChat | Manages messages, streaming state |
| Markdown renderer | streamdown + @streamdown/code | Renders streamed markdown beautifully |
| Styling | Tailwind CSS | UI styling |
| Bundler | Vite | Compiles React for Electron renderer |
| Packager | electron-builder | Produces installer for air-gapped device |

## Prerequisites & Setup

### Required npm packages

```json
{
  "dependencies": {
    "ai": "^4.0.0",
    "@ai-sdk/react": "^1.0.0",
    "ollama-ai-provider": "^1.0.0",
    "streamdown": "^2.0.0",
    "@streamdown/code": "^2.0.0",
    "zod": "^3.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "concurrently": "^8.0.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^3.0.0",
    "autoprefixer": "^10.0.0",
    "postcss": "^8.0.0"
  }
}
```

### Resources setup (done once on dev machine, not in git)

```bash
# Pull model
ollama pull deepseek-r1:8b

# Copy model files into project
cp -r ~/.ollama/models ./resources/models

# Download Ollama binary from https://ollama.com/download
# Place at ./resources/ollama/ollama (Linux/macOS) or ./resources/ollama/ollama.exe (Windows)
chmod +x ./resources/ollama/ollama   # Linux/macOS only

# Add sample documents
mkdir -p ./resources/documents
```

## File Specifications

### package.json

```json
{
  "name": "local-ai-docs",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "concurrently \"vite build --watch --config vite.config.js\" \"electron .\"",
    "build": "vite build && electron-builder",
    "dev": "electron ."
  },
  "build": {
    "appId": "com.company.local-ai-docs",
    "productName": "Document Assistant",
    "extraResources": [
      { "from": "resources/ollama", "to": "ollama" },
      { "from": "resources/models", "to": "models" },
      { "from": "resources/documents", "to": "documents" }
    ],
    "linux": {
      "target": "AppImage",
      "category": "Utility"
    },
    "win": {
      "target": "nsis"
    },
    "mac": {
      "target": "dmg"
    }
  }
}
```

### vite.config.js

Configure Vite to build the React renderer into `renderer/dist/`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'renderer',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  base: './'
})
```

### tailwind.config.js

```js
module.exports = {
  content: [
    './renderer/src/**/*.{js,jsx}',
    './node_modules/streamdown/dist/**/*.js'
  ],
  theme: { extend: {} },
  plugins: []
}
```

### postcss.config.js

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
```

### .gitignore

```
node_modules/
resources/models/
resources/ollama/
renderer/dist/
dist/
.env
```

### main.js — Electron entry point

Responsibilities:

* Resolve resource paths correctly in both dev and packaged modes
* Start Ollama as a child process with `OLLAMA_MODELS` pointing to bundled models
* Start the Node API server (`api/chat.js`)
* Poll both services until ready before opening the window
* Kill all child processes on app quit
* Set `webSecurity: false` so renderer can fetch localhost APIs

```js
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

let ollamaProcess = null

function getResourcePath(subpath) {
  return app.isPackaged
    ? path.join(process.resourcesPath, subpath)
    : path.join(__dirname, 'resources', subpath)
}

async function waitForPort(url, retries = 40, intervalMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(url)
      return true
    } catch {
      await new Promise(r => setTimeout(r, intervalMs))
    }
  }
  throw new Error(`Service not ready: ${url}`)
}

function startOllama() {
  const bin = getResourcePath(
    process.platform === 'win32' ? 'ollama/ollama.exe' : 'ollama/ollama'
  )
  ollamaProcess = spawn(bin, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_MODELS: getResourcePath('models'),
      OLLAMA_HOST: '127.0.0.1:11434'
    }
  })
  ollamaProcess.stdout.on('data', d => console.log('[ollama]', d.toString()))
  ollamaProcess.stderr.on('data', d => console.log('[ollama]', d.toString()))
}

app.whenReady().then(async () => {
  startOllama()

  // Pass documents path to the API server via env
  process.env.DOCS_PATH = getResourcePath('documents')

  // Start API server
  require('./api/chat.js')

  // Wait for both services to be ready before opening window
  await Promise.all([
    waitForPort('http://localhost:11434'),
    waitForPort('http://localhost:3001/health')
  ])

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false  // Required: allows renderer to call localhost APIs
    }
  })

  // Load compiled renderer in packaged mode, or vite dev server in dev
  win.loadFile(path.join(__dirname, 'renderer/dist/index.html'))
})

app.on('before-quit', () => {
  if (ollamaProcess) ollamaProcess.kill()
})
```

### api/chat.js — Node.js API server

A plain `http.createServer` server on port 3001. No Express.

```js
const http = require('http')
const path = require('path')
const fs = require('fs')
const { createOllama } = require('ollama-ai-provider')
const { streamText } = require('ai')
const { z } = require('zod')

const MODEL = 'deepseek-r1:8b'
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
const ollama = createOllama({ baseURL: 'http://localhost:11434/api' })

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful assistant with access to a document library.
When answering questions, ALWAYS search the documents first. Never answer from your
training knowledge alone when the answer could be in the documents. Use listFiles to
understand what documents exist, searchText to find relevant sections, and readFile to
read full content. Always cite which document and section your answer comes from.
If you cannot find the answer in the documents, say so clearly.`

// ── Tools ────────────────────────────────────────────────────────────────────

// Helper: recursive directory walk, returns relative file paths
function walkDir(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap(e => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory()
      ? walkDir(path.join(dir, e.name), rel)
      : [rel]
  })
}

// Helper: validate path stays within DOCS_PATH (security)
function safePath(filepath) {
  const resolved = path.resolve(DOCS_PATH, filepath)
  if (!resolved.startsWith(path.resolve(DOCS_PATH))) {
    throw new Error('Access denied: path outside documents directory')
  }
  return resolved
}

const tools = {
  listFiles: {
    description: 'List all documents available in the document library. Use this first to understand what documents exist before searching or reading.',
    parameters: z.object({
      directory: z.string().describe('Directory to list. Use "." for the root documents folder.')
    }),
    execute: async ({ directory }) => {
      try {
        const targetDir = directory === '.' ? DOCS_PATH : safePath(directory)
        const files = walkDir(targetDir)
        return { files, count: files.length }
      } catch (err) {
        return { error: err.message }
      }
    }
  },

  readFile: {
    description: 'Read the full content of a specific document file. Use when you need to find detailed information in a file.',
    parameters: z.object({
      filepath: z.string().describe('Path to the file relative to the documents folder, e.g. "manual.md" or "subdir/specs.md"')
    }),
    execute: async ({ filepath }) => {
      try {
        const fullPath = safePath(filepath)
        if (!fs.existsSync(fullPath)) {
          return { error: `File not found: ${filepath}` }
        }
        const content = fs.readFileSync(fullPath, 'utf-8')
        const MAX_CHARS = 8000
        return {
          filepath,
          content: content.slice(0, MAX_CHARS),
          truncated: content.length > MAX_CHARS,
          totalLength: content.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },

  searchText: {
    description: 'Search for a keyword or phrase across all documents. Returns matching lines with their source file and line number.',
    parameters: z.object({
      query: z.string().describe('Text to search for. Case-insensitive.')
    }),
    execute: async ({ query }) => {
      try {
        const results = []
        const files = walkDir(DOCS_PATH)
        for (const file of files) {
          const fullPath = path.join(DOCS_PATH, file)
          const content = fs.readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              results.push({ file, line: i + 1, text: line.trim() })
            }
          })
        }
        return {
          query,
          matches: results.slice(0, 30),
          total: results.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers — required for Electron renderer to call this
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (req.method === 'POST' && req.url === '/chat') {
    // Parse request body
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })

    try {
      const result = streamText({
        model: ollama(MODEL),
        system: SYSTEM_PROMPT,
        messages: body.messages,
        tools,
        maxSteps: 10  // Allow up to 10 tool call rounds per response
      })

      // pipeDataStreamToResponse sends the full AI SDK stream protocol
      // useChat on the frontend understands this natively — no extra config needed
      result.pipeDataStreamToResponse(res)

    } catch (err) {
      console.error('[api] error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(3001, () => {
  console.log('[api] listening on http://localhost:3001')
})
```

### renderer/index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Document Assistant</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/index.jsx"></script>
</body>
</html>
```

### renderer/src/index.jsx

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

### renderer/src/index.css

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Required for Streamdown utility class detection */
@source "../../../node_modules/streamdown/dist";
```

### renderer/src/App.jsx — Chat UI

Full implementation:

```jsx
import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { useEffect, useRef } from 'react'
import 'streamdown/styles.css'

// ── Tool call badge shown while model is searching/reading ──────────────────

function ToolCallBadge({ toolName, state }) {
  const icons = {
    listFiles: '📁',
    readFile: '📄',
    searchText: '🔍'
  }
  const icon = icons[toolName] || '🔧'
  const isDone = state === 'result'

  return (
    <div className={`
      inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full my-1
      ${isDone
        ? 'bg-gray-100 text-gray-500'
        : 'bg-blue-50 text-blue-600 animate-pulse'}
    `}>
      <span>{icon}</span>
      <span className="font-mono">{toolName}</span>
      <span>{isDone ? '✓' : '...'}</span>
    </div>
  )
}

// ── Single message bubble ────────────────────────────────────────────────────

function Message({ message, isStreaming }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex mb-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`
        ${isUser
          ? 'max-w-[75%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2'
          : 'w-full'
        }
      `}>
        {/* Render each part of the message */}
        {message.parts?.map((part, i) => {
          // Tool invocation badge
          if (part.type === 'tool-invocation') {
            return (
              <ToolCallBadge
                key={i}
                toolName={part.toolInvocation.toolName}
                state={part.toolInvocation.state}
              />
            )
          }

          // Text content
          if (part.type === 'text') {
            if (isUser) {
              return <span key={i}>{part.text}</span>
            }
            return (
              <Streamdown
                key={i}
                plugins={{ code }}
                isAnimating={isStreaming}
                animated
              >
                {part.text}
              </Streamdown>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: 'http://localhost:3001/chat'
  })

  const isStreaming = status === 'streaming'
  const bottomRef = useRef(null)

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="flex flex-col h-screen bg-white font-sans">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-white shadow-sm">
        <span className="text-xl">📚</span>
        <span className="font-semibold text-gray-800">Document Assistant</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
            <span className="text-5xl">📂</span>
            <p className="text-lg">Ask me anything about your documents</p>
            <p className="text-sm">I'll search and read them to find your answer</p>
          </div>
        )}

        {/* Message list */}
        {messages.map(msg => (
          <Message
            key={msg.id}
            message={msg}
            isStreaming={isStreaming && msg === messages[messages.length - 1]}
          />
        ))}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 border-t bg-white flex gap-2"
      >
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about your documents..."
          disabled={isStreaming}
          className="
            flex-1 border rounded-xl px-4 py-2
            focus:outline-none focus:ring-2 focus:ring-blue-500
            disabled:opacity-50 disabled:cursor-not-allowed
          "
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim()}
          className="
            bg-blue-600 text-white px-5 py-2 rounded-xl font-medium
            hover:bg-blue-700 transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
          "
        >
          {isStreaming ? '...' : 'Send'}
        </button>
      </form>

    </div>
  )
}
```

### resources/documents/example.md — Sample document for testing

```markdown
# Product Manual

## Chapter 1: Installation Requirements

### System Requirements
- Operating System: Windows 10 or later, Ubuntu 20.04 or later
- RAM: Minimum 8GB, recommended 16GB
- Storage: At least 10GB free space
- Processor: Intel Core i5 or equivalent

### Installation Steps
1. Download the installer from the provided USB drive
2. Run the installer as administrator
3. Follow the on-screen instructions
4. Restart the system after installation

## Chapter 2: Configuration

### Initial Setup
After installation, launch the application and complete the setup wizard.
You will need to configure the following:
- License key (provided separately)
- Network settings
- User preferences

## Chapter 3: Troubleshooting

### Common Issues
If the application fails to start, check the following:
1. Ensure all system requirements are met
2. Verify the license key is valid
3. Check the log files at C:\ProgramData\AppName\logs
4. Contact support if the issue persists
```

## Running in Development

```bash
# Terminal 1 — run Ollama (uses system ~/.ollama/models)
ollama serve

# Terminal 2 — build renderer + watch for changes
npx vite build --watch --config vite.config.js

# Terminal 3 — start the API server
DOCS_PATH=./resources/documents node api/chat.js

# Terminal 4 — start Electron
npx electron .
```

Or simply: `npm start` (uses concurrently to run all at once)

## Building the Installer

```bash
# Step 1: Build the React renderer
npx vite build

# Step 2: Package everything
npx electron-builder
```

Output files:
* Linux: `dist/Document Assistant.AppImage`
* Windows: `dist/Document Assistant Setup.exe`
* macOS: `dist/Document Assistant.dmg`

Copy the output file to USB → run on air-gapped device. No internet required.

## Important Implementation Notes

### 1. Path resolution in packaged vs dev mode

`app.isPackaged` is false during `electron .` and true in the built installer. Always use `getResourcePath()` for anything in `resources/`.

### 2. Tool security

Always validate that file paths stay within `DOCS_PATH` using `path.resolve` comparison. Prevent path traversal attacks like `../../etc/passwd`.

### 3. Ollama binary permissions

On Linux/macOS, `chmod +x resources/ollama/ollama` before running `electron-builder`. The executable bit must be set or Ollama won't start.

### 4. Windows platform detection

Use `process.platform === 'win32'` to pick `ollama.exe` vs `ollama`.

### 5. Context window management

`deepseek-r1:8b` has a limited context window (~8192 tokens). The `readFile` tool truncates at 8000 characters. If a document is truncated, the model sees `truncated: true` and can use `searchText` to find specific sections instead of reading the whole file.

### 6. maxSteps is critical

`maxSteps: 10` in `streamText` allows multiple rounds of tool calling per response. Without this, the model stops after the first tool call and cannot chain `listFiles → searchText → readFile`.

### 7. pipeDataStreamToResponse

This method sends the full Vercel AI SDK streaming protocol. The `useChat` hook on the frontend understands this natively — no `streamProtocol: 'text'` override needed, and all features (tool invocations, metadata) work out of the box.

## File Checklist

Claude Code should create all of the following files:

- [ ] `package.json`
- [ ] `main.js`
- [ ] `vite.config.js`
- [ ] `tailwind.config.js`
- [ ] `postcss.config.js`
- [ ] `.gitignore`
- [ ] `api/chat.js`
- [ ] `renderer/index.html`
- [ ] `renderer/src/index.jsx`
- [ ] `renderer/src/index.css`
- [ ] `renderer/src/App.jsx`
- [ ] `resources/documents/example.md`

## Testing Checklist

After Claude Code implements all files, verify:

1. `npm install` completes without errors
2. `npm start` launches without errors
3. Ollama starts and model loads (check terminal logs for `[ollama]`)
4. API health check responds: `curl http://localhost:3001/health` → `ok`
5. Sending "what documents do you have?" shows 📁 listFiles badge then lists files
6. Sending a question about the example doc shows 🔍 and 📄 badges before the answer
7. Answer renders with Streamdown markdown formatting
8. Code blocks in answers have syntax highlighting with copy button
9. Conversation history works across multiple messages
10. `npm run build` produces an installer in `dist/`
