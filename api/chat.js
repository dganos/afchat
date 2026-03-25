const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createOllama } = require('ollama-ai-provider')
const { streamText } = require('ai')
const { z } = require('zod')
const mammoth = require('mammoth')
const pdfParse = require('pdf-parse')

let currentModel = 'qwen3:1.7b'
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
const ollama = createOllama({ baseURL: 'http://localhost:11434/api' })
// ollama-ai-provider v1.2.0 streaming doesn't parse tool_calls from Ollama's
// response (only tries to infer them from text content). With thinking models
// like qwen3 the tool calls come in a structured field that the stream parser
// ignores. simulateStreaming uses the non-streaming API (which handles
// tool_calls correctly) and wraps the result in a stream for the AI SDK.
const ollamaModel = (name) => ollama(name, { simulateStreaming: true })

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
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


  console.log(`[api] ${req.method} ${req.url}`)

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

    const msgCount = body.messages?.length || 0
    const lastMsg = body.messages?.[msgCount - 1]
    console.log(`[api] chat request: ${msgCount} messages, last from ${lastMsg?.role}`)

    try {
      const result = streamText({
        model: ollamaModel(currentModel),
        system: SYSTEM_PROMPT,
        messages: body.messages,
        tools,
        maxSteps: 10  // Allow up to 10 tool call rounds per response
      })

      // pipeDataStreamToResponse sends the full AI SDK stream protocol
      // useChat on the frontend understands this natively — no extra config needed
      result.pipeDataStreamToResponse(res)
      res.on('finish', () => {
        console.log(`[api] response stream complete (${res.statusCode})`)
      })

    } catch (err) {
      console.error('[api] error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ── Model Management ─────────────────────────────────────────────────────

  // List available models with RAM info
  if (req.method === 'GET' && req.url === '/models') {
    try {
      const ollamaRes = await fetch('http://localhost:11434/api/tags')
      const data = await ollamaRes.json()

      const totalRAM = os.totalmem()
      const freeRAM = os.freemem()

      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null,
        family: m.details?.family || null,
        fitsInRAM: m.size < freeRAM * 0.9,
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        currentModel,
        models,
        memory: {
          total: totalRAM,
          free: freeRAM,
        }
      }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Select a model
  if (req.method === 'POST' && req.url === '/models/select') {
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })

    if (!body.model) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing model field' }))
      return
    }

    const freeRAM = os.freemem()

    // Check if model exists in Ollama
    try {
      const ollamaRes = await fetch('http://localhost:11434/api/tags')
      const data = await ollamaRes.json()
      const match = (data.models || []).find(m => m.name === body.model)

      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Model "${body.model}" not found. Pull it first with: ollama pull ${body.model}` }))
        return
      }

      const fitsInRAM = match.size < freeRAM * 0.9
      if (!fitsInRAM) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'Model does not fit in available RAM',
          modelSize: match.size,
          freeRAM
        }))
        return
      }

      currentModel = body.model
      console.log(`[api] model switched to: ${currentModel}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, model: currentModel, fitsInRAM }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ── Document Management ──────────────────────────────────────────────────

  // Read document content
  if (req.method === 'GET' && req.url.startsWith('/documents/') && req.url.endsWith('/content')) {
    const filename = decodeURIComponent(req.url.slice('/documents/'.length, -'/content'.length))
    try {
      const fullPath = safePath(filename)
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'File not found' }))
        return
      }

      const ext = path.extname(filename).toLowerCase()
      let content = ''

      if (ext === '.pdf') {
        const buf = fs.readFileSync(fullPath)
        const data = await pdfParse(buf)
        content = data.text
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: fullPath })
        content = result.value
      } else {
        content = fs.readFileSync(fullPath, 'utf-8')
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ filename, content }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // List all documents
  if (req.method === 'GET' && req.url === '/documents') {
    try {
      const files = walkDir(DOCS_PATH).map(f => {
        const stat = fs.statSync(path.join(DOCS_PATH, f))
        return { name: f, size: stat.size, modified: stat.mtime }
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ files }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Upload a document (multipart/form-data is complex — use raw body with filename header)
  if (req.method === 'POST' && req.url === '/documents') {
    const filename = req.headers['x-filename']
    if (!filename) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing X-Filename header' }))
      return
    }

    try {
      const dest = safePath(filename)
      const dir = path.dirname(dest)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        fs.writeFileSync(dest, Buffer.concat(chunks))
        console.log(`[api] document uploaded: ${filename}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, filename }))
      })
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Delete a document
  if (req.method === 'DELETE' && req.url.startsWith('/documents/')) {
    const filename = decodeURIComponent(req.url.slice('/documents/'.length))
    try {
      const fullPath = safePath(filename)
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'File not found' }))
        return
      }
      fs.unlinkSync(fullPath)
      console.log(`[api] document deleted: ${filename}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, filename }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
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
