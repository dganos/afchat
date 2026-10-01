'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { Sparkles, Send, RotateCcw, Check, X, MessageCircleQuestion, Wand2, AlertTriangle } from 'lucide-react'
import { Reasoning } from '@/components/ai-elements/reasoning'
import { Tool } from '@/components/ai-elements/tool'
import { HelicopterLoader } from '@/components/helicopter-loader'
import { FeedbackList } from '@/components/learning/feedback-list'
import { API, learningApi } from '@/lib/learning-api'
import { cn } from '@/lib/utils'

const START_TEXT = 'התחל קומפילציה.'
const PROPOSE_NOW = 'אל תשאל שאלות נוספות. קרא עכשיו ל-propose_rules עם מערך הכללים הטוב ביותר שלך.'
const ID_RE = /\b([FR]\d+)\b/g
const newSessionId = () => `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// ask_admin questions already answered in a session — passed to a re-run so the
// compiler doesn't ask them again.
function answeredQuestions(messages) {
  const out = []
  for (const m of messages) for (const p of m.parts || []) {
    const ti = p.type === 'tool-invocation' && p.toolInvocation
    if (ti && ti.toolName === 'ask_admin' && ti.state === 'result') out.push({ question: ti.args?.question || '', answer: String(ti.result) })
  }
  return out
}

export function CompileTab({ feedback, pending, onFeedbackChanged, onApproved }) {
  const [sessionId, setSessionId] = useState(null)
  const [priorDecisions, setPriorDecisions] = useState([])
  const [dirty, setDirty] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approveErr, setApproveErr] = useState(null)
  const [discarded, setDiscarded] = useState(new Set())  // tool-call ids of proposals the admin rejected
  const priorRef = useRef([])
  const inputRef = useRef(null)
  const bottomRef = useRef(null)

  const { messages, setMessages, input, setInput, handleSubmit, append, addToolResult, status, error, stop } = useChat({
    id: sessionId || 'compile-idle',
    api: `${API}/learning/compile/chat`,
    experimental_prepareRequestBody: ({ messages }) => ({ messages, sessionId, priorDecisions: priorRef.current }),
  })
  const busy = status === 'submitted' || status === 'streaming'

  const start = (prior = []) => {
    priorRef.current = prior
    setPriorDecisions(prior)
    setDirty(false)
    setApproveErr(null)
    setDiscarded(new Set())
    setSessionId(newSessionId())
  }

  // Kick off a new session with the start message once useChat has switched ids.
  useEffect(() => {
    if (sessionId && messages.length === 0 && status === 'ready') append({ role: 'user', content: START_TEXT })
  }, [sessionId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages, status])

  // Ids the compiler is talking about right now → highlighted in the feedback pane.
  const highlight = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!last) return []
    const ids = new Set()
    for (const p of last.parts || []) {
      if (p.type === 'text') for (const m of p.text.matchAll(ID_RE)) ids.add(m[1])
      if (p.type === 'tool-invocation') {
        const a = p.toolInvocation.args || {}
        ;(a.about || []).forEach((x) => ids.add(String(x)))
        ;(a.rules || []).forEach((r) => (r?.from || []).forEach((x) => ids.add(String(x))))
      }
    }
    return [...ids]
  }, [messages])

  // The server keeps only the latest valid proposal; older cards are shown as superseded.
  const lastProposalId = useMemo(() => {
    let id = null
    for (const m of messages) for (const p of m.parts || []) {
      const ti = p.type === 'tool-invocation' && p.toolInvocation
      if (ti && ti.toolName === 'propose_rules' && ti.state === 'result' && ti.result?.ok) id = ti.toolCallId
    }
    return id
  }, [messages])

  const approve = async () => {
    setApproving(true); setApproveErr(null)
    try {
      const r = await learningApi.approve(sessionId, messages)
      setSessionId(null)
      setMessages([])
      onApproved(r.v)
    } catch (e) { setApproveErr(e.message) }
    finally { setApproving(false) }
  }

  const discard = () => { stop(); setSessionId(null); setMessages([]) }

  const idle = (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft">
          <Wand2 className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-base font-semibold text-fg mb-2">קומפילציה של תיקונים להנחיות</h2>
        <p className="text-sm text-fg-muted mb-5">
          המודל יעבור על {pending} התיקונים שסימנת ועל הכללים הקיימים, יאחד אותם, יזהה סתירות וישאל אותך כשמשהו לא ברור. תיקונים שלא סימנת יישארו ממתינים לקומפילציה הבאה.
          בסוף הוא יציע מערך כללים חדש — אחרי אישורך תיווצר גרסת הנחיות חדשה ותוחל.
        </p>
        <button
          onClick={() => start([])}
          disabled={pending === 0}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {pending === 0 ? 'סמן תיקונים לקומפילציה' : 'התחל קומפילציה'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      {/* Feedback pane (first in RTL = right side) */}
      <div className="md:w-[24rem] md:border-e border-b md:border-b-0 border-border flex flex-col min-h-0 max-h-[40vh] md:max-h-none">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <h2 className="text-xs font-medium text-fg-muted">תיקונים לקומפילציה</h2>
          {sessionId && <span className="ms-auto text-[10px] text-fg-faint">לחיצה על מזהה מוסיפה הפניה לשיחה</span>}
        </div>
        <div className="flex-1 min-h-0">
          <FeedbackList
            items={feedback}
            highlight={sessionId ? highlight : []}
            onChanged={() => { if (sessionId) setDirty(true); onFeedbackChanged() }}
            onPick={sessionId ? (id) => { setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}[${id}] `); inputRef.current?.focus() } : undefined}
            emptyText="אין תיקונים שטרם קומפלו — דרגו תשובות בחלון השיחה."
          />
        </div>
      </div>

      {/* Chat pane */}
      {!sessionId ? <div className="flex-1 min-h-0">{idle}</div> : (
      <div className="flex-1 flex flex-col min-h-0">
        {dirty && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-review-border bg-review text-review-text text-xs">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>התיקונים השתנו מאז תחילת הקומפילציה.</span>
            <button
              onClick={() => { stop(); start(answeredQuestions(messages).concat(priorRef.current)) }}
              className="ms-auto inline-flex items-center gap-1 px-2.5 h-7 rounded-md bg-primary text-on-accent font-medium hover:bg-primary-hover"
            >
              <RotateCcw className="h-3.5 w-3.5" />הרץ מחדש
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {priorDecisions.length > 0 && (
            <p className="text-[11px] text-fg-faint">הרצה חוזרת — {priorDecisions.length} החלטות קודמות הועברו למודל.</p>
          )}
          {messages.map((m, mi) => m.role === 'user' ? (
            <div key={m.id} className="flex">
              <div className="max-w-[85%] rounded-lg bg-user-bubble text-user-bubble-text px-3 py-2 text-sm whitespace-pre-wrap" dir="auto">
                {m.content === START_TEXT ? 'התחל קומפילציה' : m.content}
              </div>
            </div>
          ) : (
            <AssistantTurn
              key={m.id}
              m={m}
              streaming={busy && mi === messages.length - 1}
              onAnswer={(toolCallId, result) => addToolResult({ toolCallId, result })}
              discarded={discarded}
              lastProposalId={lastProposalId}
              onApprove={approve}
              approving={approving}
              approveErr={approveErr}
              onDiscardProposal={(id) => setDiscarded((s) => new Set(s).add(id))}
              onAskChanges={() => inputRef.current?.focus()}
            />
          ))}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex items-center gap-2 text-xs text-fg-muted"><HelicopterLoader className="h-5 w-5" />המודל קורא את התיקונים…</div>
          )}
          {error && !busy && (
            <div role="alert" className="rounded-md border border-wrong-border bg-wrong px-3 py-2 text-xs text-wrong-text" dir="auto">{error.message}</div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => { e.preventDefault(); if (input.trim() && !busy) handleSubmit(e) }}
          className="border-t border-border p-3 flex items-end gap-2"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit() } }}
            rows={1}
            dir="auto"
            placeholder="כתוב למהדר — הנחיה, תיקון או בקשת שינוי…"
            className="flex-1 resize-none max-h-32 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => append({ role: 'user', content: PROPOSE_NOW })}
            disabled={busy}
            title="סיים לשאול והצע כללים עכשיו"
            className="h-9 px-3 text-xs font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 disabled:opacity-50"
          >
            הצע עכשיו
          </button>
          {busy ? (
            <button type="button" onClick={stop} aria-label="עצור" className="h-9 w-9 flex items-center justify-center rounded-md border border-border-strong hover:bg-surface-2"><X className="h-4 w-4" /></button>
          ) : (
            <button type="submit" aria-label="שלח" disabled={!input.trim()} className="h-9 w-9 flex items-center justify-center rounded-md bg-primary text-on-accent hover:bg-primary-hover disabled:opacity-50"><Send className="h-4 w-4 rtl:-scale-x-100" /></button>
          )}
          <button type="button" onClick={discard} title="בטל את הקומפילציה" className="h-9 px-3 text-xs font-medium rounded-md text-fg-muted hover:bg-surface-2">ביטול</button>
        </form>
      </div>
      )}
    </div>
  )
}

function AssistantTurn({ m, streaming, onAnswer, discarded, lastProposalId, onApprove, approving, approveErr, onDiscardProposal, onAskChanges }) {
  const reasoning = (m.parts || []).filter((p) => p.type === 'reasoning').map((p) => p.reasoning ?? p.text ?? '').join('\n\n').trim()
  return (
    <div className="space-y-2">
      {reasoning && <Reasoning isStreaming={streaming}>{reasoning}</Reasoning>}
      {(m.parts || []).map((p, i) => {
        if (p.type === 'text' && p.text.trim()) {
          return <div key={i} className="chat-prose text-sm" dir="auto"><Streamdown isAnimating={streaming}>{p.text}</Streamdown></div>
        }
        if (p.type !== 'tool-invocation') return null
        const ti = p.toolInvocation
        if (ti.toolName === 'ask_admin') return <AskCard key={i} ti={ti} onAnswer={onAnswer} />
        if (ti.toolName === 'propose_rules' && ti.state === 'result') {
          if (!ti.result?.ok) {
            return (
              <div key={i} className="rounded-md border border-review-border bg-review px-3 py-2 text-xs text-review-text">
                ההצעה נדחתה באימות, המודל מתקן: {(ti.result?.errors || []).join(' · ')}
              </div>
            )
          }
          return (
            <ProposalCard
              key={i}
              proposal={ti.result}
              discarded={discarded.has(ti.toolCallId)}
              superseded={ti.toolCallId !== lastProposalId}
              onApprove={onApprove}
              approving={approving}
              approveErr={approveErr}
              onDiscard={() => onDiscardProposal(ti.toolCallId)}
              onAskChanges={onAskChanges}
            />
          )
        }
        return <Tool key={i} toolName={ti.toolName} state={ti.state} args={ti.args} result={ti.state === 'result' ? ti.result : null} />
      })}
    </div>
  )
}

function IdChips({ ids }) {
  if (!ids?.length) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => <span key={id} className="font-mono text-[10px] rounded-sm border border-border px-1 text-fg-muted">{id}</span>)}
    </span>
  )
}

function AskCard({ ti, onAnswer }) {
  const [text, setText] = useState('')
  const a = ti.args || {}
  const answered = ti.state === 'result'
  const send = (v) => { if (v.trim()) onAnswer(ti.toolCallId, v.trim()) }
  return (
    <div className={cn('rounded-lg border p-3', answered ? 'border-border bg-surface' : 'border-primary bg-primary-soft')}>
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="h-4 w-4 mt-0.5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-medium text-primary">שאלה אליך</span>
            <IdChips ids={a.about} />
          </div>
          <p className="text-sm text-fg whitespace-pre-wrap" dir="auto">{a.question}</p>
          {answered ? (
            <p className="mt-2 text-sm text-fg-muted" dir="auto"><span className="text-fg-faint">תשובתך: </span>{String(ti.result)}</p>
          ) : (
            <>
              {a.options?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.options.map((o, i) => (
                    <button key={i} onClick={() => send(o)} dir="auto" className="px-2.5 py-1 text-xs rounded-md border border-border-strong bg-background text-fg hover:bg-surface-2">{o}</button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(text) }}
                  dir="auto"
                  placeholder="תשובה חופשית…"
                  className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button onClick={() => send(text)} disabled={!text.trim()} className="h-8 px-3 text-xs font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover disabled:opacity-50">ענה</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ProposalCard({ proposal, discarded, superseded, onApprove, approving, approveErr, onDiscard, onAskChanges }) {
  const { rules = [], contradictions = [], dropped = [] } = proposal
  return (
    <div className={cn('rounded-lg border-2 p-4', discarded || superseded ? 'border-border opacity-60' : 'border-primary')}>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">הצעה: {rules.length} כללים</h3>
        {discarded && <span className="text-[11px] text-fg-faint">· נדחתה</span>}
        {superseded && !discarded && <span className="text-[11px] text-fg-faint">· הוחלפה בהצעה חדשה יותר</span>}
      </div>
      <ol className="space-y-1.5 list-decimal ps-5">
        {rules.map((r, i) => (
          <li key={i} className="text-sm text-fg">
            <span dir="auto">{r.text}</span>
            {r.doc && <span className="ms-1 font-mono text-[11px] text-fg-muted">({r.doc})</span>}
            <span className="ms-1.5"><IdChips ids={r.from} /></span>
          </li>
        ))}
      </ol>
      {contradictions.length > 0 && (
        <div className="mt-3">
          <h4 className="text-[11px] font-medium text-fg-muted mb-1">סתירות שנפתרו</h4>
          <ul className="space-y-1">
            {contradictions.map((c, i) => (
              <li key={i} className="text-xs text-fg-muted" dir="auto">
                <span className="font-mono text-correct-text">{c.kept}</span> במקום <span className="font-mono text-wrong-text line-through">{c.dropped}</span> — {c.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dropped.length > 0 && (
        <p className="mt-2 text-[11px] text-fg-faint">לא הפכו לכללים: <IdChips ids={dropped} /></p>
      )}
      {!discarded && !superseded && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={onApprove} disabled={approving} className="inline-flex items-center gap-1.5 px-4 h-9 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover disabled:opacity-50">
              {approving ? <HelicopterLoader className="h-4 w-4" /> : <Check className="h-4 w-4" />}אשר וצור גרסה חדשה
            </button>
            <button onClick={onAskChanges} className="px-3 h-9 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2">בקש שינויים</button>
            <button onClick={onDiscard} className="px-3 h-9 text-sm font-medium rounded-md text-fg-muted hover:bg-surface-2">דחה</button>
          </div>
          {approveErr && <p className="mt-2 text-xs text-wrong-text">{approveErr}</p>}
        </>
      )}
    </div>
  )
}
