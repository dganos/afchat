// Client for the server's /admin endpoints (see handleAdmin in api/chat.js).
export const API = 'http://localhost:3001'
const H = { 'X-Aristo-Admin': '1' }

export async function adminGet(path) {
  const r = await fetch(`${API}/admin/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function adminPost(path) {
  const r = await fetch(`${API}/admin/${path}`, { method: 'POST', headers: H })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `${r.status}`)
  return body
}
