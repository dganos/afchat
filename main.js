const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

let ollamaProcess = null
let mainWindow = null
const earlyLogs = []

// The app runs its OWN bundled Ollama on a private port and serves models only
// from its bundled store — it must never touch a system-installed Ollama. We
// avoid the default 11434 on purpose: if the user has their own Ollama there, a
// shared port would let the app silently bind-fail and talk to theirs instead.
const OLLAMA_PORT = process.env.ARISTO_OLLAMA_PORT || '11435'
const OLLAMA_BASE = `http://localhost:${OLLAMA_PORT}`

// KV-cache quantization is HARDWARE-DEPENDENT — gate it, don't hardcode. q8_0 halves
// the 32k KV footprint and wins on RAM-tight CPU-only targets (the 8 GB Intel
// air-gapped box: +9–18% tok/s and no memory-pressure swap stalls), but REGRESSES
// generation ~48% on Apple Silicon (Metal has no optimized q8_0-KV kernel — it
// dequantizes the KV cache every token on the GPU), where f16 at 32k fits fine
// anyway (measured M1 Pro: 42→22 tok/s with q8_0). Default per platform; override
// per machine with ARISTO_KV_CACHE_TYPE after checking the aristo-tps-bench skill.
const KV_CACHE_TYPE = process.env.ARISTO_KV_CACHE_TYPE ||
  ((process.platform === 'darwin' && process.arch === 'arm64') ? 'f16' : 'q8_0')

function sendLog(source, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', source, text)
  } else {
    earlyLogs.push({ source, text })
  }
}

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
  // The bundled runtime is required — we never fall back to a system Ollama, so
  // that the app only ever uses its own binary, port, and bundled models. If the
  // binary is missing this is a hard, visible failure (the API health check will
  // fail and the window surfaces it) rather than a silent hand-off to the user's
  // own Ollama.
  if (!fs.existsSync(bin)) {
    const msg = `[ollama] FATAL: bundled runtime not found at ${bin} — the app cannot start its own Ollama.`
    console.error(msg)
    sendLog('ollama', msg + '\n')
    return
  }
  ollamaProcess = spawn(bin, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_MODELS: getResourcePath('models'),
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      // Keep up to two models resident: the chat model (gemma, ~4.5 GB) AND the
      // small embedder (bge-m3, ~1.2 GB) used by search_content's semantic
      // supplement. At 1, every semantic lookup evicted gemma and forced a cold
      // reload on the next turn. Both fit together on 16 GB (~5.7 GB). CAVEAT: on
      // the 8 GB air-gapped target this is tight with swap disabled — if the
      // embedder can't load there, the semantic supplement degrades to
      // lexical-only (search_content catches the embed failure), so it won't
      // crash, but keeping 2 resident on 8 GB needs validation.
      OLLAMA_MAX_LOADED_MODELS: '2',
      // Flash Attention: faster decode (~+15%) and prefill on Apple Silicon, and
      // it is off by default in Ollama. Measured net win for our doc-QA workload.
      OLLAMA_FLASH_ATTENTION: '1',
      // Hardware-gated KV cache type (see KV_CACHE_TYPE above): f16 on Apple Silicon,
      // q8_0 on CPU-only/RAM-tight targets; per-machine override via ARISTO_KV_CACHE_TYPE.
      OLLAMA_KV_CACHE_TYPE: KV_CACHE_TYPE,
      // Keep the (single) model resident indefinitely so an idle pause never
      // triggers a cold reload mid-session. The API server warms it up at startup
      // so the first question is fast too. before-quit unloads it.
      OLLAMA_KEEP_ALIVE: '-1'
    }
  })
  ollamaProcess.stdout.on('data', d => {
    const text = d.toString()
    console.log('[ollama]', text)
    sendLog('ollama', text)
  })
  ollamaProcess.stderr.on('data', d => {
    const text = d.toString()
    console.log('[ollama]', text)
    sendLog('ollama', text)
  })
}

app.whenReady().then(async () => {
  startOllama()

  // Pass documents path + the private Ollama port to the API server via env, so
  // it talks to our bundled Ollama and never the system default port.
  process.env.DOCS_PATH = getResourcePath('documents')
  process.env.ARISTO_OLLAMA_PORT = OLLAMA_PORT
  // Writable dir for user edits (e.g. the system-prompt override) — userData is
  // writable in both dev and packaged builds (the bundled resources are not).
  process.env.ARISTO_DATA_DIR = app.getPath('userData')

  // Intercept console to capture API logs
  const origLog = console.log
  const origError = console.error
  console.log = (...args) => {
    origLog(...args)
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (text.startsWith('[api]')) sendLog('api', text)
  }
  console.error = (...args) => {
    origError(...args)
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (text.startsWith('[api]')) sendLog('api', text)
  }

  // Start API server
  require('./api/chat.js')

  const isDev = !app.isPackaged

  // Wait for backends — and in dev, also wait for the Next dev server.
  const waits = [
    waitForPort(OLLAMA_BASE),
    waitForPort('http://localhost:3001/health')
  ]
  if (isDev) waits.push(waitForPort('http://localhost:3000'))
  // A backend that never comes up must not leave the user staring at nothing:
  // create the window regardless so the failure is visible (the API server
  // surfaces its own errors, e.g. a missing agent package) instead of silent.
  try {
    await Promise.all(waits)
  } catch (err) {
    console.error('[main] backend not ready, opening window anyway:', err.message)
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,  // Required: allows renderer to call localhost APIs
      preload: path.join(__dirname, 'preload.js')
    }
  })

  if (isDev) {
    // Live next-dev server — HMR works, no rebuild needed for UI edits.
    mainWindow.loadURL('http://localhost:3000')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // Packaged build serves the static export.
    mainWindow.loadFile(path.join(__dirname, 'out/index.html'))
  }

  // Flush early logs once page is ready
  mainWindow.webContents.on('did-finish-load', () => {
    earlyLogs.forEach(({ source, text }) => {
      mainWindow.webContents.send('log', source, text)
    })
    earlyLogs.length = 0
  })
})

app.on('before-quit', () => {
  if (ollamaProcess) ollamaProcess.kill()
})
