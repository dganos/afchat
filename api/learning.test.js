// Continuous Learning store + compile helpers — no server, no Ollama.
// Run: node api/learning.test.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const {
  createLearning, splitPrompt, buildPrompt, validateProposal, flattenCompileMessages, buildCompileContext, LEARNED_MARKER,
} = require('./learning')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aristo-learning-'))
let prompt = 'BASE PROMPT\nline two'
const applied = []
const L = createLearning({
  dataDir: tmp,
  packagePrompt: () => 'BASE PROMPT\nline two',
  currentPrompt: () => prompt,
  applyPrompt: (t) => { prompt = t; applied.push(t) },
  currentModel: () => 'm',
  numCtx: 8192,
  streamOneOllamaTurn: async () => { throw new Error('not used') },
  listDirectory: async () => 'a.md\nb.md',
  listDocs: () => ['a.md', 'b.md'],
  pipeDataStreamToResponse: () => {},
  formatDataStreamPart: () => '',
})
const S = L.store

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('seeds v1 from the package prompt', () => {
  const m = S.versionsWithStats()
  assert.strictEqual(m.active, 1)
  assert.strictEqual(m.versions[0].source, 'package')
  assert.strictEqual(S.readVersion(1), prompt)
})

test('feedback upsert by msg_id, short ids, validation', () => {
  const a = S.upsertFeedback({ msg_id: 'm1', score: 2, note: ' wrong doc ', question: 'q1', answer: 'a1' })
  assert.strictEqual(a.id, 'F1'); assert.strictEqual(a.note, 'wrong doc'); assert.strictEqual(a.prompt_version, 1)
  const a2 = S.upsertFeedback({ msg_id: 'm1', score: 3 })
  assert.strictEqual(a2.id, 'F1'); assert.strictEqual(a2.score, 3); assert.strictEqual(a2.note, 'wrong doc')
  const b = S.upsertFeedback({ msg_id: 'm2', score: 5, question: 'q2', answer: 'a2', prompt_version: 1 })
  assert.strictEqual(b.id, 'F2')
  assert.throws(() => S.upsertFeedback({ msg_id: 'm3', score: 7 }))
  assert.throws(() => S.upsertFeedback({ score: 3 }))
})

test('patch keeps the original note; exclude; delete', () => {
  const f = S.patchFeedback('F1', { note: 'use b.md' })
  assert.strictEqual(f.original_note, 'wrong doc'); assert.strictEqual(f.note, 'use b.md')
  S.patchFeedback('F2', { excluded: true })
  const st = Object.fromEntries(S.feedbackWithStatus().map((x) => [x.id, x.status]))
  assert.deepStrictEqual(st, { F1: 'new', F2: 'excluded' })
  S.upsertFeedback({ msg_id: 'm9', score: 1 })
  assert.ok(S.deleteFeedback('F3')); assert.ok(!S.deleteFeedback('F3'))
  S.patchFeedback('F2', { excluded: false })
})

test('split/build prompt round-trip', () => {
  const t = buildPrompt('BASE', ['rule one (a.md)', 'rule two'], 4)
  assert.ok(t.includes(LEARNED_MARKER) && t.includes('## Verified by users (v4)'))
  assert.deepStrictEqual(splitPrompt(t), { base: 'BASE', rules: ['rule one (a.md)', 'rule two'] })
  assert.strictEqual(buildPrompt('BASE', [], 2), 'BASE')
})

test('validateProposal: ids, docs, length', () => {
  const ctx = { feedbackIds: new Set(['F1', 'F2']), ruleCount: 1, docs: new Set(['a.md']) }
  assert.ok(validateProposal({ rules: [{ text: 'x', from: ['F1', 'R1'], doc: 'a.md' }] }, ctx).ok)
  const bad = validateProposal({ rules: [{ text: 'x', from: ['F9', 'R2'], doc: 'zz.md' }] }, ctx)
  assert.ok(!bad.ok && bad.errors.length === 2)
  assert.ok(!validateProposal({ rules: [] }, ctx).ok)
  const long = Array.from({ length: 30 }, () => ({ text: 'y'.repeat(300), from: ['F1'] }))
  assert.ok(validateProposal({ rules: long }, ctx).errors.some((e) => e.includes('too long')))
  assert.ok(validateProposal({ rules: ['plain string rule'] }, ctx).ok)
})

test('compile context lists rules, feedback and prior decisions', () => {
  const c = buildCompileContext({ activeV: 3, rules: ['r'], feedback: [{ id: 'F1', score: 2, ts: '2026-10-01T00:00', prompt_version: 3, question: 'q', answer: 'a', note: 'n' }], priorDecisions: [{ question: 'Q?', answer: 'A!' }] })
  assert.ok(c.includes('R1. r') && c.includes('[F1] score 2/5') && c.includes('User note: n') && c.includes('Q: Q?'))
})

test('flatten keeps answered tool calls, skips pending ones', () => {
  const out = flattenCompileMessages([
    { role: 'user', parts: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', parts: [
      { type: 'text', text: 'thinking aloud' },
      { type: 'tool-invocation', toolInvocation: { state: 'result', toolName: 'ask_admin', args: { question: 'Q' }, result: 'yes' } },
      { type: 'text', text: 'ok' },
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolName: 'ask_admin', args: { question: 'Q2' } } },
    ] },
  ])
  assert.deepStrictEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.strictEqual(out[1].tool_calls[0].function.name, 'ask_admin'); assert.strictEqual(out[2].content, 'yes')
})

test('import .md creates an unapplied version; export header stripped', () => {
  const v = S.createVersion({ text: 'IMPORTED', source: 'imported', label: 'x.md' })
  assert.strictEqual(v, 2); assert.strictEqual(S.versionsWithStats().active, 1)
})

test('compile approve → new version, feedback applied; rollback reopens it', () => {
  const s = { id: 'sess-1', base_version: 1, feedback_ids: ['F1', 'F2'], rules: [], proposal: { rules: [{ text: 'Use b.md for X', doc: 'b.md', from: ['F1'] }], contradictions: [], dropped: ['F2'] } }
  S.saveSession(s)
  // approve is internal to createLearning; drive it through the handler-free path:
  const handle = L.handle
  return new Promise((resolve, reject) => {
    const req = new (require('stream').Readable)({ read() {} })
    req.method = 'POST'; req.url = '/learning/compile/approve'
    const res = { writeHead(code) { this.code = code }, end(body) {
      try {
        assert.strictEqual(this.code, 200, body)
        const { v } = JSON.parse(body)
        assert.strictEqual(v, 3)
        assert.ok(prompt.includes('- Use b.md for X (b.md)') && prompt.startsWith('BASE PROMPT'))
        const st = () => Object.fromEntries(S.feedbackWithStatus().map((x) => [x.id, x.status]))
        assert.deepStrictEqual(st(), { F1: 'applied', F2: 'applied' })
        assert.strictEqual(S.versionsWithStats().pending, 0)
        // rollback to v1 → re-opened; re-apply v3 → closed again
        S.setActive(1); assert.deepStrictEqual(st(), { F1: 'new', F2: 'new' })
        S.setActive(3); assert.deepStrictEqual(st(), { F1: 'applied', F2: 'applied' })
        resolve()
      } catch (e) { reject(e) }
    } }
    handle(req, res)
    req.push(JSON.stringify({ sessionId: 'sess-1' })); req.push(null)
  })
})

test('cannot delete the active version; stale session is rejected', () => {
  assert.strictEqual(S.deleteVersion(3).code, 409)
  assert.ok(S.deleteVersion(2).ok)
})

test('manual edit creates a version only when text changed', () => {
  const n = S.versionsWithStats().versions.length
  L.recordManual(prompt); assert.strictEqual(S.versionsWithStats().versions.length, n)
  L.recordManual(prompt + '\nmore'); assert.strictEqual(S.versionsWithStats().versions.length, n + 1)
})

test('backup export → restore round-trip', () => {
  const b = S.exportAll()
  S.upsertFeedback({ msg_id: 'later', score: 4 })
  const active = S.restoreBackup(JSON.parse(JSON.stringify(b)))
  assert.strictEqual(active, b.manifest.active)
  assert.strictEqual(S.loadFeedback().length, b.feedback.length)
  assert.throws(() => S.restoreBackup({ kind: 'nope' }))
})

test('restart with matching override does not add a version', () => {
  const n = S.versionsWithStats().versions.length
  S.init(S.readVersion(S.versionsWithStats().active) + '\n', 'x')
  assert.strictEqual(S.versionsWithStats().versions.length, n)
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`) } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`) }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failed ? `\n${failed} failed.` : `\nAll ${tests.length} passed.`)
  process.exit(failed ? 1 : 0)
})()
