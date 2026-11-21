'use client'

// Server admin page (?view=admin): status of the background server, Ollama and the
// model, actions (reload model / restart Ollama / stop server) and live logs.
import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Power, RotateCcw, ArrowRight } from 'lucide-react'
import { adminGet, adminPost } from '@/lib/admin-api'
import { ThemeToggle } from '@/components/theme-toggle'

const fmtBytes = (b) => b == null ? '—' : `${(b / 1024 ** 3).toFixed(1)} GB`
function fmtUptime(sec) {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`
}

function Dot({ ok, warn }) {
  const c = ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500'
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${c}`} />
}

function Card({ title, status, children }) {
  return (
    <div className="rounded-lg border border-border bg-canvas p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium">{status}{title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">{children}</dl>
    </div>
  )
}
const Row = ({ k, v }) => (<><dt className="text-fg-muted">{k}</dt><dd className="font-mono break-all" dir="ltr">{v ?? '—'}</dd></>)

function ActionButton({ onClick, icon: Icon, children, danger, busy }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-1.5 px-3 min-h-9 text-xs rounded-md border transition-colors disabled:opacity-50 ${
        danger ? 'border-red-500/40 text-red-600 hover:bg-red-500/10' : 'border-border hover:bg-surface-2'}`}
    >
      <Icon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />{children}
    </button>
  )
}

export function AdminApp() {
  const [status, setStatus] = useState(null)
  const [down, setDown] = useState(false)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [logs, setLogs] = useState([])
  const [source, setSource] = useState('all')
  const sinceRef = useRef(0)
  const logRef = useRef(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let alive = true, timer
    const tick = async () => {
      try {
        const s = await adminGet('status')
        if (!alive) return
        setStatus(s); setDown(false)
        const { entries } = await adminGet(`logs?since=${sinceRef.current}`)
        if (alive && entries.length) {
          sinceRef.current = entries[entries.length - 1].seq
          setLogs(prev => [...prev, ...entries].slice(-1500))
        }
      } catch { if (alive) setDown(true) }
      if (alive) timer = setTimeout(tick, 2000)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [logs, source])

  const act = async (name, path, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(name); setNotice(null)
    try { await adminPost(path); setNotice({ ok: true, text: 'בוצע' }) }
    catch (e) { setNotice({ ok: false, text: `נכשל: ${e.message}` }) }
    finally { setBusy(null) }
  }

  const shown = source === 'all' ? logs : logs.filter(l => l.source === source)
  const model = status?.model
  const ol = status?.ollama

  return (
    <div className="min-h-screen bg-surface-2 text-fg" dir="rtl">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-border bg-canvas">
        <a href="./" className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"><ArrowRight className="h-3.5 w-3.5" />לצ'אט</a>
        <h1 className="text-base font-semibold">ניהול שרת</h1>
        <div className="ms-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-fg-muted"><Dot ok={!down} />{down ? 'השרת לא זמין' : 'השרת פעיל'}</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="שרת" status={<Dot ok={!down} />}>
            <Row k="PID" v={status?.pid} />
            <Row k="זמן ריצה" v={fmtUptime(status?.uptimeSec)} />
            <Row k="פורט" v={status?.apiPort} />
            <Row k="Node" v={status?.node} />
            <Row k="זיכרון תהליך" v={fmtBytes(status?.memory?.rss)} />
          </Card>
          <Card title="Ollama" status={<Dot ok={ol?.running} />}>
            <Row k="מצב" v={ol ? (ol.running ? 'רץ' : 'עצור') : 'לא מנוהל'} />
            <Row k="PID" v={ol?.pid} />
            <Row k="פורט" v={ol?.port} />
          </Card>
          <Card title="מודל" status={<Dot ok={model?.ready} warn={!model?.error} />}>
            <Row k="שם" v={model?.name} />
            <Row k="מצב" v={model?.ready ? 'מוכן' : model?.error ? 'שגיאה' : 'נטען…'} />
            {model?.error && <Row k="שגיאה" v={model.error} />}
            <Row k="RAM פנוי" v={`${fmtBytes(status?.memory?.free)} / ${fmtBytes(status?.memory?.total)}`} />
          </Card>
        </div>

        <div className="rounded-lg border border-border bg-canvas p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton icon={RefreshCw} busy={busy === 'reload'} onClick={() => act('reload', 'reload-model')}>טען מודל מחדש</ActionButton>
            <ActionButton icon={RotateCcw} busy={busy === 'restart'} onClick={() => act('restart', 'restart-ollama', 'להפעיל מחדש את Ollama? שאלות פעילות ייקטעו.')}>הפעל מחדש את Ollama</ActionButton>
            <ActionButton icon={Power} danger busy={busy === 'stop'} onClick={() => act('stop', 'shutdown', 'לעצור את השרת? כדי להפעיל שוב: scripts\\aristo.ps1 start')}>עצור שרת</ActionButton>
            {notice && <span className={`text-xs ${notice.ok ? 'text-emerald-600' : 'text-red-600'}`}>{notice.text}</span>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs pt-2">
            <Row k="מסמכים" v={status?.docsPath} />
            <Row k="נתונים" v={status?.dataDir} />
            <Row k="קובץ לוג" v={status?.logFile} />
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-canvas">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-border text-xs">
            <span className="font-medium me-2">לוגים</span>
            {['all', 'api', 'ollama'].map(s => (
              <button key={s} onClick={() => setSource(s)}
                className={`px-2.5 py-1 rounded-md ${source === s ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>
                {s === 'all' ? 'הכל' : s === 'api' ? 'API' : 'Ollama'}
              </button>
            ))}
            <span className="ms-auto text-fg-muted">{shown.length} שורות</span>
          </div>
          <div
            ref={logRef}
            onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
            dir="ltr"
            className="h-[28rem] overflow-y-auto font-mono text-[11px] leading-relaxed p-2 bg-surface-2"
          >
            {shown.length === 0
              ? <p className="text-fg-muted text-center py-4">אין לוגים</p>
              : shown.map(l => (
                <div key={l.seq} className="flex gap-2">
                  <span className="text-fg-muted shrink-0">{new Date(l.time).toLocaleTimeString()}</span>
                  <span className={`shrink-0 ${l.source === 'ollama' ? 'text-sky-600' : 'text-violet-600'}`}>{l.source}</span>
                  <span className="whitespace-pre-wrap break-all">{l.text}</span>
                </div>
              ))}
          </div>
        </div>
      </main>
    </div>
  )
}
