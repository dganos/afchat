'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown, Brain } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

// Collapsible "thinking" panel. The trigger appears immediately when reasoning
// starts, but stays COLLAPSED by default — the user expands it on demand. Label
// it honestly. Consolidate all reasoning into one block upstream.
export function Reasoning({ children, isStreaming = false, duration, className }) {
  const [open, setOpen] = React.useState(false)

  const label = isStreaming
    ? 'חושב…'
    : duration != null
      ? `תהליך החשיבה · ${duration.toFixed(1)} שניות`
      : 'תהליך החשיבה'

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('my-1 w-full', className)}>
      <CollapsibleTrigger asChild>
        <button className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {isStreaming
            ? <HelicopterLoader className="h-3.5 w-3.5 text-primary" />
            : <Brain className="h-3.5 w-3.5" />
          }
          <span className="font-medium">{label}</span>
          <ChevronDown className={cn('ms-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-s-2 border-border ps-3 pe-1 text-xs leading-relaxed text-fg-muted whitespace-pre-wrap break-words" dir="auto">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
