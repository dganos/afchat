const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

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

function lmsBin() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return process.platform === 'win32'
    ? path.join(home, '.lmstudio', 'bin', 'lms.exe')
    : path.join(home, '.lmstudio', 'bin', 'lms')
}

// Aristo runs on LM Studio's local server (OpenAI-compatible, port 1234). Unlike
// Ollama there's no single bundled binary to spawn-and-hold — `lms server start`
// launches LM Studio's server (idempotent) and returns. The model is loaded with
// its context window by the API server's /load endpoint, or JIT on first request.
function startLMStudio() {
  const p = spawn(lmsBin(), ['server', 'start'])
  const pipe = d => { const text = d.toString(); console.log('[lmstudio]', text); sendLog('ollama', text) }
  p.stdout.on('data', pipe)
  p.stderr.on('data', pipe)
}

app.whenReady().then(async () => {
  startLMStudio()

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
    waitForPort('http://localhost:1234/v1/models'),
    waitForPort('http://localhost:3001/health')
  ]
  if (isDev) waits.push(waitForPort('http://localhost:3000'))
  await Promise.all(waits)

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
  // Best-effort: stop the LM Studio server we started.
  try { spawn(lmsBin(), ['server', 'stop']) } catch {}
})
