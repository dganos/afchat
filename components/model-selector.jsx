'use client'

import { useState, useEffect, useRef } from 'react'
import { Cpu, ChevronDown, Check, AlertTriangle } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

const API = 'http://localhost:3001'

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function ModelSelector({ onModelChange }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState([])
  const [currentModel, setCurrentModel] = useState('')
  const [memory, setMemory] = useState(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(null)
  const [error, setError] = useState(null)
  const ref = useRef(null)

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
    setSwitching(name)
    setError(null)
    try {
      const res = await fetch(`${API}/models/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name })
      })
      const data = await res.json()
      if (data.error) {
        setError({ model: name, message: data.error, modelSize: data.modelSize, freeRAM: data.freeRAM })
      } else if (data.success) {
        setCurrentModel(name)
        setOpen(false)
        setError(null)
        if (onModelChange) onModelChange(name)
      }
    } catch (err) {
      setError({ model: name, message: err.message })
    }
    setSwitching(null)
  }

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
          {/* Memory info */}
          {memory && (
            <div className="px-3 py-2 bg-muted/30 border-b text-[11px] text-muted-foreground flex gap-3">
              <span>Total: {formatBytes(memory.total)}</span>
              <span>Free: {formatBytes(memory.free)}</span>
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
                  disabled={switching === m.name || !m.fitsInRAM}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {/* Active indicator */}
                  <div className="w-4 shrink-0">
                    {m.name === currentModel && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>

                  {/* Model info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{m.name}</span>
                      {switching === m.name && <HelicopterLoader className="h-4 w-4" />}
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600">fits</span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
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
            <div className="px-3 py-2 border-t bg-red-500/5">
              <p className="text-xs text-red-700">
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
