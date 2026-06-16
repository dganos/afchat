// Agent packages: the single source of truth for an agent's inference behaviour —
// MODEL + RUNTIME + TOOL CONTRACTS (name/description/JSON-schema) + SYSTEM PROMPT.
// The SAME package folder is loaded by afchat_lab (Python) and by this app; neither
// holds the prompt, tool descriptions, or runtime knobs internally.
//
//   packages/gemma4-qa/package.json     — model, runtime, tools[{name,description,parameters}]
//   packages/gemma4-qa/system_prompt.md — the system prompt text
//
// loadPackage() returns the package object with `.system_prompt` and a
// `.toolAllowlist` convenience.

const fs = require('fs')
const path = require('path')

function loadPackage(pkgPath) {
  const jsonPath = fs.statSync(pkgPath).isDirectory() ? path.join(pkgPath, 'package.json') : pkgPath
  const dir = path.dirname(jsonPath)
  const pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  for (const key of ['name', 'model', 'tools', 'system_prompt_file']) {
    if (!pkg[key]) throw new Error(`agent package ${jsonPath} missing required key: ${key}`)
  }
  pkg.system_prompt = fs.readFileSync(path.join(dir, pkg.system_prompt_file), 'utf-8').trim()
  pkg.runtime = pkg.runtime || {}
  pkg.toolAllowlist = pkg.tools.map(t => t.name)
  return pkg
}

// The package model id is provider-specific (e.g. LM Studio "google/gemma-4-e4b").
// Aristo runs on Ollama, so resolve the package model to an installed Ollama tag
// best-effort: exact match, then by the basename, then by prefix. Returns null if
// nothing matches (caller falls back to auto-selection).
function resolveOllamaModel(installed, pkgModelId) {
  if (!pkgModelId || !installed || !installed.length) return null
  const names = installed.map(m => m.name)
  const id = pkgModelId.toLowerCase()
  const base = id.split('/').pop() // "google/gemma-4-e4b" -> "gemma-4-e4b"
  const lc = n => n.toLowerCase()
  return (
    names.find(n => lc(n) === id || lc(n) === base) ||
    names.find(n => lc(n).startsWith(base)) ||
    names.find(n => lc(n).split(':')[0] === base) ||
    null
  )
}

module.exports = { loadPackage, resolveOllamaModel }
