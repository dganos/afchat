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
      OLLAMA_HOST: '127.0.0.1:11434'
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

  // Wait for both services to be ready before opening window
  await Promise.all([
    waitForPort('http://localhost:11434'),
    waitForPort('http://localhost:3001/health')
  ])

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

  // Load compiled Next.js static export
  mainWindow.loadFile(path.join(__dirname, 'out/index.html'))

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
