'use client'

import { useState, useEffect, useRef } from 'react'
import { Cpu, ChevronDown, Check, AlertTriangle, PowerOff } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

const API = 'http://localhost:3001'

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Rough load-time estimate based on observed M2 behavior: ~1.7s per GiB of
// weights, plus a small fixed cost for runner spin-up. Used only to pace the
// progress bar — it snaps to 100% as soon as the server confirms the load.
function estimateLoadMs(sizeBytes) {
  const gib = sizeBytes / (1024 ** 3)
  return Math.max(1500, Math.round(1500 + gib * 2000))
}

export function ModelSelector({ onModelChange }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState([])
  const [currentModel, setCurrentModel] = useState('')
  const [memory, setMemory] = useState(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(null)
  const [loadProgress, setLoadProgress] = useState(0)
  const [error, setError] = useState(null)
  const [ejecting, setEjecting] = useState(false)
  const ref = useRef(null)
  const progressTimerRef = useRef(null)

  const fetchModels = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/models`)
      const data = await res.json()
      setModels(data.models || [])
      setCurrentModel(data.currentModel || '')
      setMemory(data.memory || null)
    } catch (err) {
      console.error('Failed to fetch models:', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchModels()
  }, [])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectModel = async (name) => {
    if (switching) return
    const target = models.find(m => m.name === name)
    setSwitching(name)
    setError(null)
    setLoadProgress(0)

    // Animate progress toward 95% over the estimated load duration. The
    // remaining 5% is reserved for the server confirmation so the bar
    // doesn't sit at 100% before it's actually safe to chat.
    const expectedMs = target ? estimateLoadMs(target.size) : 6000
    const start = Date.now()
    progressTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - start
      const pct = Math.min(95, (elapsed / expectedMs) * 95)
      setLoadProgress(pct)
    }, 80)

    try {
      const res = await fetch(`${API}/models/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name })
      })
      const data = await res.json()
      clearInterval(progressTimerRef.current)
      if (data.error) {
        setLoadProgress(0)
        setError({ model: name, message: data.error, modelSize: data.modelSize, freeRAM: data.freeRAM })
      } else if (data.success) {
        setLoadProgress(100)
        setCurrentModel(name)
        setError(null)
        if (onModelChange) onModelChange(name)
        // Brief pause so the user sees the bar complete, then collapse.
        setTimeout(() => {
          setOpen(false)
          setLoadProgress(0)
          fetchModels()  // refresh memory/free-RAM numbers
        }, 350)
      }
    } catch (err) {
      clearInterval(progressTimerRef.current)
      setLoadProgress(0)
      setError({ model: name, message: err.message })
    }
    setSwitching(null)
  }

  // Unload the resident model from RAM. The next message reloads it (cold).
  const ejectModel = async () => {
    if (ejecting) return
    setEjecting(true)
    setError(null)
    try {
      const res = await fetch(`${API}/models/eject`, { method: 'POST' })
      const data = await res.json()
      if (data.error) setError({ message: data.error })
      await fetchModels()
    } catch (err) {
      setError({ message: err.message })
    }
    setEjecting(false)
  }

  useEffect(() => () => clearInterval(progressTimerRef.current), [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); if (!open) fetchModels() }}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground rounded-md hover:bg-muted transition-colors"
      >
        <Cpu className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{currentModel || 'No model'}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-80 bg-background border rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Memory info + eject */}
          {memory && (
            <div className="px-3 py-2 bg-surface-2 border-b text-[11px] text-muted-foreground flex items-center gap-3">
              <span>Total: {formatBytes(memory.total)}</span>
              <span>Free: {formatBytes(memory.free)}</span>
              {memory.loaded > 0 && (
                <button
                  onClick={ejectModel}
                  disabled={ejecting || !!switching}
                  title="Unload the model from RAM to free memory"
                  className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:bg-muted hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {ejecting ? <HelicopterLoader className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                  {ejecting ? 'Ejecting…' : `Eject (${formatBytes(memory.loaded)})`}
                </button>
              )}
            </div>
          )}

          {/* Load progress */}
          {switching && (
            <div className="px-3 py-2.5 border-b bg-surface-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
                <span className="truncate pr-2">
                  Loading <span className="text-foreground font-medium">{switching}</span>…
                </span>
                <span className="tabular-nums">{Math.round(loadProgress)}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-100 ease-out"
                  style={{ width: `${loadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Model list */}
          <div className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
                <HelicopterLoader className="h-5 w-5" />
                Loading models...
              </div>
            ) : models.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No models found</p>
            ) : (
              models.map((m) => (
                <button
                  key={m.name}
                  onClick={() => selectModel(m.name)}
                  disabled={!!switching}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {/* Active indicator */}
                  <div className="w-4 shrink-0">
                    {m.name === currentModel && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>

                  {/* Model info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{m.name}</span>
                    </div>
                    <div className="flex gap-2 text-[11px] text-muted-foreground">
                      <span>{formatBytes(m.size)}</span>
                      {m.parameterSize && <span>{m.parameterSize}</span>}
                      {m.quantization && <span>{m.quantization}</span>}
                    </div>
                  </div>

                  {/* RAM fit indicator */}
                  <div className="shrink-0">
                    {m.fitsInRAM ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-correct text-correct-text">fits</span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-review text-review-text">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        low RAM
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="px-3 py-2 border-t bg-wrong">
              <p className="text-xs text-wrong-text">
                {error.modelSize && error.freeRAM
                  ? `Model needs ${formatBytes(error.modelSize)} but only ${formatBytes(error.freeRAM)} free.`
                  : error.message}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
