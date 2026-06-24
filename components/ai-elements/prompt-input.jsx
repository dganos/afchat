import * as React from 'react'
import { cn } from '@/lib/utils'
import { ArrowUp, Square } from 'lucide-react'

export function PromptInput({ children, onSubmit, className }) {
  return (
    <form
      onSubmit={onSubmit}
      className={cn('flex items-end gap-2 border-t border-border bg-canvas px-4 py-3', className)}
    >
      {children}
    </form>
  )
}

export function PromptInputTextarea({ value, onChange, placeholder = 'Ask about your documents...', disabled, className }) {
  const textareaRef = React.useRef(null)

  React.useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const style = getComputedStyle(textarea)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const maxHeight = lineHeight * 3 + padY
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px'
  }, [value])

  React.useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [disabled])

  return (
    <textarea
      ref={textareaRef}
      dir="auto"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.target.form?.requestSubmit()
        }
      }}
      className={cn(
        'flex-1 resize-none min-h-[40px] bg-surface text-[15px] text-fg placeholder:text-fg-faint',
        'border border-border rounded-md px-4 py-2.5 transition-colors',
        'focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    />
  )
}

export function PromptInputSubmit({ isStreaming, disabled }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label={isStreaming ? 'עצור' : 'שלח'}
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
        'bg-primary text-on-accent transition-colors',
        'hover:bg-primary-hover active:bg-primary-active active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary'
      )}
    >
      {isStreaming
        ? <Square className="h-4 w-4" />
        : <ArrowUp className="h-4 w-4" />
      }
    </button>
  )
}
