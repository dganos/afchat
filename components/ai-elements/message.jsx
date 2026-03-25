import * as React from 'react'
import { cn } from '@/lib/utils'
import { Bot, User } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

export function Message({ children, from = 'assistant', isThinking = false, className }) {
  const isUser = from === 'user'

  return (
    <div className={cn('flex gap-3 mb-6', isUser ? 'flex-row-reverse' : '', className)}>
      <MessageAvatar role={from} isThinking={isThinking} />
      <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start', 'max-w-[80%]')}>
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
      isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
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
      'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
      isUser
        ? 'bg-primary text-primary-foreground rounded-tr-sm'
        : 'bg-muted text-foreground rounded-tl-sm',
      className
    )}>
      {children}
    </div>
  )
}
