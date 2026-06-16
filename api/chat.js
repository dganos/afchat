const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const { createOpenAI } = require('@ai-sdk/openai')
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
    const res = await fetch(LMSTUDIO_BASE + '/v1/models')
    const data = await res.json()
    // LM Studio /v1/models returns { data: [{ id }, ...] } (no sizes).
    const installed = (data.data || []).map(m => ({ name: m.id }))
    const fromPkg = resolveOllamaModel(installed, AGENT.model && AGENT.model.id)
    currentModel = fromPkg || (installed[0] && installed[0].name) || null
    if (fromPkg) console.log(`[api] using agent-package model: ${currentModel}`)
    else if (currentModel) console.log(`[api] package model not installed; using: ${currentModel}`)
    else console.warn('[api] no models loaded in LM Studio — UI must pick one')
  } catch (err) {
    console.error('[api] could not auto-select model:', err.message)
  }
  return currentModel
}
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
// Aristo runs on LM Studio's OpenAI-compatible server (/v1). Unlike Ollama, LM
// Studio streams structured tool_calls natively, so no simulateStreaming workaround
// is needed. The context window (num_ctx) is set at model-LOAD time via `lms` (the
// /v1 surface has no per-request num_ctx) — see startLMStudio() in main.js.
const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE || 'http://localhost:1234'
const lmstudio = createOpenAI({ baseURL: LMSTUDIO_BASE + '/v1', apiKey: 'lm-studio' })
const lmModel = (name) => lmstudio(name)

// Run the LM Studio CLI (model load/unload). Bundled at ~/.lmstudio/bin/lms.
const LMS_BIN = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', 'lms')
function lms(args) {
  return new Promise((resolve, reject) => {
    execFile(LMS_BIN, args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()))
      resolve((stdout || '').trim())
    })
  })
}

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
  // so it avoids the heavier /models path. LM Studio's API doesn't report loaded
  // model RAM, so this just reports system total/free/used.
  if (req.method === 'GET' && req.url === '/memory') {
    const total = os.totalmem()
    const free = availableMemory()
    // LM Studio's API doesn't expose loaded-model RAM in bytes, so the meter shows
    // total/free/used only (loaded stays 0).
    let loaded = 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total, free, used: total - free, loaded }))
    return
  }


  console.log(`[api] ${req.method} ${req.url}`)

  if (req.method === 'POST' && req.url === '/chat') {
    await ensureCurrentModel()
    if (!currentModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No model loaded in LM Studio. Load one in the app or via `lms load`.' }))
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
        model: lmModel(currentModel),
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
      // LM Studio's richer model list (state, family, context). No per-model RAM
      // bytes are exposed, so we can't compute fitsInRAM the way Ollama allowed.
      const res0 = await fetch(LMSTUDIO_BASE + '/api/v0/models')
      const data = await res0.json()
      const models = (data.data || [])
        .filter(m => m.type === 'llm' || m.type === 'vlm' || !m.type)
        .map(m => ({
          name: m.id,
          size: null,
          parameterSize: m.arch || null,
          quantization: m.quantization || null,
          family: m.arch || null,
          loaded: m.state === 'loaded',
          fitsInRAM: true,  // LM Studio API doesn't expose model size in bytes
        }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        currentModel,
        models,
        memory: {
          total: os.totalmem(),
          free: availableMemory(),
          loaded: 0,
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

    // Check the model exists in LM Studio.
    try {
      const res0 = await fetch(LMSTUDIO_BASE + '/api/v0/models')
      const data = await res0.json()
      const match = (data.data || []).find(m => m.id === body.model)

      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Model "${body.model}" not found in LM Studio. Download it in the app first.` }))
        return
      }

      // Switch models via the lms CLI: unload others, then load with the agent
      // package's context window. (LM Studio also JIT-loads on the first /v1 call,
      // but loading explicitly lets us set num_ctx and report readiness — and
      // keeps at most one model resident, like OLLAMA_MAX_LOADED_MODELS=1.)
      const ctx = (AGENT.model && AGENT.model.context_length) || undefined
      console.log(`[api] loading model: ${body.model}`)
      const loadStart = Date.now()
      try {
        await lms(['unload', '--all'])
        await lms(['load', body.model, '--yes', ...(ctx ? ['--context-length', String(ctx)] : [])])
        console.log(`[api] model loaded in ${((Date.now() - loadStart) / 1000).toFixed(1)}s`)
      } catch (e) {
        console.error(`[api] load failed: ${e.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Failed to load model: ${e.message}` }))
        return
      }

      currentModel = body.model
      console.log(`[api] model switched to: ${currentModel}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, model: currentModel, loadMs: Date.now() - loadStart }))
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
