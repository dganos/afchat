'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { scoreTone } from '@/lib/learning-api'
import { cn } from '@/lib/utils'

// Small centered modal opened after picking a score: one optional free-text note.
export function FeedbackModal({ open, score, initialNote = '', onSave, onClose }) {
  const [note, setNote] = useState(initialNote)
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (open) { setNote(initialNote); setTimeout(() => ref.current?.focus(), 0) }
  }, [open, initialNote])

  if (!open) return null

  const save = async () => {
    setSaving(true)
    try { await onSave(note) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="relative w-full max-w-md rounded-lg border border-border bg-background shadow-2xl p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className={cn('inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-sm font-semibold tabular-nums', scoreTone(score))}>
            {score}/5
          </span>
          <h3 id="feedback-title" className="text-sm font-semibold text-fg">מה היה לא בסדר בתשובה?</h3>
          <button onClick={onClose} aria-label="סגור" className="ms-auto p-1 rounded hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" />
          </button>
        </div>
        <textarea
          ref={ref}
          dir="auto"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="לדוגמה: התשובה הנכונה היא 90 יום, והיא מופיעה ב-medical-equipment.md"
          className="w-full h-28 resize-y rounded-md border border-border bg-surface-2 p-2 text-sm leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="mt-1 text-[11px] text-fg-faint">לא חובה. ההערה תשמש לשיפור ההנחיות של אריסטו.</p>
        <div className="flex items-center gap-2 justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors"
          >
            דלג
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            שמור
          </button>
        </div>
      </div>
    </div>
  )
}
