'use client'

import { useState, useRef, useEffect } from 'react'

// Live elapsed-time readout shown while a response is generating. Counts up from
// when `running` flips true (resetting each time), and disappears when it stops.
export function ResponseTimer({ running, startTime, className = '' }) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(null)

  useEffect(() => {
    if (!running) return
    // Count from the shared startTime if provided, so the timer stays continuous
    // when it moves from the waiting row into the message bubble.
    startRef.current = startTime ?? Date.now()
    setElapsed((Date.now() - startRef.current) / 1000)
    const id = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000)
    }, 100)
    return () => clearInterval(id)
  }, [running, startTime])

  if (!running) return null
  return (
    <span className={`font-mono text-xs tabular-nums text-muted-foreground ${className}`}>
      {elapsed.toFixed(1)}s
    </span>
  )
}
