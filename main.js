const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

let ollamaProcess = null
let mainWindow = null
const earlyLogs = []

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
  ollamaProcess = spawn(bin, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_MODELS: getResourcePath('models'),
      OLLAMA_HOST: '127.0.0.1:11434',
      // Keep at most one model resident — this is an 8 GB air-gapped target,
      // two models swapping into RAM thrashes swap (which is disabled).
      OLLAMA_MAX_LOADED_MODELS: '1',
      // Flash Attention: faster decode (~+15%) and prefill on Apple Silicon, and
      // it is off by default in Ollama. Measured net win for our doc-QA workload.
      OLLAMA_FLASH_ATTENTION: '1',
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

  // Pass documents path to the API server via env
  process.env.DOCS_PATH = getResourcePath('documents')

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
    waitForPort('http://localhost:11434'),
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
