import * as React from 'react'
import { cn } from '@/lib/utils'
import { Bot, User } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

export function Message({ children, from = 'assistant', isThinking = false, className }) {
  const isUser = from === 'user'

  return (
    <div
      role="article"
      aria-label={isUser ? 'הודעה שלך' : 'תשובת אריסטו'}
      className={cn('flex gap-3 mb-3', isUser ? 'flex-row-reverse' : '', className)}
    >
      <MessageAvatar role={from} isThinking={isThinking} />
      <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start', 'max-w-[86%]')}>
        {children}
      </div>
    </div>
  )
}

export function MessageAvatar({ role, isThinking = false }) {
  const isUser = role === 'user'

  return (
    <div className={cn(
      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
      isUser ? 'bg-primary text-on-accent' : 'bg-surface-2 text-fg-muted'
    )}>
      {isUser
        ? <User className="h-4 w-4" />
        : isThinking
          ? <HelicopterLoader className="h-5 w-5" />
          : <Bot className="h-4 w-4" />
      }
    </div>
  )
}

export function MessageContent({ children, from = 'assistant', className }) {
  const isUser = from === 'user'

  return (
    <div className={cn(
      // bubbles: --r-lg with one squared "tail" corner per side
      'rounded-lg px-3 py-[9px] text-[15px] leading-relaxed',
      isUser
        ? 'bg-user-bubble text-user-bubble-text rounded-br-[3px]'
        : 'bg-assistant-bubble text-assistant-bubble-text border border-border rounded-bl-[3px]',
      className
    )}>
      {children}
    </div>
  )
}
