import * as React from 'react'
import { cn } from '@/lib/utils'
import { SendHorizontal, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function PromptInput({ children, onSubmit, className }) {
  return (
    <form
      onSubmit={onSubmit}
      className={cn('flex items-end gap-2 border-t bg-background px-4 py-3', className)}
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
        'flex-1 resize-none bg-transparent text-sm placeholder:text-muted-foreground',
        'border rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    />
  )
}

export function PromptInputSubmit({ isStreaming, disabled }) {
  return (
    <Button
      type="submit"
      size="icon"
      disabled={disabled}
      className="shrink-0 rounded-xl"
    >
      {isStreaming
        ? <Square className="h-4 w-4" />
        : <SendHorizontal className="h-4 w-4" />
      }
    </Button>
  )
}
