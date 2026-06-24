'use client'

import { X, Settings2 } from 'lucide-react'

export function SettingsPanel({ open, onClose, settings, onSettingsChange }) {
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
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t text-[11px] text-muted-foreground">
          Settings are stored locally in your browser
        </div>
      </div>
    </div>
  )
}
