'use client'

import { useState, useEffect, useRef } from 'react'
import { Gauge, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HelicopterLoader } from '@/components/helicopter-loader'

const API = 'http://localhost:3001'
const CHARS_PER_TOKEN = 3.5  // rough for mixed Hebrew/English

// Estimate how many tokens the conversation occupies. Reasoning parts are
// excluded — they're stripped from the model prompt server-side and don't count.
function estimateTokens(messages) {
  let chars = 0
  for (const m of messages || []) {
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (p.type === 'text') chars += (p.text || '').length
        else if (p.type === 'tool-invocation') {
          chars += JSON.stringify(p.toolInvocation?.args ?? '').length
          chars += JSON.stringify(p.toolInvocation?.result ?? '').length
        }
      }
    } else if (typeof m.content === 'string') {
      chars += m.content.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function ContextMeter({ messages, onCompact, compacting }) {
  const [meta, setMeta] = useState(null)  // { total, baseTokens }
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    fetch(`${API}/context`)
      .then((r) => r.json())
      .then((d) => d.total && setMeta({ total: d.total, baseTokens: d.baseTokens || 0 }))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  if (!meta) return null

  const used = meta.baseTokens + estimateTokens(messages)
  const pct = Math.min(100, Math.round((used / meta.total) * 100))
  const tone = pct >= 90 ? 'text-wrong-text' : pct >= 70 ? 'text-review-text' : 'text-fg-muted'
  const fill = pct >= 90 ? 'bg-wrong-text' : pct >= 70 ? 'bg-review-text' : 'bg-primary'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="חלון ההקשר"
        aria-label={`הקשר ${pct}%`}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-fg-muted rounded-md hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        <span className="h-1.5 w-12 rounded-full bg-surface-2 overflow-hidden">
          <span className={cn('block h-full rounded-full transition-[width] duration-500', fill)} style={{ width: `${pct}%` }} />
        </span>
        <span className={cn('tabular-nums', tone)}>{pct}%</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-surface border border-border rounded-lg shadow-xl z-50 p-2.5">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="h-2 flex-1 rounded-full bg-surface-2 overflow-hidden">
              <span className={cn('block h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
            </span>
            <span className={cn('text-xs tabular-nums', tone)}>{pct}%</span>
          </div>
          <button
            onClick={() => onCompact?.()}
            disabled={compacting || !messages?.length}
            className="flex items-center justify-center gap-1.5 w-full px-2 py-1 rounded-md bg-primary text-on-accent text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {compacting ? <HelicopterLoader className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {compacting ? 'מכווץ…' : 'כווץ'}
          </button>
        </div>
      )}
    </div>
  )
}
