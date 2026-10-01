// Client for the Continuous Learning routes in api/learning.js.
export const API = 'http://localhost:3001'

async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `${method} ${path} failed (${r.status})`)
  return data
}

export const learningApi = {
  saveFeedback: (fb) => call('POST', '/feedback', fb),
  listFeedback: () => call('GET', '/feedback'),
  patchFeedback: (id, patch) => call('PATCH', `/feedback/${id}`, patch),
  deleteFeedback: (id) => call('DELETE', `/feedback/${id}`),
  versions: () => call('GET', '/learning/versions'),
  version: (v) => call('GET', `/learning/versions/${v}`),
  apply: (v) => call('POST', `/learning/apply/${v}`),
  deleteVersion: (v) => call('DELETE', `/learning/versions/${v}`),
  importFile: (filename, text) => call('POST', '/learning/import', { filename, text }),
  exportAll: () => call('GET', '/learning/export-all'),
  approve: (sessionId, transcript) => call('POST', '/learning/compile/approve', { sessionId, transcript }),
}

// Save text as a file. In Electron this opens the native save dialog.
export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Score → design-token classes (1–2 wrong, 3 review, 4–5 correct).
export function scoreTone(score) {
  if (score <= 2) return 'bg-wrong text-wrong-text border-wrong-border'
  if (score === 3) return 'bg-review text-review-text border-review-border'
  return 'bg-correct text-correct-text border-correct-border'
}
