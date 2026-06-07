const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createOllama } = require('ollama-ai-provider')
const { streamText } = require('ai')
const { z } = require('zod')
const mammoth = require('mammoth')
const { PDFParse } = require('pdf-parse')

const { selectDefaultModel } = require('./model-selection')
const { availableMemory } = require('./available-memory')
const { loadPackage, resolveOllamaModel } = require('./agent-package')

// Default model is resolved lazily on the first request — Ollama may not be
// up yet when this module loads, and we want to pick from actually-installed
// models rather than a hardcoded name. We prefer the agent package's model when
// it is installed, otherwise fall back to auto-selection by RAM fit.
let currentModel = null

async function ensureCurrentModel() {
  if (currentModel) return currentModel
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    const data = await res.json()
    const fromPkg = resolveOllamaModel(data.models || [], AGENT.model && AGENT.model.id)
    currentModel = fromPkg || selectDefaultModel(os.totalmem(), data.models || [])
    if (fromPkg) console.log(`[api] using agent-package model: ${currentModel}`)
    else if (currentModel) console.log(`[api] package model not installed; auto-selected: ${currentModel}`)
    else console.warn('[api] no models installed — UI must pick one')
  } catch (err) {
    console.error('[api] could not auto-select model:', err.message)
  }
  return currentModel
}
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
const ollama = createOllama({ baseURL: 'http://localhost:11434/api' })
// ollama-ai-provider v1.2.0 streaming doesn't parse tool_calls from Ollama's
// response (only tries to infer them from text content). With thinking models
// like qwen3 the tool calls come in a structured field that the stream parser
// ignores. simulateStreaming uses the non-streaming API (which handles
// tool_calls correctly) and wraps the result in a stream for the AI SDK.
const ollamaModel = (name) => ollama(name, { simulateStreaming: true })

// ── Agent Package (model + system prompt + tools + runtime) ───────────────────

// Built-in fallback so the app still boots if no package file is present.
const FALLBACK_AGENT = {
  name: 'builtin-default',
  model: {},
  runtime: { max_steps: 10, max_tool_result_chars: 8000, temperature: 0 },
  tools: [{ name: 'list_directory' }, { name: 'read_text_file' }, { name: 'search_files' }],
  toolAllowlist: ['list_directory', 'read_text_file', 'search_files'],
  system_prompt: `You are a document-grounded assistant. You MUST ONLY answer based on the documents in your library — NEVER from your own knowledge. Use search_files to find passages and read_text_file to confirm values before answering, and answer in the same language as the question.`,
}

const AGENT = (() => {
  const file = process.env.AGENT_PACKAGE || path.join(__dirname, 'packages/gemma4-qa.json')
  try {
    const p = loadPackage(file)
    console.log(`[api] loaded agent package: ${p.name} (model=${p.model.id}, tools=${p.toolAllowlist.join(',')}, steps=${p.runtime.max_steps}, cap=${p.runtime.max_tool_result_chars})`)
    return p
  } catch (err) {
    console.warn(`[api] no agent package (${err.message}); using built-in default`)
    return FALLBACK_AGENT
  }
})()

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

// Helper: extract plain text from any supported file type. Reading PDFs/DOCX
// as utf-8 produces binary garbage, which then leaks into the model context.
async function extractText(fullPath) {
  const ext = path.extname(fullPath).toLowerCase()
  if (ext === '.pdf') {
    const buf = fs.readFileSync(fullPath)
    const parser = new PDFParse({ data: buf })
    const data = await parser.getText()
    return data.text
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: fullPath })
    return result.value
  }
  return fs.readFileSync(fullPath, 'utf-8')
}

// Registry keyed by the package's canonical tool names. The agent package's
// system prompt refers to these names, so the exposed tools must match them.
const TOOL_REGISTRY = {
  list_directory: {
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

  read_text_file: {
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
        const content = await extractText(fullPath)
        const cap = (AGENT.runtime && AGENT.runtime.max_tool_result_chars) || 8000
        if (content.length > cap) {
          // Visible truncation marker — matches the contract the package's system
          // prompt relies on, so the model knows the rest of the file wasn't shown.
          return {
            filepath,
            content: content.slice(0, cap) +
              `\n\n[TRUNCATED: showed the first ${cap} of ${content.length} characters; the rest of this file was NOT shown. Use search_files with a keyword from the question to locate the passage.]`,
            truncated: true,
            totalLength: content.length
          }
        }
        return { filepath, content, truncated: false, totalLength: content.length }
      } catch (err) {
        return { error: err.message }
      }
    }
  },

  search_files: {
    description: 'Search for text INSIDE files (content match, not file names). Multi-word queries are AND-matched at the document level: a document is included only if ALL terms appear somewhere in it. For each matching document the tool returns the best lines. After this, call read_text_file on the most likely document — do not assume information is absent based on search alone, because specs in tables often span multiple lines.',
    parameters: z.object({
      query: z.string().describe('Search terms. Case-insensitive. Multiple words are AND-matched across the whole document.')
    }),
    execute: async ({ query }) => {
      try {
        const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
        if (terms.length === 0) return { query, documents: [], total: 0 }

        const files = walkDir(DOCS_PATH)
        const documents = []
        for (const file of files) {
          const fullPath = path.join(DOCS_PATH, file)
          const content = await extractText(fullPath)
          const lower = content.toLowerCase()
          if (!terms.every(t => lower.includes(t))) continue

          const scored = []
          content.split('\n').forEach((line, i) => {
            const ll = line.toLowerCase()
            const hits = terms.filter(t => ll.includes(t)).length
            if (hits > 0) scored.push({ line: i + 1, text: line.trim(), hits })
          })
          scored.sort((a, b) => b.hits - a.hits || a.line - b.line)
          documents.push({
            file,
            topLines: scored.slice(0, 4).map(s => ({ line: s.line, text: s.text }))
          })
        }
        return { query, documents, total: documents.length }
      } catch (err) {
        return { error: err.message }
      }
    }
  }
}

// Expose only the tools the agent package allowlists (under the package's names).
const tools = Object.fromEntries(
  AGENT.toolAllowlist.filter(n => TOOL_REGISTRY[n]).map(n => [n, TOOL_REGISTRY[n]])
)
const unknownTools = AGENT.toolAllowlist.filter(n => !TOOL_REGISTRY[n])
if (unknownTools.length) console.warn(`[api] agent package references tools with no implementation: ${unknownTools.join(', ')}`)

// ── Auto Pre-Search ──────────────────────────────────────────────────────────

// Extract keywords from a user message and search documents automatically
async function autoSearch(userMessage) {
  // Remove common stop words, keep meaningful terms
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'and', 'or', 'not', 'no', 'my', 'your', 'i', 'me', 'it', 'this', 'that', 'all', 'any', 'about', 'tell', 'give', 'show', 'find', 'get', 'please', 'allowed', 'there'])
  const words = userMessage.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))

  if (words.length === 0) return null

  const results = []
  const files = walkDir(DOCS_PATH)
  for (const file of files) {
    const fullPath = path.join(DOCS_PATH, file)
    const content = await extractText(fullPath)
    const lines = content.split('\n')
    for (const word of words) {
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(word)) {
          results.push({ file, line: i + 1, text: line.trim(), keyword: word })
        }
      })
    }
  }

  if (results.length === 0) return null

  // Deduplicate and limit
  const seen = new Set()
  const unique = results.filter(r => {
    const key = `${r.file}:${r.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 20)

  return unique
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

  // Lightweight live memory stats for the htop-style meter. Polled frequently,
  // so it avoids the heavier /models path — only a quick Ollama /api/ps probe
  // (best-effort) to report how much RAM the loaded model(s) hold.
  if (req.method === 'GET' && req.url === '/memory') {
    const total = os.totalmem()
    const free = availableMemory()
    let loaded = 0
    try {
      const psRes = await fetch('http://localhost:11434/api/ps')
      const psData = await psRes.json()
      loaded = (psData.models || []).reduce((a, m) => a + (m.size || 0), 0)
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total, free, used: total - free, loaded }))
    return
  }


  console.log(`[api] ${req.method} ${req.url}`)

  if (req.method === 'POST' && req.url === '/chat') {
    await ensureCurrentModel()
    if (!currentModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No models installed. Pull one with `ollama pull <model>`.' }))
      return
    }
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

    // Auto pre-search: inject document context if enabled. The base prompt comes
    // from the active agent package.
    let systemPrompt = AGENT.system_prompt
    if (body.autoSearch && lastMsg?.role === 'user') {
      const searchResults = await autoSearch(lastMsg.content)
      if (searchResults) {
        const context = searchResults.map(r => `[${r.file}:${r.line}] ${r.text}`).join('\n')
        systemPrompt += `\n\nRELEVANT DOCUMENT EXCERPTS (pre-searched for you — use these to answer, and call read_text_file for full context if needed):\n${context}`
        console.log(`[api] auto-search injected ${searchResults.length} results`)
      }
    }

    try {
      const result = streamText({
        model: ollamaModel(currentModel),
        system: systemPrompt,
        messages: body.messages,
        tools,
        temperature: AGENT.runtime.temperature ?? 0,
        maxSteps: AGENT.runtime.max_steps || 10  // tool-call rounds, from the agent package
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
    await ensureCurrentModel()
    try {
      const [tagsRes, psRes] = await Promise.all([
        fetch('http://localhost:11434/api/tags'),
        fetch('http://localhost:11434/api/ps').catch(() => null),
      ])
      const data = await tagsRes.json()
      const psData = psRes ? await psRes.json().catch(() => ({ models: [] })) : { models: [] }
      const loadedByName = new Map((psData.models || []).map(m => [m.name, m.size || 0]))
      const loadedTotal = Array.from(loadedByName.values()).reduce((a, b) => a + b, 0)

      const totalRAM = os.totalmem()
      const freeRAM = availableMemory()
      // Loaded models would be evicted on switch, so add them back when checking fit.
      // For a model that's already loaded, exclude only its own size.
      const effectiveFreeFor = (m) => freeRAM + loadedTotal - (loadedByName.get(m.name) || 0)

      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null,
        family: m.details?.family || null,
        fitsInRAM: m.size < effectiveFreeFor(m) * 0.9,
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        currentModel,
        models,
        memory: {
          total: totalRAM,
          free: freeRAM,
          loaded: loadedTotal,
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

    const freeRAM = availableMemory()

    // Check if model exists in Ollama
    try {
      const [tagsRes, psRes] = await Promise.all([
        fetch('http://localhost:11434/api/tags'),
        fetch('http://localhost:11434/api/ps').catch(() => null),
      ])
      const data = await tagsRes.json()
      const psData = psRes ? await psRes.json().catch(() => ({ models: [] })) : { models: [] }
      const match = (data.models || []).find(m => m.name === body.model)

      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Model "${body.model}" not found. Pull it first with: ollama pull ${body.model}` }))
        return
      }

      // Models other than the requested one would be evicted when this one loads.
      const evictableSize = (psData.models || [])
        .filter(m => m.name !== body.model)
        .reduce((a, m) => a + (m.size || 0), 0)
      const effectiveFree = freeRAM + evictableSize

      const fitsInRAM = match.size < effectiveFree * 0.9
      if (!fitsInRAM) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'Model does not fit in available RAM',
          modelSize: match.size,
          freeRAM: effectiveFree
        }))
        return
      }

      // Evict any other resident models before loading the new one. Belt-
      // and-suspenders alongside OLLAMA_MAX_LOADED_MODELS=1 — guarantees the
      // old model's VRAM is freed before we start loading the new one.
      const others = (psData.models || []).filter(m => m.name !== body.model)
      for (const m of others) {
        try {
          await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, prompt: '', keep_alive: 0 })
          })
          console.log(`[api] evicted model: ${m.name}`)
        } catch (e) {
          console.warn(`[api] failed to evict ${m.name}: ${e.message}`)
        }
      }

      // Eager-load the new model. Empty prompt with keep_alive triggers
      // Ollama to allocate weights/KV cache and return once the runner is
      // ready — so the client knows the model is actually usable.
      console.log(`[api] loading model: ${body.model}`)
      const loadStart = Date.now()
      try {
        await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: body.model, prompt: '', keep_alive: '5m', stream: false })
        })
        console.log(`[api] model loaded in ${((Date.now() - loadStart) / 1000).toFixed(1)}s`)
      } catch (e) {
        console.error(`[api] eager load failed: ${e.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Failed to load model: ${e.message}` }))
        return
      }

      currentModel = body.model
      console.log(`[api] model switched to: ${currentModel}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, model: currentModel, fitsInRAM, loadMs: Date.now() - loadStart }))
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
        const parser = new PDFParse({ data: buf })
        const data = await parser.getText()
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
    const rawFilename = req.headers['x-filename']
    if (!rawFilename) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing X-Filename header' }))
      return
    }
    let filename
    try {
      filename = decodeURIComponent(rawFilename)
    } catch {
      filename = rawFilename
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

module.exports = { server }
