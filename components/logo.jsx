import * as React from 'react'
import { cn } from '@/lib/utils'

// The "o" of Aristo: a ring carrying the SAME foreground→accent gradient as the
// wordmark, with a small rotor sitting inside it.
const BLADE = 'M48.6 50 L49 26 Q49.2 23.5 50 23.5 Q50.8 23.5 51 26 L51.4 50 Z'

export function LogoMark({ className = 'h-8 w-8', ...props }) {
  const id = React.useId()  // unique gradient id per instance (header + hero)
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--text)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      {/* the letter "o" — gradient stroke matching the wordmark, weight ~ the type */}
      <circle cx="50" cy="50" r="38" stroke={`url(#${id})`} strokeWidth="14" />
      {/* rotor inside, same gradient */}
      <g fill={`url(#${id})`} transform="rotate(15 50 50)">
        {[0, 90, 180, 270].map((a) => (
          <path key={a} d={BLADE} transform={`rotate(${a} 50 50)`} />
        ))}
      </g>
      <circle cx="50" cy="50" r="4.5" fill={`url(#${id})`} />
    </svg>
  )
}

// Wordmark "Aristo" where the rotor mark is the "o": Arist + ◉.
export function Logo({ className, glow = false }) {
  return (
    // dir="ltr": the Latin lockup reads left→right even in the RTL app shell.
    <span dir="ltr" className={cn('inline-flex items-baseline leading-none select-none font-semibold tracking-tight', className)}>
      <span className="bg-gradient-to-br from-fg to-primary bg-clip-text text-transparent">Arist</span>
      <LogoMark
        className={cn(
          'h-[0.55em] w-[0.55em] translate-y-[0.04em]',  // x-height, sitting on the baseline like an "o"
          glow && 'drop-shadow-[0_0_0.4em_rgba(59,130,246,0.5)]'
        )}
      />
    </span>
  )
}
