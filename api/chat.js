const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createOllama } = require('ollama-ai-provider')
const { streamText, jsonSchema } = require('ai')
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
// Flips true once the model is warmed up (loaded into memory) at startup, so the UI
// can show a loading state and block input until the first question will be fast.
let modelReady = false
// Set to a human-readable reason when warm-up fails (e.g. out of memory) so the UI
// can show the truth instead of a perpetual "loading" or a generic error.
let modelError = null

// If the model won't fit in free RAM, return a clear message (mirrors the
// memory-aware error the /models/select endpoint already gives the UI).
async function memoryHint(model) {
  try {
    const tags = await (await fetch('http://localhost:11434/api/tags')).json()
    const m = (tags.models || []).find(x => x.name === model || x.model === model)
    const free = availableMemory()
    if (m && m.size && free && m.size > free) {
      return `The "${model}" model needs ~${(m.size / 1e9).toFixed(1)} GB but only ~${(free / 1e9).toFixed(1)} GB RAM is free. Close other apps and try again.`
    }
  } catch { /* ignore — fall back to a generic message */ }
  return null
}

async function ensureCurrentModel() {
  if (currentModel) return currentModel
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    const data = await res.json()
    const fromPkg = resolveOllamaModel(data.models || [], AGENT?.model?.id)
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
// numCtx comes from the agent package: Ollama otherwise defaults to a 4096-token
// window, which truncates large tool results (and the question) out of context.
const ollamaModel = (name) => ollama(name, {
  simulateStreaming: true,
  numCtx: AGENT?.model?.context_length || undefined,
})

// ── Agent Package (model + system prompt + tools + runtime) ───────────────────

// The agent package is the SINGLE source of truth (prompt, tool contracts, model,
// runtime) — also loaded by afchat_lab. There is intentionally NO built-in fallback:
// a degraded default silently answers with the wrong tool contracts (e.g. the model
// guesses parameter names), which is worse than a clear, visible failure.
//
// If the package can't load we do NOT exit and do NOT fall back: we keep AGENT null,
// log loudly, and make every request that needs it return an explicit 503. The HTTP
// server still starts so the window opens and the user SEES the error instead of a
// silent process death or wrong answers.
let agentLoadError = null
const AGENT = (() => {
  const file = process.env.AGENT_PACKAGE || path.join(__dirname, '../packages/gemma4-qa')
  try {
    const p = loadPackage(file)
    console.log(`[api] loaded agent package: ${p.name} (model=${p.model.id}, tools=${p.toolAllowlist.join(',')}, steps=${p.runtime.max_steps}, cap=${p.runtime.max_tool_result_chars})`)
    return p
  } catch (err) {
    agentLoadError = `Agent package failed to load from "${file}": ${err.message}`
    console.error(`[api] FATAL: ${agentLoadError}`)
    console.error('[api] The app cannot answer without an agent package. Ensure packages/** is bundled (electron-builder "files") or set AGENT_PACKAGE to a valid package.')
    return null
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

// Tool IMPLEMENTATIONS only — the model-facing CONTRACTS (descriptions + JSON
// schemas) live in the agent package and are bound to these by name below. Param
// names match the package's canonical schema (path / head / tail / pattern /
// context), so the lab (MCP) and Aristo present the model identical tools.

// search_content: a content/grep search mirroring afchat_lab's _grep_corpus —
// case-insensitive substring; "A OR B" matches a line containing either; context=N
// returns the N lines AFTER each match; sandboxed to DOCS_PATH.
// Strip bidi/zero-width marks (LRM/RLM, embeddings, isolates, ZWSP/ZWNJ/ZWJ, BOM) so a
// Hebrew↔Latin boundary can't silently break a literal substring match.
const stripMarks = s => s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')

async function grepCorpus({ pattern, path: scope, context }) {
  const ctx = Math.max(0, Math.min(parseInt(context, 10) || 0, 60))
  // `pattern` may be a single term, a LIST of terms, or (fallback) a string "A OR B".
  // A line matches if it contains ANY term.
  const raw = Array.isArray(pattern) ? pattern : String(pattern ?? '').split(/\s+OR\s+/)
  const terms = raw.map(t => stripMarks(String(t).trim().toLowerCase())).filter(Boolean)
  if (!terms.length) return { error: "search_content needs a non-empty 'pattern'." }
  const LINE_CAP = 300, MAX_MATCHES = 40

  let files
  if (!scope) {
    files = walkDir(DOCS_PATH)
  } else {
    files = []
    for (const s of (Array.isArray(scope) ? scope : [scope])) {
      if (!s) continue
      const full = safePath(s)                       // throws if outside DOCS_PATH
      if (!fs.existsSync(full)) continue
      if (fs.statSync(full).isDirectory()) {
        files.push(...walkDir(full).map(f => path.relative(DOCS_PATH, path.join(full, f))))
      } else {
        files.push(path.relative(DOCS_PATH, full))
      }
    }
    files = [...new Set(files)]
  }

  const clip = s => { s = s.trim(); return s.length <= LINE_CAP ? s : s.slice(0, LINE_CAP) + '…' }
  const blocks = []
  for (const file of files) {
    let content
    try { content = await extractText(path.join(DOCS_PATH, file)) } catch { continue }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const low = stripMarks(lines[i].toLowerCase())
      if (terms.some(t => low.includes(t))) {
        const end = Math.min(lines.length, i + 1 + ctx)
        const block = []
        for (let j = i; j < end; j++) block.push(`${file}:${j + 1}: ${clip(lines[j])}`)
        blocks.push(block.join('\n'))
        if (blocks.length >= MAX_MATCHES) {
          return { text: blocks.join(ctx ? '\n\n' : '\n') + `\n\n[showing the first ${MAX_MATCHES} matches; refine the pattern for fewer]` }
        }
      }
    }
  }
  if (!blocks.length) return { text: `No lines containing ${terms.map(t => `"${t}"`).join(' / ')} were found in the documents.` }
  return { text: blocks.join(ctx ? '\n\n' : '\n') }
}

const TOOL_IMPLS = {
  list_directory: async ({ path: dir }) => {
    try {
      const target = (!dir || dir === '.') ? DOCS_PATH : safePath(dir)
      const files = walkDir(target)
      return { files, count: files.length }
    } catch (err) { return { error: err.message } }
  },

  read_text_file: async ({ path: filepath, head, tail }) => {
    try {
      const fullPath = safePath(filepath)
      if (!fs.existsSync(fullPath)) return { error: `File not found: ${filepath}` }
      let content = await extractText(fullPath)
      const totalLength = content.length
      if (head) content = content.split('\n').slice(0, head).join('\n')
      else if (tail) content = content.split('\n').slice(-tail).join('\n')
      const cap = AGENT?.runtime?.max_tool_result_chars || 8000
      if (content.length > cap) {
        return {
          filepath,
          content: content.slice(0, cap) +
            `\n\n[TRUNCATED: showed the first ${cap} of ${totalLength} characters; the rest was NOT shown. Use search_content with a keyword to locate the passage.]`,
          truncated: true, totalLength,
        }
      }
      return { filepath, content, truncated: false, totalLength }
    } catch (err) { return { error: err.message } }
  },

  search_content: grepCorpus,
}

// Build the AI SDK tool set from the PACKAGE's contracts (description + JSON schema),
// binding each to its implementation by name. The descriptions/schemas come from the
// package — this file holds none of them.
const tools = AGENT ? Object.fromEntries(
  AGENT.tools
    .filter(t => TOOL_IMPLS[t.name])
    .map(t => [t.name, {
      description: t.description || '',
      parameters: jsonSchema(t.parameters || { type: 'object', properties: {} }),
      execute: TOOL_IMPLS[t.name],
    }])
) : {}
const missing = AGENT ? AGENT.toolAllowlist.filter(n => !TOOL_IMPLS[n]) : []
if (missing.length) console.warn(`[api] agent package tools with no implementation: ${missing.join(', ')}`)

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

  // Warm-up status — the UI polls this and blocks input with a loader until the
  // model is loaded, so the first question is never slowed by a cold model load.
  if (req.method === 'GET' && req.url === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ready: modelReady, model: currentModel, error: modelError }))
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
    if (!AGENT) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: agentLoadError || 'Agent package not loaded; the app cannot answer.' }))
      return
    }
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
      result.pipeDataStreamToResponse(res, {
        // Surface the real failure to the UI instead of the AI SDK's default
        // "An error occurred." Ollama returns a 500 when it can't load the model,
        // which on this air-gapped target almost always means not enough free RAM.
        getErrorMessage: (error) => {
          const msg = (error && error.message) ? error.message : String(error)
          if (/internal server error|statuscode 500|\b500\b|memory|failed to load/i.test(msg)) {
            return `The model could not generate a response — most likely not enough free RAM to load it. Close other apps and try again. (${msg})`
          }
          return msg
        },
      })
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
  warmUpModel()
})

// Warm-up: load the model into memory at startup (behind the app's boot splash) so
// the user's FIRST question isn't slowed by a cold model load. Empty prompt +
// keep_alive tells Ollama to allocate weights/KV cache and stay resident; it returns
// once the runner is ready. Best-effort — retries a few times while Ollama finishes
// starting, and never blocks the server.
async function warmUpModel() {
  const sleep = (ms) => new Promise(res => setTimeout(res, ms))
  try {
    if (!AGENT) { modelError = agentLoadError || 'Agent package not loaded.'; console.warn('[api] warm-up skipped: no agent package'); return }
    // 1) Wait (up to ~60s) for Ollama's HTTP API to come up — spawned in parallel.
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch('http://localhost:11434/api/version')).ok } catch { /* not yet */ }
      if (!up) await sleep(1000)
    }
    if (!up) { modelError = 'The Ollama service did not start.'; console.warn('[api] warm-up: Ollama did not come up'); return }

    const model = await ensureCurrentModel()
    if (!model) { modelError = 'No model is installed.'; console.warn('[api] warm-up: no model available'); return }

    // 2) One warm-up generation through the SAME path as a real chat (system
    // prompt + tool schemas) so Ollama doesn't just load the weights — it also
    // PREFILLS and caches that large fixed prefix. With an empty-prompt warm-up the
    // first real question still paid the full system-prompt prefill (~90s on CPU)
    // and only later questions were fast (served from Ollama's prompt cache).
    // Priming the real prefix here moves that cost into startup, behind the loader,
    // so the FIRST answer is fast too. Same numCtx (via ollamaModel) as chat, so no
    // model reload happens on the first real request.
    const t0 = Date.now()
    // Tools in Ollama's format, matching what the chat path sends, so the prefilled
    // system+tools prefix is the SAME token sequence the first real question uses
    // and Ollama serves it from its prompt cache.
    const ollamaTools = (AGENT.toolAllowlist || [])
      .map(n => (AGENT.tools || []).find(t => t.name === n))
      .filter(Boolean)
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }))
    // Non-streaming /api/chat blocks until the model is loaded AND the prompt is
    // prefilled, and returns a real HTTP status we can check (keep_alive -1 keeps
    // it resident; same num_ctx as chat -> no reload on the first request).
    const r = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: AGENT.system_prompt }, { role: 'user', content: 'hi' }],
        tools: ollamaTools.length ? ollamaTools : undefined,
        stream: false,
        keep_alive: -1,
        options: { num_ctx: AGENT?.model?.context_length || undefined },
      }),
    })
    if (r.ok) {
      modelReady = true
      modelError = null
      console.log(`[api] warmed up model ${model} (weights + prompt prefix) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } else {
      const detail = (await r.text().catch(() => '')).slice(0, 300)
      modelError = (await memoryHint(model)) || `The model failed to load (HTTP ${r.status}).${detail ? ' ' + detail : ''}`
      console.warn(`[api] warm-up returned HTTP ${r.status}: ${modelError}`)
    }
  } catch (e) {
    // Don't claim the model is ready when it isn't — report the real reason
    // (memory hint when it won't fit) so the UI shows it instead of a perpetual
    // loader followed by a silent failure.
    modelError = (await memoryHint(currentModel)) || `Warm-up failed: ${e.message}`
    console.warn(`[api] ${modelError}`)
  }
}

module.exports = { server }
