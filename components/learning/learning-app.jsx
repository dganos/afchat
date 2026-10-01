'use client'

import { useCallback, useEffect, useState } from 'react'
import { GraduationCap, FileText, Wand2 } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { PromptsTab } from '@/components/learning/prompts-tab'
import { CompileTab } from '@/components/learning/compile-tab'
import { learningApi } from '@/lib/learning-api'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'compile', label: 'קומפילציה', Icon: Wand2 },
  { id: 'prompts', label: 'הנחיות מערכת', Icon: FileText },
]

// The Continuous Learning window (?view=learning): prompt versions, feedback, compile.
export function LearningApp() {
  const [tab, setTab] = useState('compile')
  const [versions, setVersions] = useState(null)
  const [feedback, setFeedback] = useState([])
  const [loadErr, setLoadErr] = useState(null)
  const [toast, setToast] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [v, f] = await Promise.all([learningApi.versions(), learningApi.listFeedback()])
      setVersions(v); setFeedback(f.items); setLoadErr(null)
    } catch (e) { setLoadErr(e.message) }
  }, [])

  useEffect(() => {
    document.title = 'Aristo — למידה'
    refresh()
    // Users score answers in the chat window; pick that up when this window regains focus.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const active = versions?.versions?.find((x) => x.v === versions.active)
  const pending = versions?.pending ?? 0

  return (
    <div className="flex flex-col h-screen bg-canvas text-fg" dir="rtl">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">למידה מתמשכת</h1>
        </div>
        {active && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs" title="הגרסה הפעילה של הנחיות המערכת">
            <span className="text-fg-muted">פעילה</span>
            <span className="font-mono font-semibold" dir="ltr">v{active.v}</span>
            <span className="text-fg-faint">·</span>
            <span className="tabular-nums">{active.avg != null ? `ממוצע ${active.avg.toFixed(1)}` : 'אין דירוגים'}</span>
            {active.n > 0 && <span className="text-fg-faint tabular-nums">({active.n})</span>}
          </span>
        )}
        <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs', pending ? 'bg-primary-soft text-primary font-medium' : 'text-fg-faint')}>
          {pending} נבחרו לקומפילציה
        </span>
        <div className="ms-auto flex items-center gap-2">
          <ThemeToggle />
        </div>
      </header>

      <nav role="tablist" className="flex gap-1 px-3 border-b border-border">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors',
              tab === id ? 'border-primary text-fg font-medium' : 'border-transparent text-fg-muted hover:text-fg'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      {loadErr && <div role="alert" className="mx-4 mt-3 rounded-md border border-wrong-border bg-wrong px-3 py-2 text-sm text-wrong-text">לא ניתן לטעון: {loadErr}</div>}
      {toast && (
        <div className="mx-4 mt-3 rounded-md border border-correct-border bg-correct px-3 py-2 text-sm text-correct-text flex items-center">
          {toast}
          <button onClick={() => setToast(null)} className="ms-auto text-xs underline">סגור</button>
        </div>
      )}

      {/* All tabs stay mounted so a compile session survives switching tabs. */}
      <main className="flex-1 min-h-0">
        <div className={cn('h-full', tab !== 'prompts' && 'hidden')}>
          <PromptsTab data={versions} onChanged={refresh} />
        </div>
        <div className={cn('h-full', tab !== 'compile' && 'hidden')}>
          <CompileTab
            feedback={feedback}
            pending={pending}
            onFeedbackChanged={refresh}
            onApproved={async (v) => { await refresh(); setToast(`נוצרה והוחלה גרסה v${v}. היא תיכנס לתוקף בשאלה הבאה.`) }}
          />
        </div>
      </main>
    </div>
  )
}
