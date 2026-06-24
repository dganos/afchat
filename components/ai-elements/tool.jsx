import * as React from 'react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown, CheckCircle2, AlertTriangle, FileText, FolderOpen, Search } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'

// Keyed by the agent package's canonical tool names (older aliases kept for
// backward compatibility with any cached transcripts).
const toolIcons = {
  list_directory: FolderOpen,
  read_text_file: FileText,
  search_content: Search,
  search_files: Search,
  listFiles: FolderOpen,
  readFile: FileText,
  searchText: Search,
}

// Human-readable Hebrew labels — the user shouldn't have to parse raw tool names.
const toolLabels = {
  list_directory: 'עיון בתיקייה',
  read_text_file: 'קריאת קובץ',
  search_content: 'חיפוש במסמכים',
  search_files: 'חיפוש במסמכים',
  listFiles: 'עיון בתיקייה',
  readFile: 'קריאת קובץ',
  searchText: 'חיפוש במסמכים',
}

// Pull a one-line summary out of the tool arguments (the query / path), so the
// collapsed card says *what* it did without expanding.
function summarize(args) {
  if (!args || typeof args !== 'object') return ''
  const v = args.query ?? args.q ?? args.pattern ?? args.path ?? args.filename ?? args.file ?? args.directory ?? args.dir
  if (typeof v === 'string') return v
  const fallback = Object.values(args).find((x) => typeof x === 'string')
  return fallback || ''
}

function isErrorResult(result) {
  if (!result) return false
  if (typeof result === 'string') return /\b(error|failed)\b|שגיאה|נכשל/i.test(result)
  if (typeof result === 'object') return Boolean(result.error)
  return false
}

export function Tool({ toolName, state, args, result, className }) {
  const [open, setOpen] = React.useState(false)
  const Icon = toolIcons[toolName] || FileText
  const label = toolLabels[toolName] || toolName
  const isDone = state === 'result'
  const isError = isDone && isErrorResult(result)
  const summary = summarize(args)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('my-1.5 w-full max-w-md', className)}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            'group flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isError
              ? 'border-wrong-border bg-wrong hover:brightness-95'
              : isDone
                ? 'border-border bg-surface-2 hover:bg-surface'
                : 'border-primary-soft bg-primary-soft hover:brightness-95'
          )}
        >
          {/* status */}
          <span className="shrink-0">
            {!isDone
              ? <HelicopterLoader className="h-4 w-4 text-primary" />
              : isError
                ? <AlertTriangle className="h-3.5 w-3.5 text-wrong-text" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-correct-text" />
            }
          </span>
          {/* tool kind */}
          <Icon className={cn('h-3.5 w-3.5 shrink-0', isDone ? 'text-fg-muted' : 'text-primary')} />
          {/* label + inline summary */}
          <span className={cn('font-medium shrink-0', isDone ? 'text-fg' : 'text-primary')}>{label}</span>
          {summary && (
            <span className="truncate text-fg-muted font-mono" dir="auto">{summary}</span>
          )}
          <ChevronDown className={cn('ms-auto h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1 space-y-2 rounded-md border border-border bg-surface px-2.5 py-2">
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-fg-faint">קלט</div>
              <pre className="overflow-x-auto rounded bg-surface-2 p-1.5 font-mono text-[11px] text-fg-muted">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {isDone && result != null && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-fg-faint">פלט</div>
              <pre className="max-h-48 overflow-auto rounded bg-surface-2 p-1.5 font-mono text-[11px] text-fg-muted whitespace-pre-wrap break-words">
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
