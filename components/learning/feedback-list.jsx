'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, Search } from 'lucide-react'
import { learningApi, scoreTone } from '@/lib/learning-api'
import { cn } from '@/lib/utils'

const chip = 'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium'

// User corrections. One live list of everything not yet compiled: a checkbox marks
// each item for the next compilation (unchecked = stays pending for a later one).
// Items already compiled into the active prompt sit below in a collapsed, greyed,
// read-only list. Edits save immediately (note on blur). On the server, "unchecked"
// is the feedback's `excluded` flag; only checked items are sent to the compiler.
// `highlight`: ids to mark (e.g. referenced by the compiler); the first one is scrolled into view.
export function FeedbackList({ items, onChanged, highlight = [], onPick, locked = false, emptyText = 'אין תיקונים שטרם קומפלו.' }) {
  const [q, setQ] = useState('')
  const [toDelete, setToDelete] = useState(null)
  const [err, setErr] = useState(null)

  const shown = useMemo(() => items.filter((f) =>
    !q || `${f.id} ${f.question} ${f.answer} ${f.note}`.toLowerCase().includes(q.toLowerCase())
  ).slice().reverse(), [items, q])
  const open = shown.filter((f) => f.status !== 'applied')
  const compiled = shown.filter((f) => f.status === 'applied')
  const selected = open.filter((f) => f.status === 'new').length

  const refs = useRef({})
  useEffect(() => {
    const first = highlight.find((id) => refs.current[id])
    if (first) refs.current[first].scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [highlight.join(',')])

  const setSelected = async (list, on) => {
    setErr(null)
    try {
      await Promise.all(list.filter((f) => (f.status === 'new') !== on).map((f) => learningApi.patchFeedback(f.id, { excluded: !on })))
    } catch (e) { setErr(e.message) }
    onChanged?.()
  }

  const confirmDelete = async () => {
    const f = toDelete
    setToDelete(null)
    try { await learningApi.deleteFeedback(f.id) } catch (e) { setErr(e.message) }
    onChanged?.()
  }

  const allOn = open.length > 0 && selected === open.length

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <label className="flex items-center gap-2 text-xs text-fg-muted cursor-pointer select-none" title="סמן הכל לקומפילציה">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => { if (el) el.indeterminate = selected > 0 && !allOn }}
            onChange={() => setSelected(open, !allOn)}
            disabled={locked || open.length === 0}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="tabular-nums">{selected} מתוך {open.length} נבחרו לקומפילציה</span>
        </label>
        <div className="relative ms-auto w-44">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="חיפוש"
            dir="auto"
            className="h-8 w-full rounded-md border border-border bg-surface-2 ps-7 pe-2 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      {err && <p className="px-3 pt-2 text-[11px] text-wrong-text">{err}</p>}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {open.length === 0 && <p className="text-sm text-fg-muted text-center py-8">{emptyText}</p>}
        {open.map((f) => (
          <FeedbackItem
            key={f.id}
            f={f}
            refEl={(el) => { refs.current[f.id] = el }}
            highlighted={highlight.includes(f.id)}
            locked={locked}
            onToggle={(on) => setSelected([f], on)}
            onDelete={() => setToDelete(f)}
            onChanged={onChanged}
            onPick={onPick}
          />
        ))}
        {compiled.length > 0 && (
          <details className="pt-4">
            <summary className="cursor-pointer select-none px-1 text-[11px] text-fg-faint hover:text-fg-muted">
              כבר קומפלו ({compiled.length})
            </summary>
            <div className="mt-2 space-y-1.5">
              {compiled.map((f) => <CompiledItem key={f.id} f={f} />)}
            </div>
          </details>
        )}
      </div>

      {toDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" dir="rtl">
          <div className="absolute inset-0 bg-black/40" onClick={() => setToDelete(null)} />
          <div className="relative w-full max-w-sm rounded-lg border border-border bg-background shadow-2xl p-5" role="dialog" aria-modal="true" aria-labelledby="del-title">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex items-center justify-center h-8 w-8 rounded-full bg-wrong shrink-0">
                <Trash2 className="h-4 w-4 text-wrong-text" />
              </div>
              <h3 id="del-title" className="text-sm font-semibold text-fg">למחוק את {toDelete.id}?</h3>
            </div>
            <p className="text-sm text-fg-muted mb-1" dir="auto">{toDelete.question}</p>
            <p className="text-sm text-fg-muted mb-4">התיקון יימחק לצמיתות ולא ייכלל באף קומפילציה.</p>
            <div className="flex items-center gap-2 justify-end">
              <button autoFocus onClick={() => setToDelete(null)} className="px-4 py-2 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2">ביטול</button>
              <button onClick={confirmDelete} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-wrong-text text-white hover:opacity-90">
                <Trash2 className="h-4 w-4" />מחק
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Already compiled into the active prompt: read-only, greyed, compact.
function CompiledItem({ f }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2 opacity-60">
      <div className="flex items-center gap-1.5 text-[10px] text-fg-faint">
        <span className="font-mono">{f.id}</span>
        <span className="tabular-nums">{f.score}/5</span>
        <span>· קומפל ל-v{f.applied_in}</span>
      </div>
      <p className="mt-0.5 text-xs text-fg-muted truncate" dir="auto">{f.question}</p>
      {f.note && <p className="text-[11px] text-fg-faint truncate" dir="auto">{f.note}</p>}
    </div>
  )
}

function FeedbackItem({ f, refEl, highlighted, locked, onToggle, onDelete, onChanged, onPick }) {
  const [note, setNote] = useState(f.note || '')
  const [err, setErr] = useState(null)
  useEffect(() => { setNote(f.note || '') }, [f.note])
  const on = f.status === 'new'

  const patch = async (p) => {
    setErr(null)
    try { await learningApi.patchFeedback(f.id, p); onChanged?.(f.id) } catch (e) { setErr(e.message) }
  }

  return (
    <div
      ref={refEl}
      className={cn(
        'flex gap-2.5 rounded-lg border p-3 transition-shadow',
        highlighted ? 'border-primary ring-2 ring-primary-soft' : 'border-border',
        on ? 'bg-surface' : 'bg-surface-2'
      )}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onToggle(e.target.checked)}
        disabled={locked}
        aria-label={`כלול את ${f.id} בקומפילציה`}
        title={on ? 'ייכלל בקומפילציה הבאה' : 'ממתין — לא ייכלל בקומפילציה הבאה'}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
      />
      <div className={cn('flex-1 min-w-0', !on && 'opacity-60')}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => onPick?.(f.id)}
            disabled={!onPick}
            title={onPick ? 'הוסף הפניה לשיחת הקומפילציה' : undefined}
            className={cn('font-mono text-[11px] text-fg-muted', onPick && 'hover:text-primary underline-offset-2 hover:underline')}
          >
            {f.id}
          </button>
          <select
            value={f.score}
            onChange={(e) => patch({ score: Number(e.target.value) })}
            aria-label={`דירוג ${f.id}`}
            className={cn(chip, 'appearance-none cursor-pointer tabular-nums', scoreTone(f.score))}
          >
            {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}/5</option>)}
          </select>
          {!on && <span className={cn(chip, 'bg-surface text-fg-faint border-border')}>ממתין</span>}
          {f.prompt_version != null && <span className="text-[10px] text-fg-faint">נענה ע״י v{f.prompt_version}</span>}
          <span className="text-[10px] text-fg-faint">{new Date(f.ts).toLocaleDateString('he-IL')}</span>
          {f.edited_at && <span className="text-[10px] text-fg-faint" title={`הערה מקורית: ${f.original_note || '(ריקה)'}`}>· נערך</span>}
          <button onClick={onDelete} disabled={locked} title="מחק" aria-label={`מחק את ${f.id}`} className="ms-auto p-1 rounded text-fg-faint hover:bg-surface-2 hover:text-wrong-text disabled:opacity-40">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-sm font-medium text-fg" dir="auto">{f.question || '(ללא שאלה)'}</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-fg-faint hover:text-fg-muted select-none">התשובה שניתנה</summary>
          <p className="mt-1 text-xs text-fg-muted whitespace-pre-wrap max-h-40 overflow-y-auto" dir="auto">{f.answer}</p>
        </details>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (note.trim() !== (f.note || '')) patch({ note }) }}
          placeholder="הערה (מה היה לא בסדר / מה התשובה הנכונה)"
          dir="auto"
          rows={note ? 2 : 1}
          className="mt-2 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {err && <p className="mt-1 text-[11px] text-wrong-text">{err}</p>}
      </div>
    </div>
  )
}
