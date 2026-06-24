'use client'

// htop-style live memory meter. Polls the API every couple of seconds and
// renders a segmented bar: loaded model RAM, other in-use RAM, and free RAM.
// The free figure is the same "realistically allocatable" number the model
// picker uses (reclaimable cache included), so it matches what a model load
// will actually find available — handy on an 8 GB box.
import { useState, useEffect } from 'react'
import { MemoryStick } from 'lucide-react'

const API = 'http://localhost:3001'
const POLL_MS = 2000

function fmtGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function MemoryMeter() {
  const [mem, setMem] = useState(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(`${API}/memory`)
        const data = await res.json()
        if (alive) setMem(data)
      } catch { /* server not up yet; keep last value */ }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!mem || !mem.total) return null

  const { total, free, loaded } = mem
  const used = Math.max(0, total - free)
  const otherUsed = Math.max(0, used - loaded)
  const pct = (n) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`

  // Warn when free RAM gets tight — the zone where model loads start to OOM.
  const lowFree = free < total * 0.2
  const freeColor = lowFree ? 'text-review-text' : 'text-correct-text'

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground"
      title={`RAM — total ${fmtGB(total)} · used ${fmtGB(used)} · model ${fmtGB(loaded)} · free ${fmtGB(free)}`}
    >
      <MemoryStick className="h-3.5 w-3.5 shrink-0" />
      <div className="h-2 w-28 rounded-full bg-muted overflow-hidden flex">
        {/* Loaded model weights */}
        <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: pct(loaded) }} />
        {/* Everything else in use (OS, Electron, other apps) */}
        <div className="h-full bg-border-strong transition-[width] duration-500 ease-out" style={{ width: pct(otherUsed) }} />
        {/* Remaining track is free RAM */}
      </div>
      <span className="tabular-nums whitespace-nowrap">
        <span className={freeColor}>{fmtGB(free)}</span>
        <span className="opacity-60"> / {fmtGB(total)} free</span>
      </span>
    </div>
  )
}
