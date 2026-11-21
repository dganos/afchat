'use client'

import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { useRef, useEffect, useState, useCallback, Fragment } from 'react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputTextarea, PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { Tool } from '@/components/ai-elements/tool'
import { Reasoning } from '@/components/ai-elements/reasoning'
import { FolderOpen, Settings2, Archive, GraduationCap, Server } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'
import { ResponseTimer } from '@/components/response-timer'
import { LogsPanel } from '@/components/logs-panel'
import { DocumentsPanel } from '@/components/documents-panel'
import { MemoryMeter } from '@/components/memory-meter'
import { SettingsPanel } from '@/components/settings-panel'
import { ThemeToggle } from '@/components/theme-toggle'
import { ContextMeter } from '@/components/context-meter'
import { ScoreRow } from '@/components/score-row'
import { LearningApp } from '@/components/learning/learning-app'
import { AdminApp } from '@/components/admin-app'
import { SessionSidebar, loadSessions, saveSessions, newSessionId, sessionTitle } from '@/components/session-sidebar'

const textOf = (m) => (m?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('').trim() || m?.content || ''

// The Learning window loads this same page with ?view=learning (the packaged app
// serves a static export over file://, where a nested route can't resolve assets).
export default function Page() {
  const [view, setView] = useState(null)
  useEffect(() => { setView(new URLSearchParams(window.location.search).get('view') || 'chat') }, [])
  if (view === null) return null
  if (view === 'admin') return <AdminApp />
  return view === 'learning' ? <LearningApp /> : <ChatPage />
}

// Same named window every time → the browser/Electron focuses it instead of opening another.
const openLearning = () => window.open('?view=learning', 'aristo-learning')

const DEFAULT_SETTINGS = { autoSearch: false }

function loadSettings() {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const saved = localStorage.getItem('docassist-settings')
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS
  } catch { return DEFAULT_SETTINGS }
}

function ChatPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    setSettings(loadSettings())
  }, [])

  const saveSettings = (next) => {
    setSettings(next)
    localStorage.setItem('docassist-settings', JSON.stringify(next))
  }

  // Compaction state: the visible chat is NEVER touched — only the context we
  // send to the model is compacted. { summary, count } = "the first `count`
  // messages are represented by `summary`". Refs mirror it for the request hook.
  const [compaction, setCompaction] = useState(null)
  const compactionRef = useRef(null)
  const autoSearchRef = useRef(settings.autoSearch)
  useEffect(() => { autoSearchRef.current = settings.autoSearch }, [settings.autoSearch])

  const { messages, setMessages, input, handleInputChange, handleSubmit, status, error, stop } = useChat({
    api: 'http://localhost:3001/chat',
    // Send the COMPACTED context to the model (summary + messages since the last
    // compaction). The UI keeps rendering the full `messages` untouched.
    experimental_prepareRequestBody: ({ messages }) => {
      const c = compactionRef.current
      const sent = c
        ? [{ role: 'assistant', content: c.summary, parts: [{ type: 'text', text: c.summary }] }, ...messages.slice(c.count)]
        : messages
      return { messages: sent, autoSearch: autoSearchRef.current }
    },
    // Stall guard: the server always ends a turn with finish_message or an error
    // part. finishReason 'unknown' = the stream closed with neither (API died /
    // connection cut) — say so instead of leaving a half answer looking complete.
    onFinish: (_m, { finishReason }) => setStreamCut(finishReason === 'unknown'),
  })
  const [streamCut, setStreamCut] = useState(false)
  useEffect(() => { if (status === 'submitted') setStreamCut(false) }, [status])

  // What the model actually receives — also what the context meter measures and
  // what re-compaction summarizes.
  const effectiveContext = compaction
    ? [{ role: 'assistant', parts: [{ type: 'text', text: compaction.summary }] }, ...messages.slice(compaction.count)]
    : messages

  // Claude-style compact: summarize the running context server-side, then route
  // future turns through that summary. The visible conversation stays intact.
  const [compacting, setCompacting] = useState(false)
  const loadGenRef = useRef(0)  // bumped on every conversation load (see applyLoad)
  const compactContext = async () => {
    if (compacting || messages.length === 0) return
    setCompacting(true)
    // The user may switch / start a conversation while /compact runs: tag the
    // request with the current load and drop the result if another one opened.
    const gen = loadGenRef.current
    try {
      const r = await fetch('http://localhost:3001/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: effectiveContext }),
      })
      const data = await r.json()
      if (data.summary && gen === loadGenRef.current) {
        const next = { summary: data.summary, count: messages.length }
        compactionRef.current = next
        setCompaction(next)
      }
    } catch { /* leave context as-is on failure */ }
    setCompacting(false)
  }

  const [docsOpen, setDocsOpen] = useState(false)
  const isStreaming = status === 'streaming'
  const isWaiting = status === 'submitted'
  const isBusy = isStreaming || isWaiting
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])

  // Model warm-up gate: the API loads the model into memory at startup; poll until
  // it's ready so we can show a loader and block input — the first question is then
  // fast (no cold model load mid-chat).
  const [modelReady, setModelReady] = useState(false)
  const [modelError, setModelError] = useState(null)
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      try {
        const r = await fetch('http://localhost:3001/ready')
        const data = await r.json()
        if (data.ready) { if (!stopped) { setModelReady(true); setModelError(null) }; return }
        if (data.error && !stopped) setModelError(data.error)  // surface warm-up failure (e.g. low memory)
      } catch { /* API not up yet */ }
      if (!stopped) setTimeout(poll, 800)
    }
    poll()
    return () => { stopped = true }
  }, [])

  // Persist how long each answer took: time from when generation starts until it
  // finishes, keyed by the assistant message id. Shown above that answer's bubble
  // (the live timer just counts; this keeps the final value).
  const [durations, setDurations] = useState({})
  const startRef = useRef(null)
  const prevBusyRef = useRef(false)

  useEffect(() => {
    if (isBusy && !prevBusyRef.current) {
      startRef.current = Date.now()
    } else if (!isBusy && prevBusyRef.current && startRef.current != null) {
      const elapsed = (Date.now() - startRef.current) / 1000
      startRef.current = null
      setDurations((d) => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') return { ...d, [messages[i].id]: elapsed }
        }
        return d
      })
    }
    prevBusyRef.current = isBusy
  }, [isBusy, messages])

  // ── Conversation history (localStorage) ──────────────────────────────────
  // The active conversation is saved whenever the chat is idle and its content
  // changed (i.e. when a response finishes, not on every streamed token).
  const [sessions, setSessions] = useState([])
  const sessionsRef = useRef([])
  const [activeId, setActiveId] = useState(null)
  const activeIdRef = useRef(null)
  const lastSavedRef = useRef('')          // signature of what's stored for the active session
  const pendingLoadRef = useRef(undefined) // session id (or null = new chat) to open once streaming stops
  const deletedIdsRef = useRef(new Set())  // never write these back (see persistActive)
  const [saveFailed, setSaveFailed] = useState(null)
  const [dismissedError, setDismissedError] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    const list = loadSessions()
    sessionsRef.current = list
    setSessions(list)
    const saved = localStorage.getItem('aristo-sidebar-collapsed')
    setSidebarCollapsed(saved != null ? saved === '1' : window.innerWidth < 900)
  }, [])

  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      try { localStorage.setItem('aristo-sidebar-collapsed', c ? '0' : '1') } catch {}
      return !c
    })
  }

  const signature = (msgs, comp, durs) => JSON.stringify([msgs, comp, durs])

  const commitSessions = (list, keepId) => {
    const { list: stored, failed } = saveSessions(list, keepId)
    sessionsRef.current = stored
    setSessions(stored)
    setSaveFailed(failed)
  }

  // Upsert the active conversation (creating it on first save).
  const persistActive = useCallback((msgs, comp, durs) => {
    if (!msgs.length) return
    // Deleted while it was still open (e.g. mid-stream): the deferred save that
    // runs before the next load must not resurrect it.
    if (activeIdRef.current && deletedIdsRef.current.has(activeIdRef.current)) return
    const sig = signature(msgs, comp, durs)
    if (sig === lastSavedRef.current && activeIdRef.current) return
    const now = Date.now()
    let id = activeIdRef.current
    const existing = id && sessionsRef.current.find((s) => s.id === id)
    if (!id) { id = newSessionId(); activeIdRef.current = id; setActiveId(id) }
    const session = {
      id,
      title: sessionTitle(msgs),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: msgs,
      compaction: comp || null,
      durations: durs || {},
    }
    commitSessions([session, ...sessionsRef.current.filter((s) => s.id !== id)], id)
    lastSavedRef.current = sig
  }, [])

  // Open a stored conversation (id) or a fresh one (null), resetting all
  // per-conversation UI state on this page.
  const applyLoad = (id) => {
    const s = id ? sessionsRef.current.find((x) => x.id === id) : null
    const msgs = s ? s.messages : []
    const comp = s?.compaction || null
    const durs = s?.durations || {}
    loadGenRef.current++
    setMessages(msgs)
    compactionRef.current = comp
    setCompaction(comp)
    setDurations(durs)
    startRef.current = null
    activeIdRef.current = s ? s.id : null
    setActiveId(s ? s.id : null)
    lastSavedRef.current = s ? signature(msgs, comp, durs) : ''
  }

  // Switching while a response streams: stop it first, then load once the
  // chat is idle again (see effect below) so no late chunk lands in the new chat.
  const requestLoad = (id) => {
    setDismissedError(error ?? null)
    setStreamCut(false)
    if (isBusy) {
      pendingLoadRef.current = id
      stop()
    } else {
      pendingLoadRef.current = undefined
      applyLoad(id)
    }
  }

  useEffect(() => {
    if (isBusy) return
    if (pendingLoadRef.current !== undefined) {
      const target = pendingLoadRef.current
      pendingLoadRef.current = undefined
      persistActive(messages, compactionRef.current, durations)  // keep the partial answer
      applyLoad(target)
      return
    }
    persistActive(messages, compaction, durations)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, messages, compaction, durations])

  const newChat = () => requestLoad(null)
  const selectSession = (id) => { if (id !== activeIdRef.current) requestLoad(id) }
  const deleteSession = (id) => {
    deletedIdsRef.current.add(id)
    commitSessions(sessionsRef.current.filter((s) => s.id !== id))
    if (id === activeIdRef.current) requestLoad(null)
  }

  // Settings → "Clear conversation": start a fresh chat (the stored copy stays
  // in history and can be deleted from the sidebar).
  const clearHistory = () => requestLoad(null)

  return (
    <div className="flex h-screen" dir="ltr">
    {/* History sits on the physical LEFT; the chat column keeps its RTL layout. */}
    <SessionSidebar
      sessions={sessions}
      activeId={activeId}
      onSelect={selectSession}
      onNew={newChat}
      onDelete={deleteSession}
      collapsed={sidebarCollapsed}
      onToggle={toggleSidebar}
      saveFailed={saveFailed}
    />
    <div className="flex flex-col flex-1 min-w-0 h-full" dir="rtl">
      {/* Header */}
      <header dir="ltr" className="flex items-center gap-2.5 px-4 py-2 border-b border-border bg-canvas">
        <img src="./aristo-logo.png" alt="Aristo" className="h-20 w-auto select-none" draggable="false" />
        <div className="ms-auto flex items-center gap-1">
          <ContextMeter messages={effectiveContext} onCompact={compactContext} compacting={compacting} />
          <MemoryMeter />
          <button
            onClick={openLearning}
            aria-label="למידה"
            className="flex items-center gap-1.5 px-2.5 min-h-9 text-xs text-fg-muted rounded-md hover:bg-surface-2 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GraduationCap className="h-3.5 w-3.5" />
            למידה
          </button>
          <button
            onClick={() => setDocsOpen(true)}
            aria-label="מסמכים"
            className="flex items-center gap-1.5 px-2.5 min-h-9 text-xs text-fg-muted rounded-md hover:bg-surface-2 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            מסמכים
          </button>
          <a
            href="?view=admin"
            aria-label="ניהול שרת"
            title="ניהול שרת"
            className="flex items-center justify-center h-9 w-9 text-fg-muted rounded-md hover:bg-surface-2 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Server className="h-3.5 w-3.5" />
          </a>
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="הגדרות"
            className="flex items-center justify-center h-9 w-9 text-fg-muted rounded-md hover:bg-surface-2 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* Messages */}
      <Conversation className="flex-1">
        <ConversationContent>
          {/* Warming up the model at startup — block with a loader until ready */}
          {!modelReady && (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
              {modelError ? (
                <>
                  <p className="text-lg font-medium text-destructive">טעינת המודל נכשלה</p>
                  <p className="text-sm text-muted-foreground max-w-md text-center" dir="auto">{modelError}</p>
                </>
              ) : (
                <>
                  <HelicopterLoader className="h-16 w-16 text-muted-foreground" />
                  <p className="text-lg font-medium text-foreground">טוען את המודל…</p>
                  <p className="text-sm text-muted-foreground">רגע אחד — מחמם את המודל בזיכרון (קורה פעם אחת בהפעלה)</p>
                </>
              )}
            </div>
          )}

          {/* Empty state — once the model is ready */}
          {modelReady && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
              <img
                src="./aristo-logo.png"
                alt="Aristo"
                className="h-80 w-auto select-none drop-shadow-[0_0_70px_rgba(59,130,246,0.45)]"
                draggable="false"
              />
              <p className="text-lg font-medium text-foreground">שאל אותי כל דבר על המסמכים שלך</p>
              <p className="text-sm text-muted-foreground">אחפש ואקרא בהם כדי למצוא את התשובה</p>
            </div>
          )}

          {/* Message list — streamed answers announced politely to screen readers */}
          <div role="log" aria-live="polite" aria-relevant="additions text">
          {messages.map((msg, idx) => (
            <Fragment key={msg.id}>
            {compaction && idx === compaction.count && (
              <div className="flex items-center gap-2 my-4 text-[11px] text-fg-faint select-none">
                <div className="h-px flex-1 bg-border" />
                <Archive className="h-3 w-3" />
                <span>ההקשר כווץ — ההודעות שמעל סוכמו עבור המודל</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <Message from={msg.role} isThinking={isBusy && msg.role === 'assistant' && msg === messages[messages.length - 1]}>
              {/* Timer at the TOP of the bubble: live while this answer streams,
                  frozen at its final value once done. */}
              {msg.role === 'assistant' && (() => {
                const isLastMsg = msg === messages[messages.length - 1]
                if (isBusy && isLastMsg) {
                  return <ResponseTimer running startTime={startRef.current} className="px-1" />
                }
                if (durations[msg.id] != null) {
                  return (
                    <span className="font-mono text-xs tabular-nums text-muted-foreground px-1">
                      {durations[msg.id].toFixed(1)}s
                    </span>
                  )
                }
                return null
              })()}
              <MessageContent from={msg.role}>
                {/* Reasoning — consolidate all reasoning parts into ONE collapsible
                    block (auto-open while streaming, auto-collapse when done). */}
                {msg.role === 'assistant' && (() => {
                  const reasoning = (msg.parts || [])
                    .filter((p) => p.type === 'reasoning')
                    .map((p) => p.reasoning ?? p.text ?? '')
                    .join('\n\n')
                    .trim()
                  if (!reasoning) return null
                  const isLast = msg === messages[messages.length - 1]
                  return (
                    <Reasoning isStreaming={isBusy && isLast} duration={durations[msg.id]}>
                      {reasoning}
                    </Reasoning>
                  )
                })()}

                {msg.parts?.map((part, i) => {
                  if (part.type === 'reasoning') return null

                  if (part.type === 'tool-invocation') {
                    return (
                      <Tool
                        key={i}
                        toolName={part.toolInvocation.toolName}
                        state={part.toolInvocation.state}
                        args={part.toolInvocation.args}
                        result={part.toolInvocation.state === 'result' ? part.toolInvocation.result : null}
                      />
                    )
                  }

                  if (part.type === 'text') {
                    if (msg.role === 'user') {
                      return <span key={i} dir="auto">{part.text}</span>
                    }
                    // NOTE: do NOT use Streamdown's `animated` word-stagger. It
                    // fades words in with a 40ms stagger, which is fine for tiny
                    // cloud token-deltas but on a LOCAL model (bursty chunks) makes
                    // many words/lines fade in at once — looks like lines streaming
                    // in parallel. Plain render streams naturally as text grows.
                    const isLastMsg = msg === messages[messages.length - 1]
                    const lastTextIdx = msg.parts.map((p) => p.type).lastIndexOf('text')
                    const animating = isStreaming && isLastMsg && i === lastTextIdx
                    return (
                      <Streamdown
                        key={i}
                        className="chat-prose"
                        plugins={{ code }}
                        isAnimating={animating}
                      >
                        {part.text}
                      </Streamdown>
                    )
                  }

                  return null
                })}
              </MessageContent>
              {msg.role === 'assistant' && !(isBusy && msg === messages[messages.length - 1]) && textOf(msg) && (
                <ScoreRow
                  msgId={msg.id}
                  question={textOf(messages.slice(0, idx).reverse().find((m) => m.role === 'user'))}
                  answer={textOf(msg)}
                  promptVersion={msg.annotations?.find((a) => a && a.prompt_version != null)?.prompt_version}
                  model={msg.annotations?.find((a) => a && a.model)?.model}
                />
              )}
            </Message>
            </Fragment>
          ))}
          {/* Compaction happened after the last visible message (nothing new since) */}
          {compaction && compaction.count >= messages.length && messages.length > 0 && (
            <div className="flex items-center gap-2 my-4 text-[11px] text-fg-faint select-none">
              <div className="h-px flex-1 bg-border" />
              <Archive className="h-3 w-3" />
              <span>ההקשר כווץ — ההודעות שמעל סוכמו עבור המודל</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          </div>

          {/* Chat error — show the real failure instead of silently returning nothing */}
          {((error && error !== dismissedError) || streamCut) && !isBusy && (
            <div role="alert" className="mx-auto my-4 max-w-xl rounded-md border border-wrong-border bg-wrong px-4 py-3 text-sm text-wrong-text" dir="auto">
              {error ? (error.message || 'אירעה שגיאה בעת יצירת התשובה.') : 'החיבור לשרת נקטע לפני סוף התשובה — התשובה עשויה להיות חלקית.'}
            </div>
          )}

          {/* Activity indicator — only while WAITING for the first token (no
              assistant bubble yet). Once the bubble appears, its top-of-bubble
              timer takes over, so we don't double up. */}
          {isBusy && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="flex items-center gap-3 mb-6">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
                <HelicopterLoader className="h-5 w-5" />
              </div>
              <ResponseTimer running={isBusy} startTime={startRef.current} />
            </div>
          )}

          <div ref={bottomRef} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputTextarea
          value={input}
          onChange={handleInputChange}
          disabled={isBusy || !modelReady}
          placeholder={modelReady ? 'שאל על המסמכים שלך…' : 'טוען את המודל…'}
        />
        <PromptInputSubmit
          isStreaming={isBusy}
          disabled={!modelReady || !input.trim()}
          onStop={stop}
        />
      </PromptInput>

      <LogsPanel />
      <DocumentsPanel open={docsOpen} onClose={() => setDocsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSettingsChange={saveSettings} onClearHistory={clearHistory} hasHistory={messages.length > 0} />
    </div>
    </div>
  )
}
