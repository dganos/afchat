import * as React from 'react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronRight, CheckCircle2, FileText, FolderOpen, Search } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

const toolIcons = {
  listFiles: FolderOpen,
  readFile: FileText,
  searchText: Search,
}

export function Tool({ toolName, state, result, className }) {
  const [open, setOpen] = React.useState(false)
  const Icon = toolIcons[toolName] || FileText
  const isDone = state === 'result'

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg my-1 transition-colors',
            'hover:bg-accent',
            isDone ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
            className
          )}
        >
          {isDone
            ? <CheckCircle2 className="h-3.5 w-3.5" />
            : <HelicopterLoader className="h-4 w-4" />
          }
          <Icon className="h-3.5 w-3.5" />
          <span className="font-mono">{toolName}</span>
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isDone && result && (
          <pre className="mt-1 mb-2 p-2 rounded-lg bg-muted text-xs overflow-x-auto max-h-40">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
