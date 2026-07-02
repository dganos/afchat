'use client'

import { useState, useRef, useEffect } from 'react'
import { X, Settings2, Zap, FileText, Trash2, RotateCcw } from 'lucide-react'
import { Speedometer } from '@/components/speedometer'
import { HelicopterLoader } from '@/components/helicopter-loader'

const API = 'http://localhost:3001'

// Round the gauge ceiling up to a clean number above the peak reading so the
// dial stays readable whether generation (~tens) or prefill (~hundreds) is shown.
const niceMax = (v) => [30, 60, 120, 300, 600, 1200, 2400].find((m) => m >= v * 1.05) || Math.ceil(v / 600) * 600

export function SettingsPanel({ open, onClose, settings, onSettingsChange, onClearHistory, hasHistory }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [tps, setTps] = useState(0)
  const [step, setStep] = useState('')
  const [gaugeMax, setGaugeMax] = useState(60)
  const ctrlRef = useRef(null)

  // System prompt editor
  const [prompt, setPrompt] = useState('')
  const [loadedPrompt, setLoadedPrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [promptAck, setPromptAck] = useState(null)   // 'reloaded' | error string | null
  const [isDefault, setIsDefault] = useState(true)

  // Clear-history confirm
  const [confirmClear, setConfirmClear] = useState(false)

  // Load the current system prompt whenever the panel opens.
  useEffect(() => {
    if (!open) { setConfirmClear(false); setPromptAck(null); return }
    let cancelled = false
    setPromptLoading(true)
    fetch(`${API}/system-prompt`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setPrompt(d.prompt || ''); setLoadedPrompt(d.prompt || ''); setIsDefault(!!d.isDefault) } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPromptLoading(false) })
    return () => { cancelled = true }
  }, [open])

  const reloadPrompt = async (reset = false) => {
    setSavingPrompt(true); setPromptAck(null)
    try {
      const r = await fetch(`${API}/system-prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset ? { reset: true } : { prompt }),
      })
      const d = await r.json()
      if (!r.ok || d.error) { setPromptAck(d.error || 'Failed to reload'); return }
      // Re-fetch so the textarea reflects exactly what's now active (e.g. after reset).
      const cur = await fetch(`${API}/system-prompt`).then((x) => x.json())
      setPrompt(cur.prompt || ''); setLoadedPrompt(cur.prompt || ''); setIsDefault(!!cur.isDefault)
      setPromptAck('reloaded')
    } catch (e) {
      setPromptAck(e.message)
    }
    setSavingPrompt(false)
  }

  const runSpeedCheck = async () => {
    setRunning(true); setErr(null); setResult(null); setTps(0); setGaugeMax(60); setStep('Starting…')
    const ctrl = new AbortController(); ctrlRef.current = ctrl
    try {
      const r = await fetch(`${API}/speedtest`, { method: 'POST', signal: ctrl.signal })
      if (!r.ok || !r.body) throw new Error(`Speed check failed (${r.status})`)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl); buf = buf.slice(nl + 2)
          const data = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!data) continue
          const ev = JSON.parse(data.slice(5).trim())
          if (ev.type === 'step') setStep(ev.label)
          else if (ev.type === 'tps') { setTps(ev.value); setGaugeMax((m) => Math.max(m, niceMax(ev.value))) }
          else if (ev.type === 'done') { setResult(ev); setStep('') }
          else if (ev.type === 'error') setErr(ev.error)
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message)
    }
    ctrlRef.current = null
    setRunning(false)
  }

  const abortSpeedCheck = () => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
    setRunning(false); setStep('')
  }

  if (!open) return null

  const toggle = (key) => {
    onSettingsChange({ ...settings, [key]: !settings[key] })
  }

  return (
    <div className="absolute inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-80 h-full bg-background border-l shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Settings2 className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">Settings</span>
          <button onClick={onClose} aria-label="סגור" className="ml-auto p-1 rounded hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Settings */}
        <div className="flex-1 overflow-y-auto">
          {/* Document Search section */}
          <div className="px-4 py-3 border-b">
            <h3 className="text-xs font-medium text-muted-foreground mb-3">Document search</h3>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div className="flex-1">
                <p className="text-sm font-medium">Auto pre-search</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically search documents before sending your question to the model, injecting relevant context
                </p>
              </div>
              <button
                role="switch"
                aria-checked={settings.autoSearch}
                aria-label="Auto pre-search"
                onClick={() => toggle('autoSearch')}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
                  settings.autoSearch ? 'bg-primary' : 'bg-border-strong'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    settings.autoSearch ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </label>
          </div>

          {/* Speed check section */}
          <div className="px-4 py-3 border-b">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Speed check</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Measure this machine's generation throughput (tokens/sec) for the current model. Takes ~10–15s.
            </p>
            {running ? (
              <>
                <Speedometer value={tps} max={gaugeMax} label={step} />
                <button
                  onClick={abortSpeedCheck}
                  className="flex items-center justify-center gap-2 w-full mt-3 px-3 py-2 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors"
                >
                  <X className="h-4 w-4" />
                  Abort
                </button>
              </>
            ) : (
              <button
                onClick={runSpeedCheck}
                className="flex items-center justify-center gap-2 w-full px-3 py-2 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover transition-colors"
              >
                <Zap className="h-4 w-4" />
                Run speed check
              </button>
            )}

            {err && <p className="text-xs text-wrong-text mt-2">{err}</p>}

            {result && !running && (
              <div className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-xs" dir="ltr">
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-fg-muted">Generation</span>
                  <span className="font-mono tabular-nums text-fg font-medium">{result.genTps} tok/s</span>
                </div>
                <div className="mt-2 pt-2 border-t border-border text-[11px] text-fg-faint">
                  {result.machine.cpu} · {result.machine.cores} cores · {result.machine.ramGB} GB · {result.model} (ctx {result.numCtx})
                </div>
              </div>
            )}
          </div>

          {/* System prompt section */}
          <div className="px-4 py-3 border-b">
            <div className="flex items-center gap-1.5 mb-2">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-medium text-muted-foreground">System prompt</h3>
              {!isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-fg-faint">edited</span>}
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Edit the model's instructions, then reload. Takes effect on your next message — your conversation is kept.
            </p>
            <textarea
              dir="ltr"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setPromptAck(null) }}
              disabled={promptLoading || savingPrompt}
              spellCheck={false}
              placeholder={promptLoading ? 'Loading…' : 'System prompt…'}
              className="w-full h-44 resize-y rounded-md border border-border bg-surface-2 p-2 text-[11px] font-mono leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => reloadPrompt(false)}
                disabled={savingPrompt || promptLoading || prompt.trim() === loadedPrompt.trim() || !prompt.trim()}
                className="flex items-center justify-center gap-2 flex-1 px-3 py-2 text-sm font-medium rounded-md bg-primary text-on-accent hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingPrompt ? <HelicopterLoader className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                {savingPrompt ? 'Reloading…' : 'Apply & reload'}
              </button>
              {!isDefault && (
                <button
                  onClick={() => reloadPrompt(true)}
                  disabled={savingPrompt || promptLoading}
                  className="px-3 py-2 text-xs font-medium rounded-md border border-border-strong text-fg-muted hover:bg-surface-2 transition-colors disabled:opacity-50"
                  title="Revert to the built-in default prompt"
                >
                  Reset
                </button>
              )}
            </div>
            {promptAck === 'reloaded' && <p className="text-xs text-correct-text mt-2">✓ System prompt reloaded — history kept.</p>}
            {promptAck && promptAck !== 'reloaded' && <p className="text-xs text-wrong-text mt-2">{promptAck}</p>}
          </div>

          {/* Clear history section */}
          <div className="px-4 py-3 border-b">
            <div className="flex items-center gap-1.5 mb-2">
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-medium text-muted-foreground">Conversation</h3>
            </div>
            {!confirmClear ? (
              <button
                onClick={() => setConfirmClear(true)}
                disabled={!hasHistory}
                className="flex items-center justify-center gap-2 w-full px-3 py-2 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="h-4 w-4" />
                {hasHistory ? 'Clear history' : 'No history to clear'}
              </button>
            ) : (
              <div className="rounded-md border border-wrong-border bg-wrong p-3">
                <p className="text-xs text-wrong-text mb-2.5">Delete the entire conversation and start fresh? This can't be undone.</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { onClearHistory?.(); setConfirmClear(false); onClose() }}
                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 text-sm font-medium rounded-md bg-wrong-text text-white hover:opacity-90 transition-opacity"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="flex-1 px-3 py-1.5 text-sm font-medium rounded-md border border-border-strong text-fg hover:bg-surface-2 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t text-[11px] text-muted-foreground">
          Settings are stored locally in your browser
        </div>
      </div>
    </div>
  )
}
