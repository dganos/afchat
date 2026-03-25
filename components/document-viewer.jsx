'use client'

import { useState, useEffect } from 'react'
import { X, FileText, Loader2 } from 'lucide-react'

const API = 'http://localhost:3001'

export function DocumentViewer({ filename, onClose }) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!filename) return
    setLoading(true)
    setError(null)
    fetch(`${API}/documents/${encodeURIComponent(filename)}/content`)
      .then(res => res.json())
      .then(data => {
        if (data.error) setError(data.error)
        else setContent(data.content)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [filename])

  if (!filename) return null

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[90%] h-[85%] max-w-3xl bg-background rounded-lg shadow-xl border flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
          <FileText className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm truncate">{filename}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Loading document...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full text-destructive">
              <p>Error: {error}</p>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap text-sm leading-relaxed font-mono break-words">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
