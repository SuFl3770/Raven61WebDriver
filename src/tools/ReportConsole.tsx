import { useRef, useState } from 'react'
import { diffOffsets, hexDump, parseBytes, toHex } from '../hid/hex'
import { useT } from '../i18n'
import {
  BLOCK_CHUNK,
  COMMAND,
  MAGIC,
  MAGIC_FIRMWARE,
  REPORT_ID,
  buildBlock,
  buildPacket,
  describePacket,
  isReplyTo,
  parseReply,
} from '../protocol/frame'
import { Notice, Panel } from '../ui/Panel'
import { link, useConnection } from '../state/link'

type Mode = 'frame' | 'output' | 'feature-set' | 'feature-get'

interface Shot {
  n: number
  reply: Uint8Array
  ms: number
}

/**
 * Sends one command at a time, with framing handled for you.
 *
 * The repeat control exists to answer one specific question: does a reply carry
 * live sensor data or fixed constants? Repeating the same request and diffing
 * the answers settles it — bytes that move are live.
 */
export function ReportConsole() {
  const { device, connected } = useConnection()
  const specs = link.specs
  const [mode, setMode] = useState<Mode>('frame')
  const [magic, setMagic] = useState(MAGIC.toString(16))
  const [command, setCommand] = useState('a9')
  const [data, setData] = useState('')
  const [block, setBlock] = useState(true)
  const [offset, setOffset] = useState('0')
  const [length, setLength] = useState(String(BLOCK_CHUNK))
  const [wrap, setWrap] = useState(false)
  const [repeat, setRepeat] = useState('1')
  const [intervalMs, setIntervalMs] = useState('200')
  const [reportId, setReportId] = useState(String(REPORT_ID))
  const [payload, setPayload] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('500')
  const [shots, setShots] = useState<Shot[]>([])
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(false)
  const t = useT()

  const candidates = mode === 'feature-set' || mode === 'feature-get' ? specs.feature : specs.output

  const send = async () => {
    setError(null)
    setResult('')
    setShots([])
    setBusy(true)
    cancelled.current = false
    const id = Number(reportId) || 0
    try {
      if (mode === 'feature-get') {
        setResult(hexDump(await link.getFeature(id, 'console')))
        return
      }
      if (mode === 'feature-set') {
        await link.setFeature(parseBytes(payload), id, 'console')
        setResult(t('console.featureSent'))
        return
      }
      if (mode === 'output') {
        const reply = await link.request(parseBytes(payload), {
          reportId: id,
          timeoutMs: Number(timeoutMs) || 500,
          note: 'console',
        })
        setResult(`report ${reply.reportId}\n${hexDump(reply.data)}`)
        return
      }

      // Framed mode.
      const cmd = Number.parseInt(command, 16)
      if (!Number.isFinite(cmd) || cmd < 0 || cmd > 0xff) throw new Error(t('console.badCommand'))
      const body = data.trim() ? parseBytes(data) : undefined
      const m = Number.parseInt(magic, 16) || MAGIC
      const makePacket = () =>
        block
          ? buildBlock(cmd, Number(offset) || 0, body, { magic: m, length: Number(length) || 0 })
          : buildPacket(cmd, { magic: m, data: body })
      const times = Math.max(1, Math.min(200, Number(repeat) || 1))
      const collected: Shot[] = []

      for (let n = 0; n < times && !cancelled.current; n++) {
        if (wrap) {
          await link.request(buildPacket(COMMAND.begin, { magic: m }), {
            reportId: id,
            timeoutMs: Number(timeoutMs) || 500,
            note: 'begin',
            match: (_rid, d) => isReplyTo(COMMAND.begin, d),
          })
        }
        const t0 = performance.now()
        const reply = await link.request(makePacket(), {
          reportId: id,
          timeoutMs: Number(timeoutMs) || 500,
          note: `cmd 0x${cmd.toString(16).padStart(2, '0')}`,
          match: (_rid, d) => isReplyTo(cmd, d),
        })
        collected.push({ n, reply: reply.data, ms: Math.round(performance.now() - t0) })
        setShots(collected.slice())

        if (wrap) {
          await link.request(buildPacket(COMMAND.end, { magic: m }), {
            reportId: id,
            timeoutMs: Number(timeoutMs) || 500,
            note: 'end',
            match: (_rid, d) => isReplyTo(COMMAND.end, d),
          })
        }
        const gap = Number(intervalMs) || 0
        if (n + 1 < times && gap > 0) await new Promise((r) => setTimeout(r, gap))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!device) {
    return (
      <Panel title={t('console.title')}>
        <Notice>{t('console.needDevice')}</Notice>
      </Panel>
    )
  }

  const first = shots[0]?.reply
  const moving = first
    ? shots.slice(1).reduce<Set<number>>((acc, s) => {
        for (const i of diffOffsets(first, s.reply)) acc.add(i)
        return acc
      }, new Set<number>())
    : new Set<number>()

  return (
    <>
      <Panel title={t('console.title')}>
        <div className="row">
          <label className="small dim">
            {t('console.mode')}
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              style={{ display: 'block', marginTop: 4 }}
            >
              <option value="frame">{t('console.mode.frame')}</option>
              <option value="output">{t('console.mode.output')}</option>
              <option value="feature-set">{t('console.mode.featureSet')}</option>
              <option value="feature-get">{t('console.mode.featureGet')}</option>
            </select>
          </label>
          <label className="small dim">
            Report ID
            <input
              type="text"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              style={{ width: 60, display: 'block', marginTop: 4 }}
            />
          </label>
          {candidates.length > 0 && (
            <span className="small dim" style={{ alignSelf: 'end' }}>
              {t('console.declaredIds', {
                ids: candidates.map((c) => `${c.reportId}(${c.byteLength}B)`).join(', '),
              })}
            </span>
          )}
        </div>

        {mode === 'frame' ? (
          <>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="small dim">
                {t('console.magic')}
                <select
                  value={magic}
                  onChange={(e) => setMagic(e.target.value)}
                  style={{ display: 'block', marginTop: 4 }}
                >
                  <option value={MAGIC.toString(16)}>{t('console.magic.config')}</option>
                  <option value={MAGIC_FIRMWARE.toString(16)}>{t('console.magic.firmware')}</option>
                </select>
              </label>
              <label className="small dim">
                {t('console.command')}
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  style={{ width: 70, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim" style={{ flex: '1 1 200px' }}>
                {t('console.data')}
                <input
                  type="text"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                  placeholder={t('console.dataPlaceholder')}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <label className="small dim">
                <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />{' '}
                {t('console.blockMode')}
              </label>
              {block && (
                <>
                  <label className="small dim">
                    {t('console.offset')}
                    <input
                      type="text"
                      value={offset}
                      onChange={(e) => setOffset(e.target.value)}
                      style={{ width: 70, display: 'block', marginTop: 4 }}
                    />
                  </label>
                  <label className="small dim">
                    {t('console.length', { max: BLOCK_CHUNK })}
                    <input
                      type="text"
                      value={length}
                      onChange={(e) => setLength(e.target.value)}
                      style={{ width: 70, display: 'block', marginTop: 4 }}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="small dim">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
                {t('console.wrap')}
              </label>
              <label className="small dim">
                {t('console.repeat')}
                <input
                  type="text"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  style={{ width: 60, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim">
                {t('console.interval')}
                <input
                  type="text"
                  value={intervalMs}
                  onChange={(e) => setIntervalMs(e.target.value)}
                  style={{ width: 70, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim">
                {t('console.timeout')}
                <input
                  type="text"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                  style={{ width: 70, display: 'block', marginTop: 4 }}
                />
              </label>
            </div>
            <div className="small dim mono" style={{ marginTop: 8 }}>
              {(() => {
                try {
                  const cmd = Number.parseInt(command, 16)
                  const body = data.trim() ? parseBytes(data) : undefined
                  const m = Number.parseInt(magic, 16) || MAGIC
                  const p = block
                    ? buildBlock(cmd, Number(offset) || 0, body, { magic: m, length: Number(length) || 0 })
                    : buildPacket(cmd, { magic: m, data: body })
                  return t('console.preview', {
                    bytes: `${toHex(p.slice(0, 12))} …`,
                    described: describePacket(p),
                  })
                } catch (e) {
                  return t('console.previewFailed', {
                    reason: e instanceof Error ? e.message : String(e),
                  })
                }
              })()}
            </div>
          </>
        ) : (
          mode !== 'feature-get' && (
            <textarea
              rows={3}
              style={{ marginTop: 10 }}
              placeholder={t('console.payloadPlaceholder')}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          )
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={send} disabled={!connected || busy}>
            {busy ? t('console.sending') : t('console.send')}
          </button>
          <button
            className="danger"
            onClick={() => {
              cancelled.current = true
            }}
            disabled={!busy}
          >
            {t('console.stop')}
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">{error}</Notice>
          </div>
        )}
        {result && (
          <pre className="dump" style={{ marginTop: 10 }}>
            {result}
          </pre>
        )}
      </Panel>

      {shots.length > 0 && (
        <Panel title={t('console.replies', { count: shots.length })}>
          {(() => {
            const r = parseReply(shots[0]!.reply)
            return (
              <div className="small dim" style={{ marginBottom: 8 }}>
                {r.kind === 'ack' &&
                  t('console.reply.ack', {
                    command: `0x${(r.command ?? 0).toString(16).padStart(2, '0')}`,
                  })}
                {r.kind === 'data' &&
                  t('console.reply.data', {
                    length: r.length ?? 0,
                    bytes: toHex(r.data ?? []),
                  })}
                {r.kind === 'unknown' && t('console.reply.unknown')}
              </div>
            )
          })()}

          {shots.length > 1 && (
            <div className="small" style={{ marginBottom: 8 }}>
              {moving.size === 0 ? (
                <span className="dim">
                  {t('console.constant', { count: shots.length })}
                </span>
              ) : (
                <span style={{ color: 'var(--ok)' }}>
                  {t('console.moving', {
                    offsets: [...moving].sort((a, b) => a - b).join(', '),
                  })}
                </span>
              )}
            </div>
          )}

          <pre className="dump" style={{ maxHeight: 300 }}>
            {shots
              .map((s) => `#${s.n} ${String(s.ms).padStart(3)}ms  ${toHex(s.reply.slice(0, 24))} …`)
              .join('\n')}
          </pre>
          <pre className="dump" style={{ marginTop: 8 }}>
            {hexDump(shots[shots.length - 1]!.reply)}
          </pre>
        </Panel>
      )}
    </>
  )
}
