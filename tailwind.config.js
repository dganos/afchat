/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './node_modules/streamdown/dist/**/*.js'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        /* ── design-system tokens ── */
        canvas: 'var(--canvas)',
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        fg: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
        },
        primary: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          soft: 'var(--accent-soft)',
          foreground: 'var(--on-accent)',
        },
        'on-accent': 'var(--on-accent)',
        link: 'var(--link)',
        'user-bubble': {
          DEFAULT: 'var(--user-bubble-bg)',
          text: 'var(--user-bubble-text)',
        },
        'assistant-bubble': {
          DEFAULT: 'var(--assistant-bubble-bg)',
          text: 'var(--assistant-bubble-text)',
        },
        correct: {
          DEFAULT: 'var(--correct-bg)',
          text: 'var(--correct-text)',
          border: 'var(--correct-border)',
        },
        review: {
          DEFAULT: 'var(--review-bg)',
          text: 'var(--review-text)',
          border: 'var(--review-border)',
        },
        wrong: {
          DEFAULT: 'var(--wrong-bg)',
          text: 'var(--wrong-text)',
          border: 'var(--wrong-border)',
        },

        /* ── back-compat aliases → mapped onto the new tokens so existing
              utility classes keep resolving to design tokens ── */
        background: 'var(--canvas)',
        foreground: 'var(--text)',
        card: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
        secondary: {
          DEFAULT: 'var(--surface-2)',
          foreground: 'var(--text)',
        },
        muted: {
          DEFAULT: 'var(--surface-2)',
          foreground: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--surface-2)',
          foreground: 'var(--text)',
        },
        destructive: {
          DEFAULT: 'var(--wrong-text)',
          foreground: 'var(--on-accent)',
        },
        input: 'var(--border)',
        ring: 'var(--focus-ring)',
      },
      borderRadius: {
        lg: 'var(--r-lg)',
        md: 'var(--r-md)',
        sm: 'var(--r-sm)',
      },
    },
  },
  plugins: [],
}
