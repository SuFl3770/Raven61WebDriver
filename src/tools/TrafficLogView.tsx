import { useEffect, useMemo, useRef, useState } from 'react'
import { diffOffsets, toHex } from '../hid/hex'
import type { TrafficEntry } from '../hid/log'
import { useT } from '../i18n'
import { Panel } from '../ui/Panel'
import { link, useTraffic } from '../state/link'

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function TrafficLogView() {
  const entries = useTraffic()
  const t = useT()
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [a, setA] = useState<TrafficEntry | null>(null)
  const [b, setB] = useState<TrafficEntry | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => toHex(e.data).includes(q) || e.dir.includes(q) || (e.note ?? '').toLowerCase().includes(q),
    )
  }, [entries, filter])

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [shown, follow])

  const pick = (e: TrafficEntry) => {
    if (a?.seq === e.seq) return setA(null)
    if (b?.seq === e.seq) return setB(null)
    if (!a) return setA(e)
    setB(e)
  }

  const diff = a && b ? diffOffsets(a.data, b.data) : null

  return (
    <Panel title={t('log.title')}>
      <div className="row">
        <input
          type="text"
          placeholder={t('log.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: '1 1 240px' }}
        />
        <label className="small dim">
          {t('log.follow')}{' '}
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        </label>
        <button onClick={() => download('raven61-traffic.txt', link.log.toText())}>
          {t('log.exportTxt')}
        </button>
        <button onClick={() => download('raven61-traffic.json', link.log.toJSON())}>
          {t('log.exportJson')}
        </button>
        <button
          className="danger"
          onClick={() => {
            link.log.clear()
            setA(null)
            setB(null)
          }}
        >
          {t('log.clear')}
        </button>
      </div>

      <div className="log" ref={boxRef}>
        {shown.map((e) => {
          const tag = a?.seq === e.seq ? 'A' : b?.seq === e.seq ? 'B' : ''
          return (
            <div
              key={e.seq}
              className={`line ${e.dir}`}
              onClick={() => e.dir !== 'note' && pick(e)}
              style={tag ? { background: 'var(--accent-dim)' } : undefined}
            >
              <span>{e.t.toFixed(3)}</span>
              <span>
                {tag ? `[${tag}] ` : ''}
                {e.dir}
              </span>
              <span>{e.dir === 'note' ? '' : e.reportId}</span>
              <span>{e.dir === 'note' ? e.note : `${toHex(e.data)}${e.note ? `   ; ${e.note}` : ''}`}</span>
            </div>
          )
        })}
      </div>

      {diff && (
        <pre className="dump" style={{ marginTop: 10 }}>
          {`A #${a!.seq}  ${toHex(a!.data)}\nB #${b!.seq}  ${toHex(b!.data)}\n` +
            t('log.diff', {
              offsets: diff.length ? diff.join(', ') : t('log.diffNone'),
            })}
        </pre>
      )}
    </Panel>
  )
}
