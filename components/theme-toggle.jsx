'use client'

import { useState, useEffect } from 'react'
import { Sun, Moon } from 'lucide-react'

// Toggles [data-theme] on <html> and persists the choice. The initial value is
// already set before paint by the inline script in app/layout.jsx; here we just
// read it back and flip it.
export function ThemeToggle() {
  const [theme, setTheme] = useState(null)

  useEffect(() => {
    setTheme(document.documentElement.getAttribute('data-theme') || 'light')
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    try { localStorage.setItem('aristo-theme', next) } catch { /* private mode */ }
  }

  // Render a same-size placeholder until mounted, to avoid a hydration mismatch
  // and a layout shift (we can't know the resolved theme during SSR).
  if (theme === null) return <div className="h-9 w-9" aria-hidden="true" />

  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'עבור למצב בהיר' : 'עבור למצב כהה'}
      title={isDark ? 'מצב בהיר' : 'מצב כהה'}
      className="flex h-9 w-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}
