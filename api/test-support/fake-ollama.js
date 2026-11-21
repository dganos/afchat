// Fake Ollama for tests: speaks just enough of the HTTP API that api/chat.js calls
// at startup and request time, with SCRIPTED streaming /api/chat turns so failure
// modes of the real model (thinking-only turns, done_reason "length", a stream cut
// without `done`, an {"error"} line mid-stream, long silence) can be reproduced
// deterministically without a GPU or the real model.
//
// Each streaming /api/chat request consumes the next turn of the current script:
//   {
//     headerDelayMs,            // wait before sending headers (≈ prefill time)
//     chunks: [ { thinking } | { content } | { tool_calls } | { silenceMs } ... ],
//     chunkDelayMs,             // gap between chunks (default 0)
//     end: 'done' (default) | 'cut' (end the body without a done line)
//          | 'destroy' (kill the socket) | 'error' (send {"error": errorText})
//     doneReason: 'stop' | 'length',
//     errorText,
//     raw: [strings]            // write these exact byte strings instead (split-chunk tests)
//   }
// A request with no scripted turn left gets a plain "(fake: script exhausted)" answer.

const http = require('http')

const MODEL = 'gemma-4-e4b:latest'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function createFakeOllama() {
  let script = []
  const chatRequests = []   // bodies of streaming /api/chat requests, in order
  const closedEarly = []    // indexes of streaming requests the CLIENT closed before we finished

  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    if (req.url === '/api/version') return json(200, { version: '0.0.0-fake' })
    if (req.url === '/api/tags') return json(200, { models: [{ name: MODEL, model: MODEL, size: 1 }] })
    if (req.url === '/api/ps') return json(200, { models: [] })
    if (req.url === '/api/show') return json(200, { capabilities: ['completion', 'tools', 'thinking'] })
    if (req.url === '/api/generate') return json(200, { done: true })
    if (req.url === '/api/embed') return json(404, { error: 'fake: no embedding model' })
    if (req.url !== '/api/chat') return json(404, { error: 'fake: unknown endpoint' })

    if (body.stream === false) {  // warm-up
      return json(200, { model: MODEL, message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop' })
    }

    const idx = chatRequests.length
    chatRequests.push(body)
    const turn = script.shift() || { chunks: [{ content: '(fake: script exhausted)' }] }
    let finished = false
    res.on('close', () => { if (!finished) closedEarly.push(idx) })

    if (turn.headerDelayMs) await sleep(turn.headerDelayMs)
    if (res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    const line = (obj) => res.write(JSON.stringify(obj) + '\n')
    const base = () => ({ model: MODEL, created_at: new Date().toISOString() })

    if (turn.raw) {
      for (const piece of turn.raw) { if (res.destroyed) return; res.write(piece); await sleep(turn.chunkDelayMs ?? 5) }
      finished = true
      return res.end()
    }
    for (const ch of turn.chunks || []) {
      if (res.destroyed) return
      if (ch.silenceMs) { await sleep(ch.silenceMs); continue }
      const message = { role: 'assistant', content: ch.content || '' }
      if (ch.thinking) message.thinking = ch.thinking
      if (ch.tool_calls) message.tool_calls = ch.tool_calls
      line({ ...base(), message, done: false })
      if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs)
    }
    if (res.destroyed) return
    const end = turn.end || 'done'
    finished = true
    if (end === 'cut') return res.end()
    // let the written chunks reach the client first: destroy() discards unflushed writes
    if (end === 'destroy') { await sleep(30); return res.socket.destroy() }
    if (end === 'error') { line({ error: turn.errorText || 'fake runner error' }); return res.end() }
    line({ ...base(), message: { role: 'assistant', content: '' }, done: true, done_reason: turn.doneReason || 'stop', prompt_eval_count: 10, eval_count: 20 })
    res.end()
  })

  return {
    MODEL,
    listen: (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }),
    setScript: (turns) => { script = turns.slice(); chatRequests.length = 0; closedEarly.length = 0 },
    remaining: () => script.length,
    chatRequests,
    closedEarly,
  }
}

module.exports = { createFakeOllama }
