// Continuous Learning — user feedback → versioned system prompts.
//
// Users score answers 1–5 (+ an optional note). An admin runs a "compile" session
// in the Learning window: the local model reads the pending feedback and the
// current learned rules, asks the admin (ask_admin) when unsure, and proposes a
// new rule set (propose_rules). On approval it becomes a new, immutable prompt
// version = <base prompt> + LEARNED_MARKER + <learned rules section>.
//
// Storage (all under DATA_DIR/learning, plain files — no DB):
//   feedback.jsonl          one JSON object per line (rewritten atomically on edit)
//   prompts/manifest.json   { active, versions: [{ v, ts, source, parent, label, feedback_ids, chars }] }
//   prompts/v001.md …       full prompt text per version, never modified
//   sessions/<id>.json      compile-session snapshot + proposal (audit trail)
//
// "Pending" feedback is computed, not stored: an item is pending unless it is
// excluded or was applied in a version that is an ancestor of (or is) the active
// version. Rolling back to an older version therefore re-opens later feedback
// automatically, and re-applying the newer version closes it again.

const fs = require('fs')
const path = require('path')

const LEARNED_MARKER = '<!-- aristo:learned -->'
const EXPORT_HEADER_RE = /^<!-- aristo-prompt [^\n]*-->\n+/
const MAX_RULES_CHARS = 6000      // ≈1.5k tokens — keeps the learned section small for a small model
const MAX_RULE_CHARS = 400
const MAX_ANSWER_CHARS = 400      // answer excerpt shown to the compiler per feedback item
const MAX_COMPILE_STEPS = 12
const LEARNED_HEADER = (v) => `## Verified by users (v${v})`
const LEARNED_FRAMING = 'These rules were derived from user feedback on earlier answers. Follow them when they apply to the question; still ground every answer in the documents and name the document in parentheses.'

// ── Small helpers ────────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

const vName = (v) => `v${String(v).padStart(3, '0')}.md`

// Split a prompt into its base and the learned-rules list (one string per rule).
function splitPrompt(text) {
  const i = (text || '').indexOf(LEARNED_MARKER)
  if (i < 0) return { base: (text || '').trim(), rules: [] }
  const base = text.slice(0, i).trim()
  const rules = text.slice(i + LEARNED_MARKER.length).split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
  return { base, rules }
}

function renderRule(r) {
  const text = String(r.text || '').trim()
  return r.doc ? `${text} (${r.doc})` : text
}

function buildPrompt(base, rules, v) {
  if (!rules.length) return base.trim()
  return `${base.trim()}\n\n${LEARNED_MARKER}\n${LEARNED_HEADER(v)}\n${LEARNED_FRAMING}\n\n${rules.map((r) => `- ${r}`).join('\n')}\n`
}

// ── Store ────────────────────────────────────────────────────────────────────

function createStore(dataDir) {
  const ROOT = path.join(dataDir, 'learning')
  const FEEDBACK = path.join(ROOT, 'feedback.jsonl')
  const PROMPTS = path.join(ROOT, 'prompts')
  const MANIFEST = path.join(PROMPTS, 'manifest.json')
  const SESSIONS = path.join(ROOT, 'sessions')

  const loadManifest = () => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) } catch { return null }
  }
  const saveManifest = (m) => writeAtomic(MANIFEST, JSON.stringify(m, null, 2))
  const readVersion = (v) => fs.readFileSync(path.join(PROMPTS, vName(v)), 'utf-8')

  const loadFeedback = () => {
    try {
      return fs.readFileSync(FEEDBACK, 'utf-8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }
  const saveFeedback = (items) => writeAtomic(FEEDBACK, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''))

  function createVersion({ text, source, parent = null, label = '', feedback_ids = [] }) {
    text = String(text).trim()  // chat.js trims the override on load; keep versions comparable
    const m = loadManifest() || { active: null, versions: [] }
    const v = m.versions.reduce((mx, x) => Math.max(mx, x.v), 0) + 1
    writeAtomic(path.join(PROMPTS, vName(v)), text)
    m.versions.push({ v, ts: new Date().toISOString(), source, parent, label, feedback_ids, chars: text.length })
    saveManifest(m)
    return v
  }

  function setActive(v) {
    const m = loadManifest()
    m.active = v
    saveManifest(m)
  }

  // Seed v1 from the prompt in effect, and keep the invariant "active version text
  // == prompt in effect" if the override file was changed outside the app.
  function init(currentPrompt, packagePrompt) {
    const m = loadManifest()
    if (!m || !m.versions.length) {
      const v = createVersion({ text: currentPrompt, source: currentPrompt === packagePrompt ? 'package' : 'manual', label: 'initial' })
      setActive(v)
      return
    }
    let activeText = null
    try { activeText = readVersion(m.active) } catch {}
    if ((activeText || '').trim() !== (currentPrompt || '').trim()) {
      const v = createVersion({ text: currentPrompt, source: 'manual', parent: m.active, label: 'prompt changed outside the Learning window' })
      setActive(v)
    }
  }

  function ancestors(m, v) {
    const byV = new Map(m.versions.map((x) => [x.v, x]))
    const out = new Set()
    let cur = byV.get(v)
    while (cur && !out.has(cur.v)) { out.add(cur.v); cur = byV.get(cur.parent) }
    return out
  }

  // Feedback with its computed status relative to the active version.
  function feedbackWithStatus() {
    const m = loadManifest() || { active: null, versions: [] }
    const anc = ancestors(m, m.active)
    return loadFeedback().map((f) => ({
      ...f,
      status: f.excluded ? 'excluded' : (f.applied_in != null && anc.has(f.applied_in) ? 'applied' : 'new'),
    }))
  }

  function versionsWithStats() {
    const m = loadManifest() || { active: null, versions: [] }
    const fb = loadFeedback()
    const versions = m.versions.map((x) => {
      const scored = fb.filter((f) => f.prompt_version === x.v)
      const avg = scored.length ? scored.reduce((s, f) => s + f.score, 0) / scored.length : null
      return { ...x, n: scored.length, avg }
    })
    const pending = feedbackWithStatus().filter((f) => f.status === 'new').length
    return { active: m.active, versions, pending }
  }

  function upsertFeedback(body) {
    const score = Number(body.score)
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('score must be an integer 1–5')
    if (!body.msg_id) throw new Error('msg_id is required')
    const items = loadFeedback()
    let f = items.find((x) => x.msg_id === body.msg_id)
    if (f) {
      f.score = score
      if (typeof body.note === 'string') f.note = body.note.trim()
      f.updated_at = new Date().toISOString()
    } else {
      const n = items.reduce((mx, x) => Math.max(mx, Number(String(x.id).slice(1)) || 0), 0) + 1
      f = {
        id: `F${n}`, msg_id: body.msg_id, ts: new Date().toISOString(), score,
        note: typeof body.note === 'string' ? body.note.trim() : '',
        question: String(body.question || ''), answer: String(body.answer || ''),
        model: body.model || null,
        prompt_version: Number.isInteger(body.prompt_version) ? body.prompt_version : (loadManifest()?.active ?? null),
        excluded: false, applied_in: null,
      }
      items.push(f)
    }
    saveFeedback(items)
    return f
  }

  function patchFeedback(id, body) {
    const items = loadFeedback()
    const f = items.find((x) => x.id === id)
    if (!f) return null
    if (typeof body.note === 'string' && body.note.trim() !== f.note) {
      if (f.original_note == null) f.original_note = f.note
      f.note = body.note.trim()
      f.edited_at = new Date().toISOString()
    }
    if (body.score != null) {
      const s = Number(body.score)
      if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error('score must be an integer 1–5')
      f.score = s
    }
    if (typeof body.excluded === 'boolean') f.excluded = body.excluded
    saveFeedback(items)
    return f
  }

  function deleteFeedback(id) {
    const items = loadFeedback()
    const next = items.filter((x) => x.id !== id)
    if (next.length === items.length) return false
    saveFeedback(next)
    return true
  }

  function deleteVersion(v) {
    const m = loadManifest()
    if (!m || !m.versions.some((x) => x.v === v)) return { error: 'No such version.', code: 404 }
    if (m.active === v) return { error: 'Cannot delete the active version.', code: 409 }
    m.versions = m.versions.filter((x) => x.v !== v)
    saveManifest(m)
    try { fs.unlinkSync(path.join(PROMPTS, vName(v))) } catch {}
    return { ok: true }
  }

  function markApplied(ids, v) {
    const set = new Set(ids)
    const items = loadFeedback()
    for (const f of items) if (set.has(f.id)) f.applied_in = v
    saveFeedback(items)
  }

  function exportAll() {
    const m = loadManifest() || { active: null, versions: [] }
    const versions = {}
    for (const x of m.versions) { try { versions[x.v] = readVersion(x.v) } catch {} }
    return { kind: 'aristo-learning-backup', format: 1, exported_at: new Date().toISOString(), manifest: m, versions, feedback: loadFeedback() }
  }

  // Replace the whole learning state with a backup (the UI confirms first).
  function restoreBackup(b) {
    if (b?.kind !== 'aristo-learning-backup' || !b.manifest || !Array.isArray(b.manifest.versions) || !b.versions) {
      throw new Error('Not an Aristo learning backup file.')
    }
    for (const x of b.manifest.versions) {
      if (typeof b.versions[x.v] !== 'string') throw new Error(`Backup is missing the text of v${x.v}.`)
    }
    if (!b.manifest.versions.some((x) => x.v === b.manifest.active)) throw new Error('Backup has no valid active version.')
    fs.rmSync(PROMPTS, { recursive: true, force: true })
    for (const x of b.manifest.versions) writeAtomic(path.join(PROMPTS, vName(x.v)), b.versions[x.v])
    saveManifest(b.manifest)
    saveFeedback(Array.isArray(b.feedback) ? b.feedback : [])
    return b.manifest.active
  }

  const sessionFile = (id) => path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '')}.json`)
  const loadSession = (id) => { try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf-8')) } catch { return null } }
  const saveSession = (s) => writeAtomic(sessionFile(s.id), JSON.stringify(s, null, 2))

  return {
    loadManifest, readVersion, createVersion, setActive, init, feedbackWithStatus, versionsWithStats,
    upsertFeedback, patchFeedback, deleteFeedback, deleteVersion, markApplied, exportAll, restoreBackup,
    loadSession, saveSession, loadFeedback,
  }
}

// ── Compile session ──────────────────────────────────────────────────────────

const COMPILE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ask_admin',
      description: 'Ask the admin running this compile a clarification question and wait for the answer. Use it only when the feedback is contradictory, vague, or would change behavior broadly. Always cite the feedback ids the question is about.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, in the language of the feedback.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional short answer choices.' },
          about: { type: 'array', items: { type: 'string' }, description: 'Feedback ids (e.g. "F3") or rule ids (e.g. "R2") this is about.' },
        },
        required: ['question', 'about'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the documents in the corpus (to check a document name a rule refers to).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_rules',
      description: 'Finish the compile: propose the COMPLETE new rule set (existing rules you keep + new ones). Ends the session for admin review.',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One short, concrete, general rule.' },
                doc: { type: 'string', description: 'Optional exact document file name the rule is about.' },
                from: { type: 'array', items: { type: 'string' }, description: 'Feedback ids (F…) and/or existing rule ids (R…) this rule comes from.' },
              },
              required: ['text', 'from'],
            },
          },
          contradictions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kept: { type: 'string' }, dropped: { type: 'string' }, why: { type: 'string' } },
              required: ['kept', 'dropped', 'why'],
            },
          },
          dropped: { type: 'array', items: { type: 'string' }, description: 'Feedback ids / rule ids deliberately not turned into rules (noise, already covered, or overridden).' },
        },
        required: ['rules'],
      },
    },
  },
]
const COMPILE_TOOL_NAMES = COMPILE_TOOLS.map((t) => t.function.name)

// Text the compiler sees as its data: current rules (R ids), pending feedback (F ids),
// and decisions the admin already made in an earlier run of this compile.
function buildCompileContext({ activeV, rules, feedback, priorDecisions }) {
  const lines = []
  lines.push(`# CURRENT LEARNED RULES (v${activeV})`)
  if (rules.length) rules.forEach((r, i) => lines.push(`R${i + 1}. ${r}`))
  else lines.push('(none yet)')
  lines.push('', '# FEEDBACK TO PROCESS (oldest first; score 1 = completely wrong, 5 = fully correct)')
  for (const f of feedback) {
    lines.push(`[${f.id}] score ${f.score}/5 · ${String(f.ts).slice(0, 10)} · answered by prompt v${f.prompt_version ?? '?'}`)
    lines.push(`Q: ${f.question.replace(/\s+/g, ' ').trim()}`)
    if (f.score <= 3 || f.note) {
      const a = f.answer.replace(/\s+/g, ' ').trim()
      lines.push(`Answer given: ${a.length > MAX_ANSWER_CHARS ? a.slice(0, MAX_ANSWER_CHARS) + '…' : a}`)
    }
    lines.push(`User note: ${f.note ? f.note : '(none)'}`, '')
  }
  if (priorDecisions?.length) {
    lines.push('# DECISIONS THE ADMIN ALREADY MADE (do not ask these again)')
    for (const d of priorDecisions) lines.push(`- Q: ${d.question}\n  A: ${d.answer}`)
  }
  return lines.join('\n')
}

// Validate a propose_rules call. Returns { ok, proposal } or { ok:false, errors }.
function validateProposal(args, { feedbackIds, ruleCount, docs }) {
  const errors = []
  const rawRules = Array.isArray(args?.rules) ? args.rules : []
  const rules = rawRules.map((r) => (typeof r === 'string' ? { text: r, from: [] } : r || {}))
  if (!rules.length) errors.push('rules is empty — propose at least one rule (keep existing rules you still want).')
  const known = (id) => feedbackIds.has(id) || (/^R\d+$/.test(id) && Number(id.slice(1)) >= 1 && Number(id.slice(1)) <= ruleCount)
  rules.forEach((r, i) => {
    const text = String(r.text || '').trim()
    if (!text) errors.push(`rule ${i + 1}: text is empty.`)
    if (text.length > MAX_RULE_CHARS) errors.push(`rule ${i + 1}: too long (${text.length} chars, max ${MAX_RULE_CHARS}); shorten it.`)
    const from = Array.isArray(r.from) ? r.from.map(String) : []
    const bad = from.filter((id) => !known(id))
    if (bad.length) errors.push(`rule ${i + 1}: unknown ids in from: ${bad.join(', ')}.`)
    if (r.doc && !docs.has(r.doc)) errors.push(`rule ${i + 1}: document "${r.doc}" does not exist; use an exact name from list_directory or omit doc.`)
  })
  const total = rules.reduce((s, r) => s + renderRule(r).length + 3, 0)
  if (total > MAX_RULES_CHARS) errors.push(`the rule set is too long (${total} chars, max ${MAX_RULES_CHARS}); merge or drop rules.`)
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    proposal: {
      rules: rules.map((r) => ({ text: String(r.text).trim(), doc: r.doc || null, from: (r.from || []).map(String) })),
      contradictions: Array.isArray(args.contradictions) ? args.contradictions.filter((c) => c && typeof c === 'object') : [],
      dropped: Array.isArray(args.dropped) ? args.dropped.map(String) : [],
    },
  }
}

// UI messages → Ollama messages, KEEPING tool calls and results (unlike the QA
// loop) so earlier ask_admin answers stay in the compiler's context.
function flattenCompileMessages(uiMessages) {
  const out = []
  for (const m of uiMessages || []) {
    if (m.role === 'user') {
      const t = Array.isArray(m.parts) ? m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('') : (m.content || '')
      if (t) out.push({ role: 'user', content: t })
      continue
    }
    if (m.role !== 'assistant') continue
    let text = ''
    for (const p of m.parts || []) {
      if (p.type === 'text') text += p.text
      if (p.type === 'tool-invocation') {
        const ti = p.toolInvocation
        if (ti.state !== 'result') continue
        out.push({ role: 'assistant', content: text, tool_calls: [{ function: { name: ti.toolName, arguments: ti.args || {} } }] })
        out.push({ role: 'tool', content: typeof ti.result === 'string' ? ti.result : JSON.stringify(ti.result) })
        text = ''
      }
    }
    if (text.trim()) out.push({ role: 'assistant', content: text })
  }
  return out
}

// ── Module factory ───────────────────────────────────────────────────────────
//
// deps (from chat.js):
//   dataDir, packagePrompt(), currentPrompt(), applyPrompt(text), currentModel(),
//   numCtx, streamOneOllamaTurn, listDirectory(args), listDocs(), pipeDataStreamToResponse,
//   formatDataStreamPart
function createLearning(deps) {
  const store = createStore(deps.dataDir)
  const compilePrompt = fs.readFileSync(path.join(__dirname, 'compile_prompt.md'), 'utf-8')
  try { store.init(deps.currentPrompt(), deps.packagePrompt()) } catch (e) { console.warn('[learning] init failed:', e.message) }

  const activeVersion = () => store.loadManifest()?.active ?? null

  function apply(v) {
    const text = store.readVersion(v)
    store.setActive(v)
    deps.applyPrompt(text)
    console.log(`[learning] applied prompt v${v} (${text.length} chars)`)
  }

  // A prompt saved from the Settings editor becomes a new manual version.
  function recordManual(text, { reset = false } = {}) {
    try {
      const m = store.loadManifest()
      if (m?.active != null && store.readVersion(m.active).trim() === String(text).trim()) return
      const v = store.createVersion({ text, source: reset ? 'package' : 'manual', parent: m?.active ?? null, label: reset ? 'reset to package default' : 'edited in Settings' })
      store.setActive(v)
    } catch (e) { console.warn('[learning] could not record manual prompt version:', e.message) }
  }

  function newSession(id, priorDecisions) {
    const activeV = activeVersion()
    const { rules } = splitPrompt(store.readVersion(activeV))
    const pending = store.feedbackWithStatus().filter((f) => f.status === 'new')
    const session = {
      id, ts: new Date().toISOString(), base_version: activeV,
      feedback_ids: pending.map((f) => f.id), rules,
      prior_decisions: Array.isArray(priorDecisions) ? priorDecisions : [],
      context: buildCompileContext({ activeV, rules, feedback: pending, priorDecisions }),
      proposal: null,
    }
    store.saveSession(session)
    return session
  }

  async function streamCompile({ writer, uiMessages, session, signal }) {
    const send = (type, value) => writer.write(deps.formatDataStreamPart(type, value))
    const rid = Math.random().toString(36).slice(2, 8)
    const messages = [{ role: 'system', content: `${compilePrompt.trim()}\n\n${session.context}` }, ...flattenCompileMessages(uiMessages)]
    const docs = new Set(deps.listDocs())
    const feedbackIds = new Set(session.feedback_ids)
    let promptTokens = 0, completionTokens = 0, emptyRetry = false

    for (let step = 0; step < MAX_COMPILE_STEPS; step++) {
      send('start_step', { messageId: `compile-${rid}-step-${step}` })
      const turn = await deps.streamOneOllamaTurn({
        messages, ollamaTools: COMPILE_TOOLS, temp: 0, numCtx: deps.numCtx, send, signal, knownTools: COMPILE_TOOL_NAMES,
      })
      promptTokens += turn.promptTokens
      completionTokens += turn.completionTokens
      const usage = { promptTokens: turn.promptTokens, completionTokens: turn.completionTokens }

      if (turn.toolCalls.length) {
        messages.push({ role: 'assistant', content: turn.content || '', tool_calls: turn.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })) })
        let stop = false
        for (const tc of turn.toolCalls) {
          if (tc.name === 'ask_admin') {
            // Client-side tool: emit the call with no result and end the turn. The
            // UI answers with addToolResult, which re-posts the conversation.
            send('tool_call', { toolCallId: `${rid}_${step}_${tc.id}`, toolName: tc.name, args: tc.args })
            stop = true
            break
          }
          const id = `${rid}_${step}_${tc.id}`
          send('tool_call', { toolCallId: id, toolName: tc.name, args: tc.args })
          let result
          if (tc.name === 'list_directory') {
            try { result = await deps.listDirectory(tc.args || {}) } catch (e) { result = { error: e.message } }
          } else if (tc.name === 'propose_rules') {
            const v = validateProposal(tc.args, { feedbackIds, ruleCount: session.rules.length, docs })
            if (v.ok) {
              session.proposal = v.proposal
              store.saveSession(session)
              result = { ok: true, ...v.proposal }
              stop = true
            } else {
              result = { ok: false, errors: v.errors, instruction: 'Fix these problems and call propose_rules again.' }
            }
          } else {
            result = { error: `Unknown tool ${tc.name}` }
          }
          send('tool_result', { toolCallId: id, result })
          messages.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) })
          if (stop) break
        }
        send('finish_step', { finishReason: 'tool-calls', usage, isContinued: false })
        if (stop) break
        continue
      }

      const content = (turn.content || '').trim()
      if (!content && !emptyRetry) {
        emptyRetry = true
        messages.push({ role: 'user', content: 'Your last reply was empty. Continue: ask the admin if something is unclear, otherwise call propose_rules.' })
        send('finish_step', { finishReason: 'stop', usage, isContinued: true })
        continue
      }
      // Plain text — the model is talking to the admin; hand the turn back.
      send('finish_step', { finishReason: 'stop', usage, isContinued: false })
      break
    }
    send('finish_message', { finishReason: 'stop', usage: { promptTokens, completionTokens } })
  }

  function approve(sessionId, transcript) {
    const s = store.loadSession(sessionId)
    if (!s) return { code: 404, error: 'Unknown compile session.' }
    if (!s.proposal) return { code: 409, error: 'This session has no proposal yet.' }
    const activeV = activeVersion()
    if (activeV !== s.base_version) return { code: 409, error: `The active prompt changed (v${s.base_version} → v${activeV}) since this compile started. Re-run the compile.` }
    const { base } = splitPrompt(store.readVersion(activeV))
    const m = store.loadManifest()
    const nextV = m.versions.reduce((mx, x) => Math.max(mx, x.v), 0) + 1
    const text = buildPrompt(base, s.proposal.rules.map(renderRule), nextV)
    const v = store.createVersion({ text, source: 'compiled', parent: activeV, label: `compiled from ${s.feedback_ids.length} feedback`, feedback_ids: s.feedback_ids })
    store.markApplied(s.feedback_ids, v)
    s.approved_as = v
    if (Array.isArray(transcript)) s.transcript = transcript
    store.saveSession(s)
    apply(v)
    return { code: 200, v }
  }

  // Returns true when the request was handled.
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const M = req.method
    if (!(p === '/feedback' || p.startsWith('/feedback/') || p.startsWith('/learning/'))) return false

    try {
      // ── Feedback ──
      if (M === 'GET' && p === '/feedback') return sendJson(res, 200, { items: store.feedbackWithStatus(), active: activeVersion() }), true
      if (M === 'POST' && p === '/feedback') return sendJson(res, 200, store.upsertFeedback(await readJson(req))), true
      let mm
      if ((mm = p.match(/^\/feedback\/(F\d+)$/))) {
        if (M === 'PATCH') {
          const f = store.patchFeedback(mm[1], await readJson(req))
          return f ? sendJson(res, 200, f) : sendJson(res, 404, { error: 'Unknown feedback id.' }), true
        }
        if (M === 'DELETE') return store.deleteFeedback(mm[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Unknown feedback id.' }), true
      }

      // ── Prompt versions ──
      if (M === 'GET' && p === '/learning/versions') return sendJson(res, 200, store.versionsWithStats()), true
      if ((mm = p.match(/^\/learning\/versions\/(\d+)$/))) {
        const v = Number(mm[1])
        if (M === 'GET') {
          let text
          try { text = store.readVersion(v) } catch { return sendJson(res, 404, { error: 'No such version.' }), true }
          const meta = store.loadManifest().versions.find((x) => x.v === v)
          return sendJson(res, 200, { ...meta, text, ...splitPrompt(text) }), true
        }
        if (M === 'DELETE') {
          const r = store.deleteVersion(v)
          return r.ok ? sendJson(res, 200, r) : sendJson(res, r.code, { error: r.error }), true
        }
      }
      if (M === 'POST' && (mm = p.match(/^\/learning\/apply\/(\d+)$/))) {
        const v = Number(mm[1])
        if (!store.loadManifest()?.versions.some((x) => x.v === v)) return sendJson(res, 404, { error: 'No such version.' }), true
        apply(v)
        return sendJson(res, 200, { ok: true, active: v }), true
      }
      if (M === 'POST' && p === '/learning/import') {
        const body = await readJson(req)
        const name = String(body.filename || 'imported.md')
        const text = String(body.text || '')
        if (/\.json$/i.test(name)) {
          let backup
          try { backup = JSON.parse(text) } catch { return sendJson(res, 400, { error: 'The file is not valid JSON.' }), true }
          const active = store.restoreBackup(backup)
          apply(active)
          return sendJson(res, 200, { ok: true, restored: true, active }), true
        }
        const clean = text.replace(/^﻿/, '').replace(EXPORT_HEADER_RE, '').trim()
        if (!clean) return sendJson(res, 400, { error: 'The file is empty.' }), true
        const v = store.createVersion({ text: clean, source: 'imported', parent: null, label: name })
        return sendJson(res, 200, { ok: true, v }), true
      }
      if (M === 'GET' && p === '/learning/export-all') return sendJson(res, 200, store.exportAll()), true

      // ── Compile ──
      if (M === 'POST' && p === '/learning/compile/chat') {
        const model = deps.currentModel()
        if (!model) return sendJson(res, 503, { error: 'No model is loaded.' }), true
        const body = await readJson(req)
        const sid = String(body.sessionId || '')
        if (!/^[\w-]{6,64}$/.test(sid)) return sendJson(res, 400, { error: 'Invalid sessionId.' }), true
        const session = store.loadSession(sid) || newSession(sid, body.priorDecisions)
        if (!session.feedback_ids.length && !session.rules.length) {
          return sendJson(res, 409, { error: 'There is no pending feedback to compile.' }), true
        }
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) ac.abort() })
        deps.pipeDataStreamToResponse(res, {
          onError: (e) => (e && e.message) || String(e),
          execute: async (writer) => {
            try { await streamCompile({ writer, uiMessages: body.messages, session, signal: ac.signal }) }
            catch (e) { if (ac.signal.aborted) return; console.error('[learning] compile error:', e?.message); throw e }
          },
        })
        return true
      }
      if (M === 'GET' && (mm = p.match(/^\/learning\/compile\/session\/([\w-]+)$/))) {
        const s = store.loadSession(mm[1])
        return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'Unknown compile session.' }), true
      }
      if (M === 'POST' && p === '/learning/compile/approve') {
        const body = await readJson(req)
        const r = approve(String(body.sessionId || ''), body.transcript)
        return r.code === 200 ? sendJson(res, 200, { ok: true, v: r.v }) : sendJson(res, r.code, { error: r.error }), true
      }
    } catch (e) {
      console.error('[learning] request failed:', e.message)
      sendJson(res, 400, { error: e.message })
      return true
    }
    sendJson(res, 404, { error: 'Not found' })
    return true
  }

  return { handle, activeVersion, recordManual, store }
}

module.exports = {
  createLearning, createStore, splitPrompt, buildPrompt, renderRule, validateProposal,
  buildCompileContext, flattenCompileMessages, LEARNED_MARKER,
}
