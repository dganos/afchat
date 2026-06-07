// Agent packages: a self-contained bundle of MODEL + SYSTEM PROMPT + TOOLS
// (plus the runtime knobs they were tuned with). The source of truth is the YAML
// in afchat_lab/packages/; a JSON mirror is exported for this app to load without
// a YAML dependency (see afchat_lab/scripts/export_package.py).
//
// loadPackage() returns the package object with a `.toolAllowlist` convenience.

const fs = require('fs')

function loadPackage(file) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'))
  for (const key of ['name', 'model', 'tools', 'system_prompt']) {
    if (!pkg[key]) throw new Error(`agent package ${file} missing required key: ${key}`)
  }
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
