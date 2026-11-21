// Aristo background server: our own bundled Ollama (private port) + the API, which
// also serves the built web app (out/) and the admin endpoints. Run it with
// `npm run serve` (foreground) or scripts/aristo.ps1 start (hidden, background).
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const logs = require('./api/log-buffer')

const OLLAMA_BIN = path.join(__dirname, 'resources', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
const MODELS_PATH = path.join(__dirname, 'resources', 'models')
const DOCS_PATH = path.join(__dirname, 'resources', 'documents')
const DATA_DIR = process.env.ARISTO_DATA_DIR || path.join(__dirname, '.data')
const PID_FILE = path.join(DATA_DIR, 'aristo.pid')

// Run our OWN bundled Ollama on a private port (never the system default 11434),
// serving only the bundled models — the app must never touch a system Ollama.
const OLLAMA_PORT = process.env.ARISTO_OLLAMA_PORT || '11435'

// KV-cache type is HARDWARE-DEPENDENT: q8_0 wins on RAM-tight CPU-only targets but
// regresses generation ~48% on Apple Silicon (Metal dequantizes the KV cache every
// token). Default f16 on Apple Silicon, q8_0 elsewhere; override per machine with
// ARISTO_KV_CACHE_TYPE after benching (aristo-tps-bench skill).
const KV_CACHE_TYPE = process.env.ARISTO_KV_CACHE_TYPE ||
  ((process.platform === 'darwin' && process.arch === 'arm64') ? 'f16' : 'q8_0')

logs.setLogFile(path.join(DATA_DIR, 'logs', 'aristo.log'))

// Mirror console output into the log buffer (api source), keep printing it too.
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => {
    orig(...args)
    const text = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a))).join(' ')
    if (!text.startsWith('[ollama]')) logs.push('api', text)
  }
}

let ollama = null
let ollamaStartedAt = null
let stopping = false

function startOllama() {
  if (!fs.existsSync(OLLAMA_BIN)) {
    console.error(`[server] FATAL: bundled Ollama not found at ${OLLAMA_BIN}`)
    return
  }
  ollama = spawn(OLLAMA_BIN, ['serve'], {
    windowsHide: true,
    env: {
      ...process.env,
      OLLAMA_MODELS: MODELS_PATH,
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      // 2, not 1: keep gemma AND the small bge-m3 embedder resident so the semantic
      // supplement doesn't evict/reload the chat model each search.
      OLLAMA_MAX_LOADED_MODELS: '2',
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE: KV_CACHE_TYPE,
      // Keep the model resident so an idle pause never triggers a cold reload.
      OLLAMA_KEEP_ALIVE: '-1',
    },
  })
  ollamaStartedAt = Date.now()
  const onData = d => { process.stdout.write(`[ollama] ${d}`); logs.push('ollama', d.toString()) }
  ollama.stdout.on('data', onData)
  ollama.stderr.on('data', onData)
  const proc = ollama
  ollama.on('error', e => console.error('[server] ollama failed to start:', e.message))
  ollama.on('exit', (code) => {
    if (proc !== ollama) return          // an intentional restart replaced it
    ollama = null
    if (!stopping) console.error(`[server] ollama exited (code ${code})`)
  })
}

function stopOllama() {
  return new Promise(resolve => {
    const proc = ollama
    if (!proc) return resolve()
    ollama = null
    proc.once('exit', () => resolve())
    proc.kill()
    setTimeout(resolve, 5000)
  })
}

async function shutdown() {
  if (stopping) return
  stopping = true
  console.log('[server] shutting down')
  await stopOllama()
  try { fs.unlinkSync(PID_FILE) } catch {}
  process.exit(0)
}

// Handed to the API (admin endpoints) — the API never manages processes itself.
globalThis.aristoSupervisor = {
  startedAt: Date.now(),
  ollamaPort: OLLAMA_PORT,
  logFile: path.join(DATA_DIR, 'logs', 'aristo.log'),
  ollamaStatus: () => ({ running: !!ollama, pid: ollama?.pid ?? null, startedAt: ollamaStartedAt }),
  restartOllama: async () => { await stopOllama(); startOllama() },
  shutdown,
}

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.writeFileSync(PID_FILE, String(process.pid))

startOllama()

// Start API server (pin it to our private Ollama port)
process.env.DOCS_PATH = DOCS_PATH
process.env.ARISTO_OLLAMA_PORT = OLLAMA_PORT
process.env.ARISTO_DATA_DIR = DATA_DIR
process.env.ARISTO_WEB_DIR = process.env.ARISTO_WEB_DIR || path.join(__dirname, 'out')
require('./api/chat.js')

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
