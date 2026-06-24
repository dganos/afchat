'use client'

import { useState, useEffect, useRef } from 'react'
import { FolderOpen, Upload, Trash2, File, X } from 'lucide-react'
import { DocumentViewer } from './document-viewer'

const API = 'http://localhost:3001'

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocumentsPanel({ open, onClose }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [viewingFile, setViewingFile] = useState(null)
  const fileInputRef = useRef(null)

  const fetchFiles = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/documents`)
      const data = await res.json()
      setFiles(data.files || [])
    } catch (err) {
      console.error('Failed to fetch documents:', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (open) fetchFiles()
  }, [open])

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files)
    if (!selectedFiles.length) return

    setUploading(true)
    for (const file of selectedFiles) {
      try {
        const body = await file.arrayBuffer()
        await fetch(`${API}/documents`, {
          method: 'POST',
          headers: { 'X-Filename': encodeURIComponent(file.name) },
          body
        })
      } catch (err) {
        console.error(`Failed to upload ${file.name}:`, err)
      }
    }
    fileInputRef.current.value = ''
    setUploading(false)
    fetchFiles()
  }

  const handleDelete = async (filename) => {
    try {
      await fetch(`${API}/documents/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      })
      fetchFiles()
    } catch (err) {
      console.error(`Failed to delete ${filename}:`, err)
    }
  }

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-80 h-full bg-background border-l shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <FolderOpen className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">Documents</span>
          <button onClick={onClose} aria-label="סגור" className="ml-auto p-1 rounded hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Upload */}
        <div className="px-4 py-3 border-b">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleUpload}
            className="hidden"
            accept=".txt,.md,.csv,.json,.xml,.html,.log,.yaml,.yml,.toml,.ini,.cfg,.conf,.pdf,.doc,.docx"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 text-sm font-medium rounded-md border border-dashed border-border-strong hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading...' : 'Upload Documents'}
          </button>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No documents yet</p>
          ) : (
            <ul className="divide-y">
              {files.map((file) => (
                <li
                  key={file.name}
                  onClick={() => setViewingFile(file.name)}
                  className="flex items-center gap-2 px-4 py-2 hover:bg-surface-2 group cursor-pointer select-none"
                >
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{file.name}</p>
                    <p className="text-[11px] text-muted-foreground">{formatSize(file.size)}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(file.name) }}
                    aria-label={`מחק ${file.name}`}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-wrong hover:text-wrong-text transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t text-[11px] text-muted-foreground">
          {files.length} document{files.length !== 1 ? 's' : ''} — click to view
        </div>
      </div>

      {/* Document viewer modal */}
      <DocumentViewer filename={viewingFile} onClose={() => setViewingFile(null)} />
    </div>
  )
}
