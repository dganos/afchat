// Loop-conformance test (app side).
//
// Replays the shared scenarios in packages/gemma4-qa/loop-conformance-scenarios.json
// through the APP agent loop (streamChatResponse) with streamOneOllamaTurn and the
// tools mocked, and asserts the recovery-nudge sequence matches the spec — the SAME
// spec the lab asserts (afchat_lab/tests/test_loop_conformance.py). Together they
// guarantee the two duplicated agent loops recover identically.
//
// chat.js starts an HTTP server on require and only exports { server }, so we drive
// the loop by slicing out isRefusal + streamChatResponse and evaluating them against
// mocked dependencies — no server, no Ollama.
//
// Run: node api/loop-conformance.test.js

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.resolve(__dirname, '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/gemma4-qa/package.json'), 'utf-8'))
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/gemma4-qa/loop-conformance-scenarios.json'), 'utf-8'))

// Pull isRefusal + streamChatResponse out of chat.js (avoids the require side-effects).
const src = fs.readFileSync(path.join(ROOT, 'api/chat.js'), 'utf-8')
const span = src.slice(src.indexOf('// A "not found in the documents"'), src.indexOf('const server = http.createServer'))

// Mocked module-scope dependencies streamChatResponse closes over.
const AGENT = PKG
const buildOllamaTools = () => []
const capToolResult = (x) => x
const formatDataStreamPart = () => ''
let currentQuestion = ''
let TOOL_IMPLS = {}
let streamOneOllamaTurn = async () => ({ content: '', toolCalls: [], promptTokens: 0, completionTokens: 0 })

eval(span + '\n; globalThis.__streamChatResponse = streamChatResponse;')

const rec = PKG.runtime.recovery
const LABEL = {
  [rec.empty_turn_nudge]: 'empty',
  [rec.refusal_pointer_nudge]: 'pointer',
  [rec.max_steps_final]: 'final',
}

async function runScenario(scn) {
  // Build the ordered model responses + tool outputs from the scenario turns.
  const responses = []
  const toolResults = []
  for (const t of scn.turns) {
    if (t.tools) {
      responses.push({ toolCalls: t.tools.map((x, i) => ({ id: `c${i}_${x.name}`, name: x.name, args: x.args || {} })), content: '' })
      for (const x of t.tools) toolResults.push(x.result)
    } else {
      responses.push({ toolCalls: [], content: t.content || '' })
    }
  }
  let ri = 0, ti = 0
  const nudges = []

  streamOneOllamaTurn = async ({ messages }) => {
    // A nudge is the last user message the loop appended before this call.
    const last = messages[messages.length - 1]
    if (last && last.role === 'user' && LABEL[last.content] && !nudges.includes(LABEL[last.content])) {
      nudges.push(LABEL[last.content])
    }
    const r = responses[ri++] || { toolCalls: [], content: '' }
    return { ...r, promptTokens: 0, completionTokens: 0 }
  }
  TOOL_IMPLS = { search_content: async () => toolResults[ti++] ?? '', list_directory: async () => '', read_text_file: async () => '' }

  const writer = { write: () => {} }
  await globalThis.__streamChatResponse({
    writer, systemPrompt: PKG.system_prompt,
    uiMessages: [{ role: 'user', content: 'Q?' }],
    signal: { aborted: false },
  })
  return nudges
}

;(async () => {
  assert.strictEqual(SPEC.max_steps, PKG.runtime.max_steps, 'spec max_steps must match package')
  let failed = 0
  for (const scn of SPEC.scenarios) {
    const got = await runScenario(scn)
    try {
      assert.deepStrictEqual(got, scn.expect_nudges)
      console.log(`  ok   ${scn.name}  nudges=[${got}]`)
    } catch {
      failed++
      console.log(`  FAIL ${scn.name}  expected=[${scn.expect_nudges}] got=[${got}]`)
    }
  }
  if (failed) { console.error(`\n${failed} scenario(s) failed`); process.exit(1) }
  console.log(`\nAll ${SPEC.scenarios.length} scenarios conform.`)
})()
