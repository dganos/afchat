'use client'

import { useState } from 'react'
import { Plus, Trash2, MessageSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Storage ────────────────────────────────────────────────────────────────
// Conversation history lives in localStorage under one key: an array of
// { id, title, createdAt, updatedAt, messages, compaction?, durations? }.
export const SESSIONS_KEY = 'aristo-sessions'
export const MAX_SESSIONS = 100
const TITLE_MAX = 60

export const newSessionId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export function sessionTitle(messages) {
  const first = messages.find((m) => m.role === 'user')
  const text = ((first?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ') || first?.content || '')
    .replace(/\s+/g, ' ').trim()
  if (!text) return 'שיחה ללא כותרת'
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX).trimEnd() + '…' : text
}

// Messages round-trip through JSON; restore createdAt as a Date like useChat makes it.
const reviveMessages = (msgs) =>
  (Array.isArray(msgs) ? msgs : []).map((m) => (m && m.createdAt ? { ...m, createdAt: new Date(m.createdAt) } : m))

export function loadSessions() {
  if (typeof window === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((s) => s && s.id && Array.isArray(s.messages))
      .map((s) => ({ ...s, messages: reviveMessages(s.messages) }))
  } catch { return [] }
}

const isQuotaError = (e) =>
  e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014)

// Write the list (newest first, capped). If the quota is hit, drop the oldest
// sessions — never the one being kept (`keepId`) — until it fits. Returns
// { list, failed }: the list to show, and null | 'quota' (the kept session alone
// is too big) | 'error' when nothing was written.
export function saveSessions(sessions, keepId) {
  let list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
  for (;;) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list))
      return { list, failed: null }
    } catch (e) {
      if (!isQuotaError(e)) { console.error('Failed to save sessions:', e); return { list, failed: 'error' } }
      // list is newest-first → drop the last (oldest) one that isn't kept
      let dropIdx = -1
      for (let i = list.length - 1; i >= 0; i--) if (list[i].id !== keepId) { dropIdx = i; break }
      if (dropIdx < 0) { console.warn('Session history exceeds storage quota; not saved'); return { list, failed: 'quota' } }
      list = list.filter((_, i) => i !== dropIdx)
    }
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────
const fmtDate = (ts) => {
  try {
    const d = new Date(ts)
    const now = new Date()
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' })
  } catch { return '' }
}

// Conversation history on the physical LEFT edge of the window. Collapsible to
// a thin rail so it doesn't steal width on small windows.
export function SessionSidebar({ sessions, activeId, onSelect, onNew, onDelete, collapsed, onToggle, saveFailed }) {
  const [confirmId, setConfirmId] = useState(null)
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const confirming = sessions.find((s) => s.id === confirmId)

  const iconBtn = 'flex items-center justify-center h-9 w-9 text-fg-muted rounded-md hover:bg-surface-2 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  if (collapsed) {
    return (
      <aside dir="rtl" aria-label="היסטוריית שיחות" className="flex flex-col items-center gap-1 w-12 shrink-0 h-full border-r border-border bg-surface py-2">
        <button onClick={onToggle} aria-label="הצג היסטוריית שיחות" title="הצג היסטוריית שיחות" className={iconBtn}>
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button onClick={onNew} aria-label="שיחה חדשה" title="שיחה חדשה" className={iconBtn}>
          <Plus className="h-4 w-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside dir="rtl" aria-label="היסטוריית שיחות" className="flex flex-col w-64 shrink-0 h-full border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-sm font-medium text-fg">שיחות</span>
        <button onClick={onToggle} aria-label="הסתר היסטוריית שיחות" title="הסתר היסטוריית שיחות" className={cn(iconBtn, 'ms-auto')}>
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3 py-2">
        <button
          onClick={onNew}
          className="flex items-center justify-center gap-2 w-full px-3 min-h-9 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" />
          שיחה חדשה
        </button>
      </div>

      {saveFailed && (
        <p role="status" className="mx-3 mb-2 rounded-md border border-wrong-border bg-wrong px-2 py-1.5 text-[11px] text-wrong-text">
          {saveFailed === 'quota' ? 'השיחה גדולה מדי לשמירה' : 'שמירת השיחה נכשלה'}
        </p>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="רשימת שיחות">
        {sorted.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-fg-faint">אין עדיין שיחות שמורות</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map((s) => {
              const active = s.id === activeId
              return (
                <li key={s.id} className="group relative">
                  <button
                    onClick={() => onSelect(s.id)}
                    aria-current={active ? 'true' : undefined}
                    title={s.title}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md ps-2 pe-9 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary-soft text-fg font-medium' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                    )}
                  >
                    <MessageSquare className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', active ? 'text-primary' : 'text-fg-faint')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" dir="auto">{s.title}</span>
                      <span className="block text-[11px] text-fg-faint tabular-nums">{fmtDate(s.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => setConfirmId(s.id)}
                    aria-label={`מחק שיחה: ${s.title}`}
                    title="מחק שיחה"
                    className="absolute top-1.5 end-1.5 flex items-center justify-center h-7 w-7 rounded-md text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-wrong hover:text-wrong-text transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      {/* Delete confirmation — centered modal over the whole window */}
      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" dir="rtl">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmId(null)} />
          <div role="alertdialog" aria-modal="true" aria-labelledby="del-session-title" className="relative w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-xl">
            <h3 id="del-session-title" className="text-sm font-semibold text-fg">למחוק את השיחה?</h3>
            <p className="mt-2 text-sm text-fg-muted truncate" dir="auto">{confirming.title}</p>
            <p className="mt-1 text-xs text-fg-faint">לא ניתן לשחזר את השיחה לאחר המחיקה.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmId(null)}
                className="px-3 min-h-9 text-sm rounded-md border border-border text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ביטול
              </button>
              <button
                onClick={() => { onDelete(confirming.id); setConfirmId(null) }}
                autoFocus
                className="px-3 min-h-9 text-sm font-medium rounded-md bg-destructive text-destructive-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                מחק
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
