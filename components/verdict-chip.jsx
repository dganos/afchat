import * as React from 'react'
import { cn } from '@/lib/utils'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'

// QA verdict chip. Three states map to the verdict tokens. Color is ALWAYS
// paired with an icon + text label — never color alone (WCAG: don't rely on
// color). Pass `source` to append a reference (e.g. "§4.2").
const VARIANTS = {
  verified: {
    Icon: CheckCircle2,
    label: 'מאומת',
    className: 'bg-correct text-correct-text border-correct-border',
  },
  review: {
    Icon: AlertTriangle,
    label: 'דורש בדיקה',
    className: 'bg-review text-review-text border-review-border',
  },
  wrong: {
    Icon: XCircle,
    label: 'לא אומת',
    className: 'bg-wrong text-wrong-text border-wrong-border',
  },
}

export function VerdictChip({ state = 'review', label, source, className }) {
  const variant = VARIANTS[state] || VARIANTS.review
  const { Icon } = variant

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium',
        variant.className,
        className
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label || variant.label}</span>
      {source && <span className="opacity-70">· {source}</span>}
    </span>
  )
}
