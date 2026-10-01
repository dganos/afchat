'use client'

import { useEffect, useRef, useState } from 'react'
import { Upload, Download, Archive, Check, Trash2, GitCompare, FileText } from 'lucide-react'
import { learningApi, downloadText } from '@/lib/learning-api'
import { cn } from '@/lib/utils'

const SOURCE = { package: 'חבילה', compiled: 'קומפילציה', manual: 'עריכה ידנית', imported: 'יובא' }
const MARKER = '<!-- aristo:learned -->'

// Minimal LCS line diff — prompts are ~100–200 lines, so O(n·m) is fine.
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n')
  const n = A.length, m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', A[i++]])
    else out.push(['+', B[j++]])
  }
  while (i < n) out.push(['-', A[i++]])
  while (j < m) out.push(['+', B[j++]])
  return out
}

export function PromptsTab({ data, onChanged }) {
  const [selected, setSelected] = useState(null)
  const [mode, setMode] = useState('view')       // 'view' | 'diff'
  const [text, setText] = useState('')
  const [activeText, setActiveText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)           // { ok, text }
  const [confirm, setConfirm] = useState(null)   // { title, body, action }
  const fileRef = useRef(null)

  const versions = (data?.versions || []).slice().reverse()
  const active = data?.active

  useEffect(() => { if (active != null) { setSelected(active); setMode('view'); if (!busy) setMsg(null) } }, [active])  // changed elsewhere (e.g. compile approve) → drop stale status
  useEffect(() => {
    if (selected == null) return
    learningApi.version(selected).then((r) => setText(r.text)).catch(() => setText(''))
  }, [selected, active])
  useEffect(() => {
    if (active == null) return
    learningApi.version(active).then((r) => setActiveText(r.text)).catch(() => setActiveText(''))
  }, [active])

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null)
    try { const r = await fn(); setMsg({ ok: true, text: typeof okText === 'function' ? okText(r) : okText }); await onChanged() }
    catch (e) { setMsg({ ok: false, text: e.message }) }
    finally { setBusy(false) }
  }

  const exportVersion = async (v) => {
    const r = await learningApi.version(v)
    downloadText(`aristo-prompt-v${v}.md`, `<!-- aristo-prompt v${v} · ${r.source} · ${r.ts} -->\n\n${r.text}\n`)
  }

  const exportAll = async () => {
    const b = await learningApi.exportAll()
    downloadText(`aristo-learning-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b, null, 2), 'application/json')
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const content = await file.text()
    if (/\.json$/i.test(file.name)) {
      setConfirm({
        title: 'לשחזר מגיבוי?',
        body: `כל גרסאות ההנחיות והתיקונים הנוכחיים יוחלפו בתוכן של ${file.name}, והגרסה הפעילה בגיבוי תוחל.`,
        action: () => run(() => learningApi.importFile(file.name, content), (r) => `שוחזר מגיבוי — v${r.active} פעילה`),
      })
    } else {
      run(() => learningApi.importFile(file.name, content), (r) => `יובא כ-v${r.v} (לא הוחל)`).then(() => {})
    }
  }

  const sel = data?.versions?.find((x) => x.v === selected)
  const btn = 'inline-flex items-center gap-1.5 px-2.5 h-8 text-xs font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors disabled:opacity-50'

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      {/* Versions list */}
      <div className="md:w-[26rem] md:border-e border-b md:border-b-0 border-border flex flex-col min-h-0 max-h-[45vh] md:max-h-none">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <h2 className="text-xs font-medium text-fg-muted">גרסאות</h2>
          <div className="ms-auto flex items-center gap-1.5">
            <input ref={fileRef} type="file" accept=".md,.txt,.json" className="hidden" onChange={onFile} />
            <button className={btn} onClick={() => fileRef.current?.click()} disabled={busy}><Upload className="h-3.5 w-3.5" />ייבוא…</button>
            <button className={btn} onClick={exportAll} disabled={busy} title="גיבוי של כל הגרסאות והתיקונים"><Archive className="h-3.5 w-3.5" />ייצוא הכל</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {versions.map((x) => (
            <button
              key={x.v}
              onClick={() => { setSelected(x.v); setMode('view'); setMsg(null) }}
              className={cn(
                'w-full text-start px-4 py-2.5 border-b border-border flex items-center gap-3 hover:bg-surface-2 transition-colors',
                selected === x.v && 'bg-surface-2'
              )}
            >
              <span className="font-mono text-sm font-semibold text-fg w-12 shrink-0" dir="ltr">v{x.v}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-fg">{SOURCE[x.source] || x.source}</span>
                  {x.v === active && <span className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-medium bg-correct text-correct-text border border-correct-border"><Check className="h-2.5 w-2.5" />פעילה</span>}
                </span>
                <span className="block text-[11px] text-fg-faint truncate" dir="auto">{new Date(x.ts).toLocaleString('he-IL')} · {x.label}</span>
              </span>
              <span className="text-end shrink-0">
                <span className="block text-xs tabular-nums text-fg">{x.avg != null ? x.avg.toFixed(1) : '—'}</span>
                <span className="block text-[10px] text-fg-faint tabular-nums">{x.n} דירוגים</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Viewer */}
      <div className="flex-1 flex flex-col min-h-0">
        {sel && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-border">
            <span className="font-mono text-sm font-semibold" dir="ltr">v{sel.v}</span>
            {sel.parent != null && <span className="text-[11px] text-fg-faint">מבוסס על v{sel.parent}</span>}
            {sel.feedback_ids?.length > 0 && <span className="text-[11px] text-fg-faint">· {sel.feedback_ids.length} תיקונים קומפלו</span>}
            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              <div className="inline-flex rounded-md border border-border-strong overflow-hidden">
                <button onClick={() => setMode('view')} className={cn('inline-flex items-center gap-1 px-2.5 h-8 text-xs', mode === 'view' ? 'bg-surface-2 text-fg' : 'text-fg-muted')}><FileText className="h-3.5 w-3.5" />תצוגה</button>
                <button onClick={() => setMode('diff')} disabled={sel.v === active} className={cn('inline-flex items-center gap-1 px-2.5 h-8 text-xs border-s border-border-strong disabled:opacity-40', mode === 'diff' ? 'bg-surface-2 text-fg' : 'text-fg-muted')}><GitCompare className="h-3.5 w-3.5" />השוואה לפעילה</button>
              </div>
              <button className={btn} onClick={() => exportVersion(sel.v)}><Download className="h-3.5 w-3.5" />ייצוא</button>
              <button
                className={cn(btn, 'text-wrong-text')}
                disabled={busy || sel.v === active}
                title={sel.v === active ? 'לא ניתן למחוק את הגרסה הפעילה' : undefined}
                onClick={() => setConfirm({ title: `למחוק את v${sel.v}?`, body: 'הגרסה תימחק לצמיתות.', action: () => run(() => learningApi.deleteVersion(sel.v), `v${sel.v} נמחקה`).then(() => setSelected(active)) })}
              >
                <Trash2 className="h-3.5 w-3.5" />מחיקה
              </button>
              <button
                onClick={() => run(() => learningApi.apply(sel.v), `v${sel.v} הוחלה — תיכנס לתוקף בשאלה הבאה`)}
                disabled={busy || sel.v === active}
                className="inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover transition-colors disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />{sel.v === active ? 'פעילה' : 'החל גרסה זו'}
              </button>
            </div>
          </div>
        )}
        {msg && <div className={cn('mx-4 mt-2 rounded-md border px-3 py-1.5 text-xs', msg.ok ? 'bg-correct text-correct-text border-correct-border' : 'bg-wrong text-wrong-text border-wrong-border')}>{msg.text}</div>}
        <div className={cn('flex-1 overflow-auto', mode === 'diff' ? 'px-4 pb-4' : 'p-4')}>
          {mode === 'view' ? <PromptView text={text} /> : <DiffView a={activeText} b={text} activeV={active} selectedV={selected} />}
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirm(null)} />
          <div className="relative w-full max-w-sm rounded-lg border border-border bg-background shadow-2xl p-5" role="dialog" aria-modal="true">
            <h3 className="text-sm font-semibold text-fg mb-2">{confirm.title}</h3>
            <p className="text-sm text-fg-muted mb-4">{confirm.body}</p>
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2">ביטול</button>
              <button onClick={() => { confirm.action(); setConfirm(null) }} className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover">אישור</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PromptView({ text }) {
  const i = text.indexOf(MARKER)
  const base = i < 0 ? text : text.slice(0, i)
  const learned = i < 0 ? '' : text.slice(i + MARKER.length)
  return (
    <div dir="ltr" className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">
      <div className="text-fg-muted">{base}</div>
      {learned && (
        <div className="mt-3 rounded-md border border-primary bg-primary-soft p-3 text-fg" dir="auto">
          {learned.trim()}
        </div>
      )}
    </div>
  )
}

// Side-by-side: the active prompt on one side, the selected version on the other,
// aligned line by line. Every differing line is marked red on both sides.
function sideBySide(a, b) {
  const rows = []
  let dels = [], adds = []
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k] ?? null, r: adds[k] ?? null, diff: true })
    dels = []; adds = []
  }
  for (const [t, line] of lineDiff(a, b)) {
    if (t === '-') dels.push(line)
    else if (t === '+') adds.push(line)
    else { flush(); rows.push({ l: line, r: line, diff: false }) }
  }
  flush()
  return rows
}

function DiffView({ a, b, activeV, selectedV }) {
  const rows = sideBySide(a, b)
  const changed = rows.filter((r) => r.diff).length
  if (!changed) return <p className="text-sm text-fg-muted">אין הבדלים מול הגרסה הפעילה.</p>
  const cell = (text, diff) => (
    <div dir="auto" className={cn('px-2 py-px whitespace-pre-wrap break-words min-h-[1.25rem] text-start', diff ? (text == null ? 'bg-surface-2' : 'bg-wrong text-wrong-text') : 'text-fg-muted')}>
      {text ?? ''}
    </div>
  )
  return (
    <div>
      <p className="py-2 text-[11px] text-fg-faint">{changed} שורות שונות מסומנות באדום</p>
      <div dir="ltr" className="grid grid-cols-2 rounded-md border border-border font-mono text-[11px] leading-relaxed">
        <div className="sticky top-0 z-10 px-2 py-1.5 border-b border-e border-border bg-surface text-fg font-sans text-xs font-semibold">Active · v{activeV}</div>
        <div className="sticky top-0 z-10 px-2 py-1.5 border-b border-border bg-surface text-fg font-sans text-xs font-semibold">Selected · v{selectedV}</div>
        {rows.map((r, i) => (
          <div key={i} className="contents">
            <div className="border-e border-border">{cell(r.l, r.diff)}</div>
            <div>{cell(r.r, r.diff)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
