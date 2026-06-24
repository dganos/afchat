'use client'

import { useState, useEffect, useRef } from 'react'
import { Terminal, ChevronUp, ChevronDown } from 'lucide-react'

export function LogsPanel() {
  const [logs, setLogs] = useState({ ollama: [], api: [] })
  const [activeTab, setActiveTab] = useState('ollama')
  const [open, setOpen] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronLogs) {
      window.electronLogs.onLog((source, text) => {
        setLogs(prev => ({
          ...prev,
          [source]: [...prev[source], { time: new Date().toLocaleTimeString(), text: text.trimEnd() }].slice(-200)
        }))
      })
    }
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, activeTab])

  const activeLogs = logs[activeTab] || []

  return (
    <div className="border-t bg-background">
      {/* Toggle bar */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-1.5 text-xs text-muted-foreground hover:bg-surface-2 transition-colors"
      >
        <Terminal className="h-3.5 w-3.5" />
        <span className="font-medium">Logs</span>
        <span className="ml-1 text-[10px] opacity-60">
          ollama: {logs.ollama.length} | api: {logs.api.length}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 ml-auto" /> : <ChevronUp className="h-3.5 w-3.5 ml-auto" />}
      </button>

      {open && (
        <div className="h-52">
          {/* Tabs */}
          <div className="flex gap-0 border-b px-2">
            {['ollama', 'api'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'ollama' ? 'Ollama Server' : 'Backend API'}
              </button>
            ))}
          </div>

          {/* Log output */}
          <div
            ref={scrollRef}
            className="h-[calc(100%-29px)] overflow-y-auto font-mono text-[11px] leading-relaxed p-2 bg-surface-2"
          >
            {activeLogs.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No logs yet</p>
            ) : (
              activeLogs.map((log, i) => (
                <div key={i} className="flex gap-2 hover:bg-surface-2">
                  <span className="text-muted-foreground shrink-0">{log.time}</span>
                  <span className="whitespace-pre-wrap break-all">{log.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
