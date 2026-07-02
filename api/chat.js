const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createOllama } = require('ollama-ai-provider')
const { streamText, generateText, wrapLanguageModel, extractReasoningMiddleware, jsonSchema, pipeDataStreamToResponse, formatDataStreamPart } = require('ai')

// Like the AI SDK's smoothStream, but paces BOTH the answer (`text-delta`) and
// the reasoning (`reasoning`) word-by-word. smoothStream only smooths text, so
// thinking would otherwise arrive in one burst (the provider runs non-streaming
// under simulateStreaming, so everything lands at once). Buffers per chunk type
// and flushes when the type switches (reasoning → answer).
function smoothBoth({ delayInMs = 18 } = {}) {
  const WORD = /\S+\s+/m
  const detect = (buf) => { const m = WORD.exec(buf); return m ? buf.slice(0, m.index) + m[0] : null }
  return () => {
    let buffer = ''
    let type = null
    const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
    return new TransformStream({
      async transform(chunk, controller) {
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning') {
          if (buffer) { controller.enqueue({ type, textDelta: buffer }); buffer = '' }
          controller.enqueue(chunk)
          return
        }
        if (type && chunk.type !== type && buffer) { controller.enqueue({ type, textDelta: buffer }); buffer = '' }
        type = chunk.type
        buffer += chunk.textDelta
        let match
        while ((match = detect(buffer)) != null) {
          controller.enqueue({ type, textDelta: match })
          buffer = buffer.slice(match.length)
          await wait(delayInMs)
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue({ type, textDelta: buffer })
      },
    })
  }
}
const mammoth = require('mammoth')
const { PDFParse } = require('pdf-parse')

const { availableMemory } = require('./available-memory')
const { loadPackage, resolveOllamaModel } = require('./agent-package')

// The app talks ONLY to its own bundled Ollama, which the launcher (main.js /
// start-server.js) starts on a private port and serves from resources/models.
// We deliberately do NOT use the system default port (11434): if the user has a
// system-installed Ollama running there, the app must never fall back to it or
// to its models. The launcher passes the port via ARISTO_OLLAMA_PORT; the
// default here matches the launcher's default so the two never drift.
const OLLAMA_PORT = process.env.ARISTO_OLLAMA_PORT || '11435'
const OLLAMA_BASE = `http://localhost:${OLLAMA_PORT}`

// The model is the one pinned by the agent package, served from the bundled
// models directory. It is resolved lazily on the first request because the
// bundled Ollama may not be up yet when this module loads. We never auto-select
// a different installed model — the app ships exactly one model on purpose.
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
    const tags = await (await fetch(`${OLLAMA_BASE}/api/tags`)).json()
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
    const res = await fetch(`${OLLAMA_BASE}/api/tags`)
    const data = await res.json()
    // Only ever use the model the agent package pins, served from the bundled
    // models dir. If it is missing, surface that — never substitute a different
    // (e.g. system-installed) model.
    const fromPkg = resolveOllamaModel(data.models || [], AGENT?.model?.id)
    if (fromPkg) {
      currentModel = fromPkg
      console.log(`[api] using agent-package model: ${currentModel}`)
    } else {
      modelError = `The bundled model "${AGENT?.model?.id || '(none)'}" was not found in the app's model store.`
      console.error(`[api] ${modelError}`)
    }
  } catch (err) {
    console.error('[api] could not reach the bundled Ollama:', err.message)
  }
  return currentModel
}
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
// gemma-4-e4b (and other Ollama thinking models) return their reasoning in a
// SEPARATE `message.thinking` field — there are no <think> tags in the content,
// and ollama-ai-provider v1 drops that field on the floor. simulateStreaming
// uses the non-streaming /api/chat (a single JSON body), so we can intercept the
// response here and fold `thinking` back into the content as a <think> block.
// extractReasoningMiddleware (below) then splits it back out into a proper
// reasoning part that the UI renders. Defensive: any failure returns the
// original response unchanged.
// Best-effort repair of a malformed gemma tool call that Ollama's own parser
// rejected and left as raw text in `content`, e.g.:
//   call:search_content{context:25,path:<|"|>file.md<|"|>,pattern="## "}
//   call:search_content{pattern:[<|"|>a<|"|>,<|"|>b<|"|>],path:[<|"|>c<|"|>}  (missing ])
// Normalizes the gemma quirks (quote token, `=` separators, bare keys) and
// balances brackets, then JSON.parses the args. Returns {name, arguments} or null.
function repairGemmaToolCall(content) {
  if (typeof content !== 'string') return null
  const m = content.match(/call:\s*([a-zA-Z_]\w*)\s*\{/)
  if (!m) return null
  const name = m[1]
  const start = m.index + m[0].length - 1            // index of the "{"
  const lastBrace = content.lastIndexOf('}')
  let s = lastBrace > start ? content.slice(start, lastBrace + 1) : content.slice(start)
  s = s.replace(/<\|"\|>/g, '"').replace(/[“”]/g, '"')       // gemma quote token + smart quotes
       .replace(/=/g, ':')                                    // key=value → key:value
       .replace(/([{,\[]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')  // quote bare keys
  const count = (str, ch) => str.split(ch).length - 1
  const arrDeficit = count(s, '[') - count(s, ']')           // insert missing ] before final }
  if (arrDeficit > 0) {
    const lb = s.lastIndexOf('}')
    s = lb !== -1 ? s.slice(0, lb) + ']'.repeat(arrDeficit) + s.slice(lb) : s + ']'.repeat(arrDeficit)
  }
  s += '}'.repeat(Math.max(0, count(s, '{') - count(s, '}')))  // balance braces
  try {
    const args = JSON.parse(s)
    if (args && typeof args === 'object' && !Array.isArray(args)) return { name, arguments: args }
  } catch { /* unrepairable */ }
  return null
}

const ollamaFetch = async (url, init) => {
  const res = await fetch(url, init)
  try {
    if (!String(url).includes('/api/chat')) return res
    if (!(res.headers.get('content-type') || '').includes('application/json')) return res
    const data = await res.clone().json()
    const msg = data?.message
    if (!msg) return res
    let modified = false

    // 1) Salvage a malformed tool call Ollama's gemma parser left as raw text:
    //    rebuild it as a structured tool_calls entry so the AI SDK runs it and
    //    the agent loop continues, instead of the turn dead-ending with no answer.
    if ((!msg.tool_calls || !msg.tool_calls.length) &&
        typeof msg.content === 'string' && /call:\s*[a-zA-Z_]\w*\s*\{/.test(msg.content)) {
      const repaired = repairGemmaToolCall(msg.content)
      if (repaired && TOOL_IMPLS[repaired.name]) {
        msg.tool_calls = [{ function: { name: repaired.name, arguments: repaired.arguments } }]
        const ci = msg.content.search(/call:\s*[a-zA-Z_]\w*\s*\{/)
        msg.content = ci > 0 ? msg.content.slice(0, ci).trim() : ''  // drop the leaked call text
        modified = true
        console.log(`[api] repaired malformed ${repaired.name} tool call: ${JSON.stringify(repaired.arguments)}`)
      }
    }

    // 2) Fold Ollama's separate `thinking` field into a <think> block for the UI.
    if (msg.thinking) {
      msg.content = `<think>${msg.thinking}</think>\n${msg.content || ''}`
      modified = true
    }

    if (modified) {
      const headers = new Headers(res.headers)
      headers.delete('content-length')  // body length changed
      return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers })
    }
  } catch { /* fall through to the unmodified response */ }
  return res
}
const ollama = createOllama({ baseURL: `${OLLAMA_BASE}/api`, fetch: ollamaFetch })
// ollama-ai-provider v1.2.0 streaming doesn't parse tool_calls from Ollama's
// response (only tries to infer them from text content). With thinking models
// like qwen3 the tool calls come in a structured field that the stream parser
// ignores. simulateStreaming uses the non-streaming API (which handles
// tool_calls correctly) and wraps the result in a stream for the AI SDK.
// numCtx comes from the agent package: Ollama otherwise defaults to a 4096-token
// window, which truncates large tool results (and the question) out of context.
// ollama-ai-provider v1.2.0 has no reasoning support, so a thinking model's
// reasoning arrives inline as <think>…</think> inside the text. Wrap the model
// with extractReasoningMiddleware to split that out into proper `reasoning`
// parts (which the UI renders in a collapsible "thinking" panel) and keep the
// answer text clean.
// ollama-ai-provider v1 can't serialize a `reasoning` content part back into
// Ollama format — convertToOllamaChatMessages throws "Unsupported part". That
// breaks the multi-step tool loop AND every follow-up turn once reasoning exists
// in the history. Reasoning is display-only (the model doesn't need to re-read
// its own prior thinking), so strip reasoning parts from the OUTGOING prompt on
// every provider call.
const stripReasoningMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    prompt: (params.prompt || []).map((m) =>
      Array.isArray(m.content)
        ? { ...m, content: m.content.filter((p) => p.type !== 'reasoning') }
        : m
    ),
  }),
}

const ollamaModel = (name) => wrapLanguageModel({
  model: ollama(name, {
    simulateStreaming: true,
    numCtx: AGENT?.model?.context_length || undefined,
  }),
  // extractReasoningMiddleware: split <think> out of the OUTPUT into reasoning parts.
  // stripReasoningMiddleware: remove reasoning parts from the INPUT prompt.
  middleware: [extractReasoningMiddleware({ tagName: 'think' }), stripReasoningMiddleware],
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

// Editable system prompt. Starts from the agent package, but the user can edit it
// in Settings and reload it live (takes effect on the next message; the chat
// history is NOT cleared). Edits persist to a writable override file so they
// survive restarts; the package's own prompt file stays untouched as the default.
const DATA_DIR = process.env.ARISTO_DATA_DIR || path.join(__dirname, '..', '.data')
const SYSTEM_PROMPT_OVERRIDE = path.join(DATA_DIR, 'system_prompt.override.md')
let currentSystemPrompt = AGENT?.system_prompt || ''
try {
  if (fs.existsSync(SYSTEM_PROMPT_OVERRIDE)) {
    const saved = fs.readFileSync(SYSTEM_PROMPT_OVERRIDE, 'utf-8')
    if (saved && saved.trim()) { currentSystemPrompt = saved.trim(); console.log('[api] loaded saved system-prompt override') }
  }
} catch (e) { console.warn('[api] could not load system-prompt override:', e.message) }

// Re-prime Ollama's prompt cache with the (new) system prefix in the background,
// so the first message after an edit isn't slowed by a full re-prefill. Best-effort.
async function reprimeSystemPrompt() {
  if (!currentModel) return
  try {
    const ollamaTools = buildOllamaTools()
    await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: currentModel,
        messages: [{ role: 'system', content: currentSystemPrompt }, { role: 'user', content: 'hi' }],
        tools: ollamaTools.length ? ollamaTools : undefined,
        stream: false, keep_alive: -1,
        options: { num_ctx: AGENT?.model?.context_length || undefined },
      }),
    })
    console.log('[api] re-primed prompt cache for the edited system prompt')
  } catch (e) { console.warn('[api] re-prime failed (next message will prefill):', e.message) }
}

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
// Hard cap on ANY tool result's text payload. read_text_file caps itself, but
// search_content (grepCorpus) could return up to ~40 matches × ~60 context lines
// and blow the entire context window in a single step (observed: one result
// pushed the prompt to ~32k tokens, truncating the model's answer to nothing).
// This is the single choke point so no tool can starve the model of room.
const RESULT_CAP = AGENT?.runtime?.max_tool_result_chars || 8000
function capToolResult(result) {
  if (result == null || typeof result !== 'object') return result
  for (const key of ['text', 'content']) {
    if (typeof result[key] === 'string' && result[key].length > RESULT_CAP) {
      result[key] = result[key].slice(0, RESULT_CAP) +
        `\n\n[TRUNCATED to ${RESULT_CAP} chars to fit the context window — refine the search for fewer/tighter matches.]`
    }
  }
  return result
}

const tools = AGENT ? Object.fromEntries(
  AGENT.tools
    .filter(t => TOOL_IMPLS[t.name])
    .map(t => [t.name, {
      description: t.description || '',
      parameters: jsonSchema(t.parameters || { type: 'object', properties: {} }),
      execute: async (...a) => capToolResult(await TOOL_IMPLS[t.name](...a)),
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

// Speed check: measure Aristo's throughput (generation + prefill tok/s) through
// Ollama with the app's EXACT config (agent-package model + context + system
// prompt + warm-up). Same logic as scripts/bench_aristo_tps.py, in-process so the
// Settings panel can run it. Reads Ollama's native token counters (exact).
// Runs the throughput benchmark, reporting progress live through `send` so the
// UI can drive a speedometer as it goes (instead of waiting ~15-20s for one
// blob). Events: { type:'step', label } on each phase change, { type:'tps',
// phase, value } for each live reading (windowed during generation, one per run
// for prefill), and a final { type:'done', ... }. `signal` lets the client abort
// mid-run — it's threaded into every Ollama fetch so the in-flight call is cut.
async function runSpeedTest(send, signal) {
  const base = OLLAMA_BASE
  const model = currentModel
  const numCtx = AGENT?.model?.context_length || 8192
  const sys = currentSystemPrompt
  const temp = AGENT?.runtime?.temperature ?? 0
  const tps = (cnt, durNs) => (durNs ? +(cnt / (durNs / 1e9)).toFixed(1) : 0)

  // Streaming Ollama chat. `onToken` fires once per generated token so the caller
  // can compute a windowed, live tok/s for the gauge. Returns the final summary
  // chunk (eval_count / eval_duration / prompt_eval_*).
  const chat = async (messages, numPredict, ctx, onToken) => {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages, options: { temperature: temp, num_ctx: ctx, num_predict: numPredict } }),
      signal,
    })
    if (!r.ok) throw new Error(`Ollama /api/chat returned ${r.status}`)
    const dec = new TextDecoder()
    let buf = '', final = null
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const d = JSON.parse(line)
        // Count tokens from BOTH content and `thinking` — gemma & other thinking
        // models stream their reasoning into message.thinking, so a content-only
        // counter would read 0 tok/s for the whole (thinking-heavy) generation.
        if ((d.message?.content || d.message?.thinking) && onToken) onToken()
        if (d.done) final = d
      }
    }
    return final || {}
  }

  // warm-up (load weights + cache the system prefix), discarded
  send({ type: 'step', label: 'Warming up…' })
  await chat([{ role: 'system', content: sys }, { role: 'user', content: 'hi' }], 8, numCtx)

  // generation throughput (prefix cached → isolates output speed). Emit a windowed
  // reading every ~300ms so the needle tracks the live generation rate.
  const GEN = 'Explain in detail, step by step and across several paragraphs, how a helicopter main rotor produces lift, and how collective pitch, cyclic pitch, and the tail rotor each control the aircraft. Be thorough.'
  let gTok = 0, gNs = 0; const gPer = []
  for (let i = 0; i < 3; i++) {
    send({ type: 'step', label: `Generation ${i + 1}/3` })
    let wTok = 0, wStart = Date.now()
    const d = await chat([{ role: 'system', content: sys }, { role: 'user', content: GEN }], 160, numCtx, () => {
      wTok++
      const dt = Date.now() - wStart
      if (dt >= 300) { send({ type: 'tps', phase: 'gen', value: +(wTok / (dt / 1000)).toFixed(1) }); wTok = 0; wStart = Date.now() }
    })
    gTok += d.eval_count || 0; gNs += d.eval_duration || 0
    gPer.push(tps(d.eval_count || 0, d.eval_duration || 0))
  }

  const cpus = os.cpus() || []
  send({
    type: 'done',
    genTps: tps(gTok, gNs), genPerRun: gPer,
    model, numCtx,
    machine: {
      cpu: cpus[0]?.model || os.arch(), cores: cpus.length || 0,
      ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1), platform: os.platform(), arch: os.arch(),
    },
  })
}

// ── Real-streaming chat ─────────────────────────────────────────────────────
// We talk to Ollama's STREAMING /api/chat directly (rather than the AI SDK's
// simulateStreaming, which runs non-streaming and only replays the finished
// answer). This makes the first thinking/answer token appear right after prefill
// instead of after the whole answer is generated — the dominant TTFT cost.
// The output is written in the AI SDK data-stream protocol so the existing
// useChat frontend keeps working unchanged. We re-implement the tool-call loop
// here because ollama-ai-provider v1.2.0's streaming path can't parse gemma's
// thinking field or its (often text-shaped) tool calls.

// Tools in Ollama's format. Shared with warm-up so the prefilled system+tools
// prefix is byte-identical and Ollama serves the first real turn from its cache.
function buildOllamaTools() {
  const names = (AGENT?.toolAllowlist?.length ? AGENT.toolAllowlist : (AGENT?.tools || []).map(t => t.name))
  return names
    .map(n => (AGENT?.tools || []).find(t => t.name === n))
    .filter(t => t && TOOL_IMPLS[t.name])
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }))
}

const TEXT_CALL_RE = /call:\s*[a-zA-Z_]\w*\s*\{/  // gemma sometimes emits a tool call as raw text

// Transient connection failures we can safely retry. The most common is an idle
// keep-alive socket that Ollama closed and undici's pool then reused → ECONNRESET
// on the first request after a pause (e.g. right after warm-up).
const TRANSIENT_NET_RE = /ECONNRESET|fetch failed|socket hang up|other side closed|EPIPE/i
const isTransientNetErr = (e) =>
  TRANSIENT_NET_RE.test(`${e?.message || ''} ${e?.cause?.message || e?.cause || ''}`)

// Stream a single assistant turn from Ollama, forwarding thinking → `reasoning`
// and answer text → `text` parts live. Detects tool calls (structured, or
// gemma's text-shaped form) and returns them for the caller to execute. Retries
// once on a transient connection reset, but only while nothing has been emitted
// yet (so a mid-stream drop can't duplicate output).
async function streamOneOllamaTurn({ messages, ollamaTools, temp, numCtx, send, signal }) {
  for (let attempt = 0; ; attempt++) {
    const dec = new TextDecoder()
    let buf = '', content = '', sentLen = 0, frozen = false, emitted = false
    const toolCalls = []
    let promptTokens = 0, completionTokens = 0

    // Stream answer text with a small holdback so a partial `call:` marker is never
    // shown; freeze output entirely once a text tool call is recognized.
    const flushContent = (final = false) => {
      if (frozen) return
      if (TEXT_CALL_RE.test(content)) { frozen = true; return }
      const HOLD = 16
      const upto = final ? content.length : Math.max(sentLen, content.length - HOLD)
      if (upto > sentLen) { send('text', content.slice(sentLen, upto)); sentLen = upto; emitted = true }
    }

    try {
      const r = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel, messages,
          tools: ollamaTools.length ? ollamaTools : undefined,
          stream: true, keep_alive: -1,
          options: { temperature: temp, num_ctx: numCtx },
        }),
        signal,
      })
      if (!r.ok) {
        const detail = (await r.text().catch(() => '')).slice(0, 300)
        throw new Error(`Ollama /api/chat returned ${r.status}. ${detail}`)
      }

      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line) continue
          let d; try { d = JSON.parse(line) } catch { continue }
          const msg = d.message || {}
          if (msg.thinking) { send('reasoning', msg.thinking); emitted = true }
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const fn = tc.function || {}
              let args = fn.arguments
              if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
              toolCalls.push({ id: `call_${toolCalls.length}_${fn.name}`, name: fn.name, args: args || {} })
            }
          }
          if (msg.content) { content += msg.content; flushContent() }
          if (d.done) { promptTokens = d.prompt_eval_count || 0; completionTokens = d.eval_count || 0 }
        }
      }
    } catch (e) {
      // Retry a fresh connection once if Ollama dropped the socket before we
      // streamed anything; otherwise surface the failure.
      if (attempt === 0 && !emitted && !signal.aborted && isTransientNetErr(e)) {
        console.log('[api] chat: transient Ollama connection drop, retrying once')
        await new Promise((r) => setTimeout(r, 150))
        continue
      }
      throw e
    }

    // gemma fallback: a tool call left as raw text rather than a structured field.
    if (!toolCalls.length && TEXT_CALL_RE.test(content)) {
      const repaired = repairGemmaToolCall(content)
      if (repaired && TOOL_IMPLS[repaired.name]) {
        toolCalls.push({ id: `call_0_${repaired.name}`, name: repaired.name, args: repaired.arguments })
      }
    }
    if (!toolCalls.length) flushContent(true)  // final answer: flush the held tail

    return { content, toolCalls, promptTokens, completionTokens }
  }
}

// Drive the full multi-step agent loop, writing AI SDK data-stream parts.
async function streamChatResponse({ writer, systemPrompt, uiMessages, signal }) {
  const send = (type, value) => writer.write(formatDataStreamPart(type, value))
  const temp = AGENT?.runtime?.temperature ?? 0
  const numCtx = AGENT?.model?.context_length || 8192
  const maxSteps = AGENT?.runtime?.max_steps || 10
  const ollamaTools = buildOllamaTools()

  // History → plain user/assistant text. Reasoning is display-only and prior tool
  // mechanics aren't needed to continue; the current turn's tool calls/results are
  // built below in Ollama's native shape.
  const uiText = (m) => {
    if (Array.isArray(m.parts)) {
      const t = m.parts.filter(p => p.type === 'text').map(p => p.text).join('')
      if (t) return t
    }
    return typeof m.content === 'string' ? m.content : ''
  }
  const messages = [{ role: 'system', content: systemPrompt }]
  for (const m of uiMessages || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = uiText(m)
    if (text) messages.push({ role: m.role, content: text })
  }

  let promptTokens = 0, completionTokens = 0
  for (let step = 0; step < maxSteps; step++) {
    send('start_step', { messageId: `aristo-step-${step}` })
    const turn = await streamOneOllamaTurn({ messages, ollamaTools, temp, numCtx, send, signal })
    promptTokens += turn.promptTokens
    completionTokens += turn.completionTokens
    const stepUsage = { promptTokens: turn.promptTokens, completionTokens: turn.completionTokens }

    if (turn.toolCalls.length) {
      messages.push({
        role: 'assistant', content: turn.content || '',
        tool_calls: turn.toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } })),
      })
      for (const tc of turn.toolCalls) {
        send('tool_call', { toolCallId: tc.id, toolName: tc.name, args: tc.args })
        let result
        try { result = capToolResult(await TOOL_IMPLS[tc.name](tc.args)) }
        catch (e) { result = { error: e.message } }
        send('tool_result', { toolCallId: tc.id, result })
        messages.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) })
      }
      send('finish_step', { finishReason: 'tool-calls', usage: stepUsage, isContinued: false })
      continue
    }

    send('finish_step', { finishReason: 'stop', usage: stepUsage, isContinued: false })
    break
  }
  send('finish_message', { finishReason: 'stop', usage: { promptTokens, completionTokens } })
}

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
      const psRes = await fetch(`${OLLAMA_BASE}/api/ps`)
      const psData = await psRes.json()
      loaded = (psData.models || []).reduce((a, m) => a + (m.size || 0), 0)
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total, free, used: total - free, loaded }))
    return
  }

  // Context-window size + the fixed base cost (system prompt + tool schemas).
  // The client adds an estimate of the conversation tokens to draw the meter,
  // so it updates live (and drops the moment the history is compacted).
  if (req.method === 'GET' && req.url === '/context') {
    const baseTokens = AGENT
      ? Math.ceil((currentSystemPrompt.length + JSON.stringify(AGENT.tools || []).length) / 3.5)
      : 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total: AGENT?.model?.context_length || 0, baseTokens }))
    return
  }

  // System prompt — view the current (possibly edited) prompt.
  if (req.method === 'GET' && req.url === '/system-prompt') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      prompt: currentSystemPrompt,
      isDefault: currentSystemPrompt === (AGENT?.system_prompt || ''),
    }))
    return
  }

  // System prompt — edit + reload it live. Takes effect on the next message; the
  // chat history is intentionally left untouched. `{ reset: true }` reverts to the
  // package default. Persists to the override file so the change survives restarts.
  if (req.method === 'POST' && req.url === '/system-prompt') {
    try {
      const body = await new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (c) => { data += c })
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
      })
      if (body.reset) {
        currentSystemPrompt = AGENT?.system_prompt || ''
        try { fs.existsSync(SYSTEM_PROMPT_OVERRIDE) && fs.unlinkSync(SYSTEM_PROMPT_OVERRIDE) } catch {}
      } else {
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'System prompt cannot be empty.' }))
          return
        }
        currentSystemPrompt = prompt
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true })
          fs.writeFileSync(SYSTEM_PROMPT_OVERRIDE, prompt, 'utf-8')
        } catch (e) { console.warn('[api] could not persist system-prompt override:', e.message) }
      }
      console.log(`[api] system prompt reloaded (${currentSystemPrompt.length} chars)${body.reset ? ' [reset to default]' : ''}`)
      reprimeSystemPrompt()  // fire-and-forget: warm the new prefix so the next message is fast
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, length: currentSystemPrompt.length, isDefault: currentSystemPrompt === (AGENT?.system_prompt || '') }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // Compact the conversation: summarize it into one concise message so the
  // context window is freed (Claude-style /compact). The client replaces its
  // history with the returned summary.
  if (req.method === 'POST' && req.url === '/compact') {
    if (!AGENT || !currentModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Model not ready.' }))
      return
    }
    try {
      const body = await new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (c) => { data += c })
        req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
      })
      // The context being compacted already fits the window (Ollama truncates
      // anything past it), so size the summarizer's input to the FULL window
      // minus room for the summary output — a normally-compacted conversation is
      // then summarized losslessly. (~2.5 chars/token is a conservative Hebrew
      // ratio so we never exceed the token budget.)
      const SUMMARY_OUT = 2048
      const ctxTokens = AGENT?.model?.context_length || 8192
      const maxInChars = Math.max(4000, Math.round((ctxTokens - SUMMARY_OUT - 256) * 2.5))
      const transcript = (body.messages || []).map((m) => {
        const text = Array.isArray(m.parts)
          ? m.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
          : (m.content || '')
        const calls = Array.isArray(m.parts)
          ? m.parts.filter((p) => p.type === 'tool-invocation').map((p) => `[כלי: ${p.toolInvocation?.toolName}]`).join(' ')
          : ''
        return `${m.role === 'user' ? 'משתמש' : 'אריסטו'}: ${[text, calls].filter(Boolean).join(' ')}`.trim()
      }).join('\n\n').slice(-maxInChars)  // safety net only; normally the whole convo fits
      const { text } = await generateText({
        model: ollamaModel(currentModel),
        maxTokens: SUMMARY_OUT,
        prompt: `סכם את השיחה הבאה בין משתמש לעוזר. שמור על כל העובדות, ההחלטות, שמות הקבצים והממצאים הדרושים כדי להמשיך מכאן. כתוב סיכום תמציתי אך שלם בעברית.\n\n${transcript}\n\nסיכום:`,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ summary: (text || '').trim() }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }


  // Speed check — runs the throughput benchmark and returns gen/prefill tok/s.
  if (req.method === 'POST' && req.url === '/speedtest') {
    if (!AGENT || !currentModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Model not ready.' }))
      return
    }
    // Stream progress as SSE so the UI can animate a live speedometer. The client
    // aborting the fetch closes the request, which aborts the in-flight Ollama call.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const ac = new AbortController()
    req.on('close', () => ac.abort())
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {} }
    try {
      await runSpeedTest(send, ac.signal)
    } catch (e) {
      if (!ac.signal.aborted) send({ type: 'error', error: e.message })
    }
    res.end()
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

    // Auto pre-search: inject document context if enabled. The base prompt is the
    // current (possibly user-edited) system prompt.
    let systemPrompt = currentSystemPrompt
    if (body.autoSearch && lastMsg?.role === 'user') {
      const searchResults = await autoSearch(lastMsg.content)
      if (searchResults) {
        const context = searchResults.map(r => `[${r.file}:${r.line}] ${r.text}`).join('\n')
        systemPrompt += `\n\nRELEVANT DOCUMENT EXCERPTS (pre-searched for you — use these to answer, and call read_text_file for full context if needed):\n${context}`
        console.log(`[api] auto-search injected ${searchResults.length} results`)
      }
    }

    // Real token streaming straight from Ollama (see streamChatResponse). The
    // output is the AI SDK data-stream protocol, so useChat needs no changes.
    const ac = new AbortController()
    req.on('close', () => ac.abort())  // client stop() aborts the in-flight Ollama call
    pipeDataStreamToResponse(res, {
      // Surface the real failure to the UI instead of a generic message. Ollama
      // returns a 500 when it can't load the model, which on this air-gapped
      // target almost always means not enough free RAM.
      onError: (error) => {
        const msg = (error && error.message) ? error.message : String(error)
        if (/internal server error|statuscode 500|\b500\b|memory|failed to load/i.test(msg)) {
          return `The model could not generate a response — most likely not enough free RAM to load it. Close other apps and try again. (${msg})`
        }
        return msg
      },
      execute: async (writer) => {
        try {
          await streamChatResponse({ writer, systemPrompt, uiMessages: body.messages, signal: ac.signal })
        } catch (e) {
          if (ac.signal.aborted) return  // client stopped — end the stream quietly
          console.error('[api] chat stream error:', e?.message, '| cause:', e?.cause?.message || e?.cause || '(none)')
          throw e                        // real failure → onError emits it to the UI
        }
      },
    })
    res.on('finish', () => console.log(`[api] response stream complete (${res.statusCode})`))
    return
  }

  // ── Model Management ─────────────────────────────────────────────────────

  // List available models with RAM info
  if (req.method === 'GET' && req.url === '/models') {
    await ensureCurrentModel()
    try {
      const [tagsRes, psRes] = await Promise.all([
        fetch(`${OLLAMA_BASE}/api/tags`),
        fetch(`${OLLAMA_BASE}/api/ps`).catch(() => null),
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
  // Eject — unload the resident model(s) from RAM to free memory. The next
  // message reloads the model cold (so the first answer after ejecting is slower).
  if (req.method === 'POST' && req.url === '/models/eject') {
    try {
      const psRes = await fetch(`${OLLAMA_BASE}/api/ps`).catch(() => null)
      const psData = psRes ? await psRes.json().catch(() => ({ models: [] })) : { models: [] }
      const loaded = psData.models || []
      for (const m of loaded) {
        try {
          await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, prompt: '', keep_alive: 0 }),
          })
          console.log(`[api] ejected model from RAM: ${m.name}`)
        } catch (e) { console.warn(`[api] failed to eject ${m.name}: ${e.message}`) }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, ejected: loaded.map(m => m.name) }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

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
        fetch(`${OLLAMA_BASE}/api/tags`),
        fetch(`${OLLAMA_BASE}/api/ps`).catch(() => null),
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

      // Report whether it comfortably fits, but do NOT block the switch — the user
      // may choose to load a tight model anyway (we evict others first to free RAM).
      const fitsInRAM = match.size < effectiveFree * 0.9
      if (!fitsInRAM) console.warn(`[api] loading ${body.model} despite tight RAM (needs ${(match.size/1e9).toFixed(1)}GB, ~${(effectiveFree/1e9).toFixed(1)}GB free after eviction)`)

      // Evict any other resident models before loading the new one. Belt-
      // and-suspenders alongside OLLAMA_MAX_LOADED_MODELS=1 — guarantees the
      // old model's VRAM is freed before we start loading the new one.
      const others = (psData.models || []).filter(m => m.name !== body.model)
      for (const m of others) {
        try {
          await fetch(`${OLLAMA_BASE}/api/generate`, {
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
        await fetch(`${OLLAMA_BASE}/api/generate`, {
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
      try { up = (await fetch(`${OLLAMA_BASE}/api/version`)).ok } catch { /* not yet */ }
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
    // Tools in Ollama's format, matching what the chat path sends (same builder),
    // so the prefilled system+tools prefix is the SAME token sequence the first
    // real question uses and Ollama serves it from its prompt cache.
    const ollamaTools = buildOllamaTools()
    // Non-streaming /api/chat blocks until the model is loaded AND the prompt is
    // prefilled, and returns a real HTTP status we can check (keep_alive -1 keeps
    // it resident; same num_ctx as chat -> no reload on the first request).
    const r = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: currentSystemPrompt }, { role: 'user', content: 'hi' }],
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
