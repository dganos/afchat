// Stall-bug regression test: "the model answers and then just stops", "it starts
// thinking and then the answer simply stops".
//
// Drives the REAL api/chat.js (spawned as a child process, its real /chat endpoint
// and data-stream output) against a scripted fake Ollama (test-support/fake-ollama.js)
// and asserts the invariant the UI depends on: every chat request ends in EITHER a
// complete answer (answer text + finish_message) OR a visible `error` part — never a
// normal finish with no answer, or a half answer presented as complete.
//
// Run: node --test api/stall-bug.test.js
// (STALL_TEST_CHAT_JS=<path> runs it against another copy of chat.js, e.g. the
//  pre-fix version, to show which scenarios fail there.)

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { createFakeOllama } = require('./test-support/fake-ollama')

const CHAT_JS = process.env.STALL_TEST_CHAT_JS || path.join(__dirname, 'chat.js')
const IDLE_MS = 1500  // ARISTO_OLLAMA_IDLE_TIMEOUT_MS for the child (prod default: 20 min)

let fake, child, apiPort, logs = ''

const freePort = () => new Promise((resolve) => {
  const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

test.before(async () => {
  fake = createFakeOllama()
  const ollamaPort = await fake.listen()
  apiPort = await freePort()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aristo-stall-'))
  const docs = path.join(tmp, 'docs'); fs.mkdirSync(docs)
  fs.writeFileSync(path.join(docs, 'manual.md'), '# Manual\n\n## Weight\nThe maximum weight is 9,800 kg.\n')
  child = spawn(process.execPath, [CHAT_JS], {
    env: {
      ...process.env,
      ARISTO_OLLAMA_PORT: String(ollamaPort), ARISTO_API_PORT: String(apiPort),
      ARISTO_OLLAMA_IDLE_TIMEOUT_MS: String(IDLE_MS),
      DOCS_PATH: docs, ARISTO_DATA_DIR: path.join(tmp, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { logs += d })
  child.stderr.on('data', (d) => { logs += d })
  // Wait for warm-up against the fake to mark the model ready.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await (await fetch(`http://127.0.0.1:${apiPort}/ready`)).json()
      if (r.ready) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`chat.js never became ready. Logs:\n${logs}`)
})

test.after(async () => {
  child?.kill()
  await fake?.close()
})

// POST one question to the real /chat endpoint and parse the AI SDK data stream.
async function ask(turns, { abortAfterMs } = {}) {
  fake.setScript(turns)
  const ac = new AbortController()
  const r = await fetch(`http://127.0.0.1:${apiPort}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Q?', parts: [{ type: 'text', text: 'Q?' }] }] }),
    signal: ac.signal,
  })
  assert.strictEqual(r.status, 200)
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs)
  const out = { text: '', reasoning: '', errors: [], finishMessage: null, finishSteps: [], toolCalls: [], toolResults: [], aborted: false }
  let raw = ''
  try { for await (const c of r.body) raw += Buffer.from(c).toString('utf-8') } catch (e) { if (e.name === 'AbortError') out.aborted = true; else throw e }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([0-9a-z]):(.*)$/)
    if (!m) continue
    const v = JSON.parse(m[2])
    if (m[1] === '0') out.text += v
    else if (m[1] === 'g') out.reasoning += v
    else if (m[1] === '3') out.errors.push(v)
    else if (m[1] === 'd') out.finishMessage = v
    else if (m[1] === 'e') out.finishSteps.push(v)
    else if (m[1] === '9') out.toolCalls.push(v)
    else if (m[1] === 'a') out.toolResults.push(v)
  }
  return out
}

// The invariant: a complete answer, or a visible error. Never a silent stop.
function assertNotSilent(out) {
  const complete = out.text.trim().length > 0 && out.finishMessage && out.errors.length === 0
  const visibleError = out.errors.length > 0
  assert.ok(complete || visibleError,
    `SILENT STOP: text=${JSON.stringify(out.text)} reasoning=${out.reasoning.length} chars ` +
    `finish=${JSON.stringify(out.finishMessage)} errors=${JSON.stringify(out.errors)}`)
}

const THINK = [{ thinking: 'Let me think ' }, { thinking: 'about the weight.' }]

test('normal answer: thinking then answer → complete answer', async () => {
  const out = await ask([{ chunks: [...THINK, { content: 'The maximum ' }, { content: 'weight is 9,800 kg.' }] }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'The maximum weight is 9,800 kg.')
  assert.strictEqual(out.errors.length, 0)
})

test('tool call then answer → tool parts + answer', async () => {
  const out = await ask([
    { chunks: [...THINK, { tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] }] },
    { chunks: [{ content: 'It is 9,800 kg.' }] },
  ])
  assertNotSilent(out)
  assert.strictEqual(out.toolCalls.length, 1)
  assert.strictEqual(out.toolResults.length, 1)
  assert.strictEqual(out.text, 'It is 9,800 kg.')
})

test('thinking-only turn once → empty-turn nudge recovers an answer', async () => {
  const out = await ask([{ chunks: THINK }, { chunks: [{ content: 'Recovered: 9,800 kg.' }] }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'Recovered: 9,800 kg.')
  assert.strictEqual(out.errors.length, 0)
})

test('thinking-only turns until the policy gives up → visible error, not a blank finish', async () => {
  const out = await ask([{ chunks: THINK }, { chunks: THINK }])
  assertNotSilent(out)
  assert.ok(out.reasoning.length > 0)
  assert.match(out.errors[0] || '', /no answer/)
})

test('done_reason "length" while still thinking (num_predict hit) → visible error', async () => {
  const out = await ask([{ chunks: THINK, doneReason: 'length' }, { chunks: THINK, doneReason: 'length' }])
  assertNotSilent(out)
  assert.match(out.errors[0] || '', /done_reason=length/)
})

test('done_reason "length" mid-answer → partial text kept AND marked truncated', async () => {
  const out = await ask([{ chunks: [...THINK, { content: 'The maximum weight is 9,' }], doneReason: 'length' }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'The maximum weight is 9,')
  assert.match(out.errors[0] || '', /truncated/)
})

test('Ollama stream cut without a done line → visible error', async () => {
  const out = await ask([{ chunks: [...THINK, { content: 'The maximum weight' }], end: 'cut' }])
  assertNotSilent(out)
  assert.match(out.errors[0] || '', /without a done line/)
})

test('Ollama {"error"} line mid-stream (runner crash) → visible error with Ollama\'s text', async () => {
  const out = await ask([{ chunks: [...THINK, { content: 'The max' }], end: 'error', errorText: 'model runner has unexpectedly stopped' }])
  assertNotSilent(out)
  assert.match(out.errors[0] || '', /runner has unexpectedly stopped/)
})

test('unexecutable text-shaped tool call (unknown tool) is not accepted as the answer', async () => {
  // Output freezes at `call:` so the client sees nothing of this turn; it must be
  // treated as an empty turn (recovered), not as a final answer the user never got.
  const out = await ask([{ chunks: [{ content: 'call:lookup_weight{item:"heli"}' }] }, { chunks: [{ content: 'It is 9,800 kg.' }] }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'It is 9,800 kg.')
})

test('long silence from Ollama (> idle timeout) → visible error, and no hidden retry', async () => {
  const out = await ask([{ headerDelayMs: IDLE_MS + 1500, chunks: [{ content: 'late' }] }, { chunks: [{ content: 'retried' }] }])
  assertNotSilent(out)
  assert.match(out.errors[0] || '', /idle timeout/)
  assert.strictEqual(fake.chatRequests.length, 1, 'a timed-out prefill must not be silently retried')
})

test('silence mid-stream (> idle timeout) after some text → visible error', async () => {
  const out = await ask([{ chunks: [{ content: 'The maximum ' }, { silenceMs: IDLE_MS + 1500 }, { content: 'weight' }] }])
  assertNotSilent(out)
  assert.match(out.errors[0] || '', /idle timeout/)
})

test('slow but alive prefill (< idle timeout) still answers', async () => {
  const out = await ask([{ headerDelayMs: IDLE_MS - 700, chunks: [{ content: 'Slow but fine.' }] }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'Slow but fine.')
})

test('NDJSON split across TCP reads, mid-UTF-8 char, last line without newline → exact text', async () => {
  const lines = [
    JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'חושב' }, done: false }) + '\n',
    JSON.stringify({ message: { role: 'assistant', content: 'המשקל המרבי הוא 9,800 ק"ג.' }, done: false }) + '\n',
    JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),  // no trailing \n
  ]
  const bytes = Buffer.from(lines.join(''), 'utf-8')
  const pieces = []
  for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.subarray(i, i + 7).toString('latin1'))
  // write latin1 strings so each piece is exactly those bytes (splits mid-char/mid-JSON)
  const out = await ask([{ raw: pieces.map((p) => Buffer.from(p, 'latin1')) }])
  assertNotSilent(out)
  assert.strictEqual(out.text, 'המשקל המרבי הוא 9,800 ק"ג.')
})

test('client disconnect mid-stream aborts the Ollama request (no ghost generation)', async () => {
  const out = await ask([{ chunks: [{ content: 'a' }, { silenceMs: 1000 }, { content: 'b' }] }], { abortAfterMs: 200 })
  assert.ok(out.aborted)
  await new Promise((r) => setTimeout(r, 300))
  assert.deepStrictEqual(fake.closedEarly, [0])
})
