import { useRef, useState } from 'react'
import { parseBytes, toHex } from '../hid/hex'
import { TimeoutError } from '../hid/link'
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

  const payloadFor = (value: number): Uint8Array => {
    if (mode === 'frame') return buildPacket(value, { magic: Number.parseInt(magic, 16) || MAGIC })
    if (!template.includes(SWEEP_MARK)) throw new Error(`템플릿에 ${SWEEP_MARK} 자리표시자가 없습니다`)
    return parseBytes(template.replaceAll(SWEEP_MARK, value.toString(16).padStart(2, '0')))
  }

  const start = async () => {
    setError(null)
    setRows([])
    cancelled.current = false
    const lo = parseInt(from, 16)
    const hi = parseInt(to, 16)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi > 0xff) {
      setError('스윕 범위가 올바르지 않습니다 (00–ff).')
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
    <Panel title="명령 프로버">
      <Notice kind="warn">
        <strong>주의 — 미지의 명령을 보내는 작업입니다.</strong>
        <div className="small" style={{ marginTop: 4 }}>
          <span className="mono">0x01</span>(시작) 과 <span className="mono">0x02</span>(종료·적용)는 설정
          트랜잭션을 여닫는 명령으로 보입니다. 그 사이의 명령이 무엇을 쓰는지는 아직 모르므로 설정 초기화나
          플래시 쓰기가 일어날 수 있습니다. 이 보드는 펌웨어 업그레이드 후 <b>키 캘리브레이션이 필요</b>하다고
          순정 드라이버가 안내합니다 — 캘리브레이션을 건드리는 명령도 존재한다는 뜻입니다. 먼저 순정
          드라이버로 설정을 백업하세요.
        </div>
      </Notice>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="small dim">
          모드
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            style={{ display: 'block', marginTop: 4 }}
          >
            <option value="frame">Raven61 프레임 (체크섬 자동)</option>
            <option value="output">RAW OUTPUT → IN</option>
            <option value="feature">RAW FEATURE (set → get)</option>
          </select>
        </label>

        {mode === 'frame' ? (
          <label className="small dim">
            매직
            <select
              value={magic}
              onChange={(e) => setMagic(e.target.value)}
              style={{ display: 'block', marginTop: 4 }}
            >
              <option value={MAGIC.toString(16)}>0x55 (설정)</option>
              <option value={MAGIC_FIRMWARE.toString(16)}>0x5f (펌웨어)</option>
            </select>
          </label>
        ) : (
          <label className="small dim" style={{ flex: '1 1 280px' }}>
            템플릿 (<span className="mono">{SWEEP_MARK}</span> 위치를 스윕)
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
          시작
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: 56, display: 'block', marginTop: 4 }}
          />
        </label>
        <label className="small dim">
          끝
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ width: 56, display: 'block', marginTop: 4 }}
          />
        </label>
        {mode !== 'feature' && (
          <label className="small dim">
            타임아웃(ms)
            <input
              type="text"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              style={{ width: 70, display: 'block', marginTop: 4 }}
            />
          </label>
        )}
        <label className="small dim">
          간격(ms)
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
          순정 드라이버가 실제로 보내는 {KNOWN_COMMANDS.length}개 명령만 시도 (권장)
        </label>
      )}
      {mode === 'frame' && (
        <label className="small dim" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={skipRisky} onChange={(e) => setSkipRisky(e.target.checked)} />{' '}
          안전이 확인된 명령만 보내기 ({[...SAFE].map((c) => `0x${c.toString(16).padStart(2, '0')}`).join(', ')}).
          나머지는 블록 쓰기라서 빈 페이로드로 보내면 펌웨어 블롭의 앞부분에 0이 쓰일 수 있습니다.
        </label>
      )}
      {mode !== 'feature' && (
        <label className="small dim" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
          각 명령을 0x01 … 0x02 트랜잭션으로 감싸기 (순정 드라이버와 동일한 순서)
        </label>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <label className="small">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />{' '}
          위험을 이해했고 설정을 백업했습니다
        </label>
        <button className="primary" onClick={start} disabled={!connected || running || !acknowledged}>
          스윕 시작
        </button>
        <button
          className="danger"
          onClick={() => {
            cancelled.current = true
          }}
          disabled={!running}
        >
          중지
        </button>
        <span className="dim small">
          {rows.length}회 시도 · 응답 {answered.length}건 · ACK {acked.length}건
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
                <th style={{ width: 70 }}>명령</th>
                <th style={{ width: 70 }}>응답</th>
                <th style={{ width: 55 }}>ms</th>
                <th>응답</th>
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
                      {r.data ? '데이터' : r.ack ? 'ACK' : '—'}
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
              응답이 없습니다. 순정 드라이버가 실행 중이면 장치를 독점하고 있을 수 있으니 종료하고 다시
              시도하세요. 그래도 없으면 Report ID 나 모드를 바꿔 보세요.
            </div>
          )}
          <div className="small dim" style={{ marginTop: 6 }}>
            ★ = 순정 드라이버가 실제로 보내는 명령 (0x01 시작, 0x02 종료·적용, 0x
            {COMMAND.globalSettings.toString(16)} 전역 설정) · ⚠ = 빈 페이로드로 보냈을 때 보드 상태가
            바뀐 것이 확인된 명령
          </div>
        </div>
      )}
    </Panel>
  )
}
