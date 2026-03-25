export function HelicopterLoader({ className = 'h-5 w-5', spinning = true }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      {/* Main rotor blades */}
      <g className={spinning ? 'animate-propeller' : ''} style={{ transformOrigin: '50px 28px' }}>
        {/* Left blade */}
        <path d="M50,28 Q35,26 8,24 Q5,24 5,26 Q5,28 8,29 Q35,30 50,28Z" fill="currentColor" opacity="0.85"/>
        {/* Right blade */}
        <path d="M50,28 Q65,26 92,24 Q95,24 95,26 Q95,28 92,29 Q65,30 50,28Z" fill="currentColor" opacity="0.85"/>
      </g>
      {/* Rotor mast */}
      <rect x="48" y="28" width="4" height="10" rx="1" fill="currentColor" opacity="0.7"/>
      {/* Cockpit - bubble canopy */}
      <ellipse cx="62" cy="44" rx="12" ry="10" fill="currentColor" opacity="0.25"/>
      <path d="M62,34 Q74,34 74,44 Q74,54 62,54 Q56,54 53,50" fill="currentColor" opacity="0.15"/>
      {/* Main fuselage */}
      <path d="M30,38 Q40,32 60,34 Q72,34 76,44 Q78,50 72,54 Q60,58 38,56 Q28,54 26,48 Q24,42 30,38Z" fill="currentColor" opacity="0.75"/>
      {/* Tail boom */}
      <path d="M30,44 L10,40 Q7,39.5 7,41 L7,43 Q7,44.5 10,44 L30,48Z" fill="currentColor" opacity="0.65"/>
      {/* Tail rotor */}
      <ellipse cx="8" cy="42" rx="2" ry="7" fill="currentColor" opacity="0.6"/>
      {/* Tail fin */}
      <path d="M12,40 L8,32 Q7,30 9,31 L14,38Z" fill="currentColor" opacity="0.55"/>
      {/* Engine housing */}
      <path d="M42,36 Q48,33 56,34 Q56,38 48,38 Q42,38 42,36Z" fill="currentColor" opacity="0.5"/>
      {/* Left skid strut front */}
      <rect x="38" y="54" width="2.5" height="10" rx="1" fill="currentColor" opacity="0.6"/>
      {/* Left skid strut rear */}
      <rect x="58" y="54" width="2.5" height="10" rx="1" fill="currentColor" opacity="0.6"/>
      {/* Cross bar front */}
      <line x1="39" y1="58" x2="59" y2="58" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/>
      {/* Landing skid */}
      <path d="M32,64 Q34,62 40,63 L60,63 Q66,62 68,64 Q69,65.5 67,66 L33,66 Q31,65.5 32,64Z" fill="currentColor" opacity="0.7"/>
      {/* Rotor hub */}
      <circle cx="50" cy="28" r="3" fill="currentColor" opacity="0.6"/>
    </svg>
  )
}
