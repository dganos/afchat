// In-memory ring buffer of server logs (ollama + api) for the web admin page and
// the Logs panel, plus an append-only log file so a background server can be
// inspected after the fact. One process-wide instance (module cache).
const fs = require('fs')
const path = require('path')

const MAX = 2000
const entries = []   // { seq, time, source, text }
let seq = 0
let fileStream = null

function setLogFile(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fileStream = fs.createWriteStream(file, { flags: 'a' })
  } catch { fileStream = null }
}

function push(source, text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim())
  for (const line of lines) {
    const e = { seq: ++seq, time: new Date().toISOString(), source, text: line }
    entries.push(e)
    if (fileStream) fileStream.write(`${e.time} [${source}] ${line}\n`)
  }
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

// Entries with seq > since (optionally one source), newest last.
function since(after = 0, source = null, limit = 500) {
  const out = entries.filter(e => e.seq > after && (!source || e.source === source))
  return out.slice(-limit)
}

module.exports = { push, since, setLogFile }
