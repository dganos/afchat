const { spawn } = require('child_process')
const path = require('path')

const OLLAMA_BIN = path.join(__dirname, 'resources', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
const MODELS_PATH = path.join(__dirname, 'resources', 'models')
const DOCS_PATH = path.join(__dirname, 'resources', 'documents')

// Start Ollama
const ollama = spawn(OLLAMA_BIN, ['serve'], {
  env: {
    ...process.env,
    OLLAMA_MODELS: MODELS_PATH,
    OLLAMA_HOST: '127.0.0.1:11434'
  }
})
ollama.stdout.on('data', d => console.log('[ollama]', d.toString().trimEnd()))
ollama.stderr.on('data', d => console.log('[ollama]', d.toString().trimEnd()))

// Start API server
process.env.DOCS_PATH = DOCS_PATH
require('./api/chat.js')

// Clean up on exit
process.on('SIGINT', () => { ollama.kill(); process.exit() })
process.on('SIGTERM', () => { ollama.kill(); process.exit() })
