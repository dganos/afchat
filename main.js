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

  // Load compiled Next.js static export
  win.loadFile(path.join(__dirname, 'out/index.html'))
})

app.on('before-quit', () => {
  if (ollamaProcess) ollamaProcess.kill()
})
