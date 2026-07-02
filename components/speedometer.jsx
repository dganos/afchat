'use client'

// Car-style speedometer for the live speed check. The needle sweeps a 240° arc
// (lower-left → top → lower-right) and animates smoothly to `value` (tok/s) via a
// CSS transition. `max` auto-ranges in the parent so the dial stays readable as
// generation (~tens) and prefill (~hundreds) differ by an order of magnitude.
export function Speedometer({ value = 0, max = 60, label }) {
  const cx = 120, cy = 120, r = 80
  const frac = Math.max(0, Math.min(1, max ? value / max : 0))

  // Point at fraction f (0..1) along the arc, at radius rr. f=0 sits at -120°
  // (lower-left), f=1 at +120° (lower-right), measured clockwise from straight up.
  const pt = (f, rr) => {
    const th = (-120 + f * 240) * Math.PI / 180
    return [cx + rr * Math.sin(th), cy - rr * Math.cos(th)]
  }
  const arc = (f0, f1, rr) => {
    const [x0, y0] = pt(f0, rr), [x1, y1] = pt(f1, rr)
    const large = (f1 - f0) * 240 > 180 ? 1 : 0
    return `M ${x0} ${y0} A ${rr} ${rr} 0 ${large} 1 ${x1} ${y1}`
  }

  // Major ticks + numeric labels at 0 / ¼ / ½ / ¾ / max.
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col items-center select-none">
      <svg viewBox="0 0 240 176" className="w-full" role="img" aria-label={`${value} tokens per second`}>
        {/* track */}
        <path d={arc(0, 1, r)} fill="none" stroke="var(--border-strong)" strokeWidth="8" strokeLinecap="round" />
        {/* filled progress */}
        <path d={arc(0, Math.max(frac, 0.001), r)} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" />

        {/* ticks + labels */}
        {ticks.map((f, i) => {
          const [ox, oy] = pt(f, r - 6)
          const [ix, iy] = pt(f, r - 14)
          const [lx, ly] = pt(f, r - 28)
          return (
            <g key={i}>
              <line x1={ix} y1={iy} x2={ox} y2={oy} stroke="var(--text-faint)" strokeWidth="2" />
              <text x={lx} y={ly} dy="0.32em" textAnchor="middle" fontSize="10" fill="var(--text-faint)" className="tabular-nums">
                {Math.round(max * f)}
              </text>
            </g>
          )
        })}

        {/* needle (rotates from straight up; CSS transition animates the sweep) */}
        <g style={{ transform: `rotate(${-120 + frac * 240}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: 'transform 0.3s ease-out' }}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - (r - 8)} stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r="7" fill="var(--accent)" />
        <circle cx={cx} cy={cy} r="3" fill="var(--surface)" />

        {/* digital readout */}
        <text x={cx} y={cy + 38} textAnchor="middle" fontSize="30" fontWeight="600" fill="var(--text)" className="tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {value.toFixed(value < 100 ? 1 : 0)}
        </text>
        <text x={cx} y={cy + 52} textAnchor="middle" fontSize="11" fill="var(--text-muted)">tok/s</text>
      </svg>

      {label && <p className="text-xs font-medium text-muted-foreground mt-1">{label}</p>}
    </div>
  )
}
