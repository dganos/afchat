const { spawn } = require('child_process')
const path = require('path')

const OLLAMA_BIN = path.join(__dirname, 'resources', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
const MODELS_PATH = path.join(__dirname, 'resources', 'models')
const DOCS_PATH = path.join(__dirname, 'resources', 'documents')

// Run our OWN bundled Ollama on a private port (never the system default 11434),
// serving only the bundled models — the app must never touch a system Ollama.
const OLLAMA_PORT = process.env.ARISTO_OLLAMA_PORT || '11435'

// Start Ollama
const ollama = spawn(OLLAMA_BIN, ['serve'], {
  env: {
    ...process.env,
    OLLAMA_MODELS: MODELS_PATH,
    OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
    // 2, not 1: keep gemma AND the small bge-m3 embedder resident so the semantic
    // supplement doesn't evict/reload the chat model each search (see main.js).
    OLLAMA_MAX_LOADED_MODELS: '2',
    // Flash Attention — faster decode/prefill on Apple Silicon; off by default.
    OLLAMA_FLASH_ATTENTION: '1'
  }
})
ollama.stdout.on('data', d => console.log('[ollama]', d.toString().trimEnd()))
ollama.stderr.on('data', d => console.log('[ollama]', d.toString().trimEnd()))

// Start API server (pin it to our private Ollama port)
process.env.DOCS_PATH = DOCS_PATH
process.env.ARISTO_OLLAMA_PORT = OLLAMA_PORT
process.env.ARISTO_DATA_DIR = process.env.ARISTO_DATA_DIR || path.join(__dirname, '.data')
require('./api/chat.js')

// Clean up on exit
process.on('SIGINT', () => { ollama.kill(); process.exit() })
process.on('SIGTERM', () => { ollama.kill(); process.exit() })
