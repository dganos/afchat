'use client'

import { useState } from 'react'
import { learningApi, scoreTone } from '@/lib/learning-api'
import { FeedbackModal } from '@/components/feedback-modal'
import { cn } from '@/lib/utils'

const LABELS = { 1: 'שגויה לגמרי', 2: 'שגויה ברובה', 3: 'נכונה חלקית', 4: 'כמעט נכונה', 5: 'נכונה לגמרי' }

// 1–5 score buttons at the end of an answer. Picking a score saves it right away,
// then opens a small modal for an optional note (Skip keeps the score only).
export function ScoreRow({ msgId, question, answer, promptVersion, model }) {
  const [score, setScore] = useState(null)
  const [note, setNote] = useState('')
  const [modalScore, setModalScore] = useState(null)
  const [error, setError] = useState(null)

  const save = async (s, n) => {
    setError(null)
    try {
      await learningApi.saveFeedback({ msg_id: msgId, score: s, note: n, question, answer, prompt_version: promptVersion, model })
      return true
    } catch (e) { setError(e.message); return false }
  }

  const pick = async (s) => {
    setScore(s)
    setModalScore(s)
    await save(s, undefined)  // keep any earlier note
  }

  return (
    <div className="flex items-center gap-1.5 px-1 mt-1" dir="rtl">
      <span className="text-[11px] text-fg-faint me-0.5">דירוג:</span>
      <div role="radiogroup" aria-label="דירוג התשובה" className="flex items-center gap-1" dir="ltr">
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={score === s}
            aria-label={`${s} — ${LABELS[s]}`}
            title={`${s} — ${LABELS[s]}`}
            onClick={() => pick(s)}
            className={cn(
              'h-6 w-6 rounded-md border text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              score === s ? scoreTone(s) : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'
            )}
          >
            {s}
          </button>
        ))}
      </div>
      {score != null && note && <span className="text-[11px] text-fg-faint truncate max-w-[16rem]" dir="auto" title={note}>· {note}</span>}
      {error && <span className="text-[11px] text-wrong-text">{error}</span>}
      <FeedbackModal
        open={modalScore != null}
        score={modalScore}
        initialNote={note}
        onClose={() => setModalScore(null)}
        onSave={async (n) => { if (await save(modalScore, n)) { setNote(n.trim()); setModalScore(null) } }}
      />
    </div>
  )
}
