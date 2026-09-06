import { useRef, useState } from 'react'
import { parseBytes, toHex } from '../hid/hex'
import { TimeoutError } from '../hid/link'
import { t as translate, useT } from '../i18n'
import { T } from '../i18n/T'
import {
  COMMAND,
  KNOWN_COMMANDS,
  MAGIC,
  MAGIC_FIRMWARE,
  REPORT_ID,
  SAFE_COMMANDS,
  WRITES_STATE,
  buildPacket,
  isEvent,
  isReplyTo,
  parseReply,
} from '../protocol/frame'
import { Notice, Panel } from '../ui/Panel'
import { link, useConnection } from '../state/link'
import { Select } from '../ui/Select'

interface Probe {
  value: number
  sent: string
  reply?: string
  ack?: boolean
  data?: boolean
  ms?: number
  error?: string
}

const SWEEP_MARK = '??'

/**
 * `frame` builds a real Raven61 packet (magic, checksum) and sweeps the command
 * byte. The board only answers a correctly checksummed packet, so this is the
 * mode that actually finds commands; the raw modes remain for exploring other
 * framings.
 */
type Mode = 'frame' | 'output' | 'feature'

const KNOWN = new Set(KNOWN_COMMANDS)
const RISKY = new Set<number>(WRITES_STATE)
const SAFE = new Set<number>(SAFE_COMMANDS)

export function Prober() {
  const { connected } = useConnection()
  const [mode, setMode] = useState<Mode>('frame')
  const [magic, setMagic] = useState(MAGIC.toString(16))
  const [template, setTemplate] = useState('?? 00 00 00')
  const [reportId, setReportId] = useState(String(REPORT_ID))
  const [from, setFrom] = useState('00')
  const [to, setTo] = useState('ff')
  const [knownOnly, setKnownOnly] = useState(true)
  const [skipRisky, setSkipRisky] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState('300')
  const [delayMs, setDelayMs] = useState('20')
  const [acknowledged, setAcknowledged] = useState(false)
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<Probe[]>([])
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)
  const t = useT()

  const payloadFor = (value: number): Uint8Array => {
    if (mode === 'frame') return buildPacket(value, { magic: Number.parseInt(magic, 16) || MAGIC })
    if (!template.includes(SWEEP_MARK))
      throw new Error(translate('prober.noPlaceholder', { mark: SWEEP_MARK }))
    return parseBytes(template.replaceAll(SWEEP_MARK, value.toString(16).padStart(2, '0')))
  }

  const start = async () => {
    setError(null)
    setRows([])
    cancelled.current = false
    const lo = parseInt(from, 16)
    const hi = parseInt(to, 16)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi > 0xff) {
      setError(t('prober.badRange'))
      return
    }
    let values =
      mode === 'frame' && knownOnly
        ? KNOWN_COMMANDS.filter((v) => v >= lo && v <= hi)
        : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    if (mode === 'frame' && skipRisky) values = values.filter((v) => !RISKY.has(v))

    setRunning(true)
    link.log.note(`prober ${mode} sweep ${from}-${to} (${values.length} values)`)
    const acc: Probe[] = []
    try {
      for (const v of values) {
        if (cancelled.current) break
        const payload = payloadFor(v)
        const row: Probe = { value: v, sent: `${toHex(payload.slice(0, 8))} …` }
        const t0 = performance.now()
        const id = Number(reportId) || 0
        const note = `probe 0x${v.toString(16).padStart(2, '0')}`
        try {
          if (mode === 'feature') {
            await link.setFeature(payload, id, note)
            row.reply = toHex(await link.getFeature(id, note))
          } else {
            if (wrap) {
              await link.request(buildPacket(COMMAND.begin), {
                reportId: id,
                timeoutMs: Number(timeoutMs) || 300,
                note: 'begin',
                match: (_rid, d) => isReplyTo(COMMAND.begin, d),
              })
            }
            const reply = await link.request(payload, {
              reportId: id,
              timeoutMs: Number(timeoutMs) || 300,
              note,
              // Unsolicited 0xA0 events interleave with replies, so only the
              // echo of this exact command counts as the answer.
              match: (_rid, d) => isReplyTo(v, d),
            })
            row.reply = toHex(reply.data)
            row.ack = parseReply(reply.data).kind === 'ack'
            row.data = isEvent(reply.data)
            if (wrap) {
              await link.request(buildPacket(COMMAND.end), {
                reportId: id,
                timeoutMs: Number(timeoutMs) || 300,
                note: 'end',
                match: (_rid, d) => isReplyTo(COMMAND.end, d),
              })
            }
          }
          row.ms = Math.round(performance.now() - t0)
        } catch (e) {
          if (!(e instanceof TimeoutError)) row.error = e instanceof Error ? e.message : String(e)
        }
        acc.push(row)
        setRows(acc.slice())
        const d = Number(delayMs) || 0
        if (d > 0) await new Promise((r) => setTimeout(r, d))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const answered = rows.filter((r) => r.reply)
  const acked = rows.filter((r) => r.ack)

  return (
    <Panel title={t('prober.title')}>
      <Notice kind="warn">
        <strong>{t('prober.warning.title')}</strong>
        <div className="small" style={{ marginTop: 4 }}>
          <T k="prober.warning.body" />
        </div>
      </Notice>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="small dim">
          {t('prober.mode')}
          <Select
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            style={{ display: 'block', marginTop: 4 }}
            options={[
              { value: 'frame', label: t('prober.mode.frame') },
              { value: 'output', label: 'RAW OUTPUT → IN' },
              { value: 'feature', label: 'RAW FEATURE (set → get)' },
            ]}
          />
        </label>

        {mode === 'frame' ? (
          <label className="small dim">
            {t('prober.magic')}
            <Select
              value={magic}
              onChange={setMagic}
              style={{ display: 'block', marginTop: 4 }}
              options={[
                { value: MAGIC.toString(16), label: t('prober.magic.config') },
                { value: MAGIC_FIRMWARE.toString(16), label: t('prober.magic.firmware') },
              ]}
            />
          </label>
        ) : (
          <label className="small dim" style={{ flex: '1 1 280px' }}>
            <T k="prober.template" params={{ mark: SWEEP_MARK }} />
            <input
              type="text"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              style={{ width: '100%', marginTop: 4 }}
            />
          </label>
        )}

        <label className="small dim">
          Report ID
          <input
            type="text"
            value={reportId}
            onChange={(e) => setReportId(e.target.value)}
            style={{ width: 60, display: 'block', marginTop: 4 }}
          />
        </label>
        <label className="small dim">
          {t('prober.from')}
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: 56, display: 'block', marginTop: 4 }}
          />
        </label>
        <label className="small dim">
          {t('prober.to')}
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ width: 56, display: 'block', marginTop: 4 }}
          />
        </label>
        {mode !== 'feature' && (
          <label className="small dim">
            {t('prober.timeout')}
            <input
              type="text"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              style={{ width: 70, display: 'block', marginTop: 4 }}
            />
          </label>
        )}
        <label className="small dim">
          {t('prober.interval')}
          <input
            type="text"
            value={delayMs}
            onChange={(e) => setDelayMs(e.target.value)}
            style={{ width: 70, display: 'block', marginTop: 4 }}
          />
        </label>
      </div>

      {mode === 'frame' && (
        <label className="small dim" style={{ display: 'block', marginTop: 10 }}>
          <input type="checkbox" checked={knownOnly} onChange={(e) => setKnownOnly(e.target.checked)} />{' '}
          {t('prober.knownOnly', { count: KNOWN_COMMANDS.length })}
        </label>
      )}
      {mode === 'frame' && (
        <label className="small dim" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={skipRisky} onChange={(e) => setSkipRisky(e.target.checked)} />{' '}
          {t('prober.safeOnly', {
            commands: [...SAFE].map((c) => `0x${c.toString(16).padStart(2, '0')}`).join(', '),
          })}
        </label>
      )}
      {mode !== 'feature' && (
        <label className="small dim" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
          {t('prober.wrap')}
        </label>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <label className="small">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />{' '}
          {t('prober.acknowledge')}
        </label>
        <button className="primary" onClick={start} disabled={!connected || running || !acknowledged}>
          {t('prober.start')}
        </button>
        <button
          className="danger"
          onClick={() => {
            cancelled.current = true
          }}
          disabled={!running}
        >
          {t('prober.stop')}
        </button>
        <span className="dim small">
          {t('prober.stats', {
            tried: rows.length,
            answered: answered.length,
            acked: acked.length,
          })}
        </span>
      </div>

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: 12, maxHeight: 380, overflow: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>{t('prober.col.command')}</th>
                <th style={{ width: 70 }}>{t('prober.col.kind')}</th>
                <th style={{ width: 55 }}>ms</th>
                <th>{t('prober.col.reply')}</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.reply || r.error)
                .map((r) => (
                  <tr key={r.value}>
                    <td className="mono">
                      0x{r.value.toString(16).padStart(2, '0')}
                      {KNOWN.has(r.value) && <span className="dim"> ★</span>}
                      {RISKY.has(r.value) && <span style={{ color: 'var(--err)' }}> ⚠</span>}
                    </td>
                    <td style={{ color: r.data ? 'var(--warn)' : r.ack ? 'var(--ok)' : 'var(--fg-dim)' }}>
                      {r.data ? t('prober.data') : r.ack ? 'ACK' : '—'}
                    </td>
                    <td className="mono dim">{r.ms ?? ''}</td>
                    <td className="mono small">
                      {r.reply ?? <span style={{ color: 'var(--err)' }}>{r.error}</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {answered.length === 0 && !running && (
            <div className="small dim" style={{ marginTop: 8 }}>
              {t('prober.noAnswer')}
            </div>
          )}
          <div className="small dim" style={{ marginTop: 6 }}>
            {t('prober.legend', {
              globalSettings: `0x${COMMAND.globalSettings.toString(16)}`,
            })}
          </div>
        </div>
      )}
    </Panel>
  )
}
