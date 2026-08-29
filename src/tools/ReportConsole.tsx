import { useRef, useState } from 'react'
import { diffOffsets, hexDump, parseBytes, toHex } from '../hid/hex'
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
        setResult('(feature 리포트 전송됨)')
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
      if (!Number.isFinite(cmd) || cmd < 0 || cmd > 0xff) throw new Error('명령은 00–ff 범위여야 합니다')
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
      <Panel title="리포트 콘솔">
        <Notice>장치를 먼저 연결하세요.</Notice>
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
      <Panel title="리포트 콘솔">
        <div className="row">
          <label className="small dim">
            모드
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              style={{ display: 'block', marginTop: 4 }}
            >
              <option value="frame">Raven61 프레임 (체크섬 자동)</option>
              <option value="output">RAW OUTPUT 전송</option>
              <option value="feature-set">RAW FEATURE 쓰기</option>
              <option value="feature-get">RAW FEATURE 읽기</option>
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
              선언된 ID: {candidates.map((s) => `${s.reportId}(${s.byteLength}B)`).join(', ')}
            </span>
          )}
        </div>

        {mode === 'frame' ? (
          <>
            <div className="row" style={{ marginTop: 10 }}>
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
              <label className="small dim">
                명령
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  style={{ width: 70, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim" style={{ flex: '1 1 200px' }}>
                데이터
                <input
                  type="text"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                  placeholder="비워 두면 전부 0"
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <label className="small dim">
                <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />{' '}
                블록 전송 형식 (길이 + 오프셋 헤더)
              </label>
              {block && (
                <>
                  <label className="small dim">
                    오프셋
                    <input
                      type="text"
                      value={offset}
                      onChange={(e) => setOffset(e.target.value)}
                      style={{ width: 70, display: 'block', marginTop: 4 }}
                    />
                  </label>
                  <label className="small dim">
                    길이 (최대 {BLOCK_CHUNK})
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
                0x01 … 0x02 트랜잭션으로 감싸기
              </label>
              <label className="small dim">
                반복
                <input
                  type="text"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  style={{ width: 60, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim">
                간격(ms)
                <input
                  type="text"
                  value={intervalMs}
                  onChange={(e) => setIntervalMs(e.target.value)}
                  style={{ width: 70, display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="small dim">
                타임아웃(ms)
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
                  return `보낼 패킷: ${toHex(p.slice(0, 12))} …  (${describePacket(p)})`
                } catch (e) {
                  return `패킷을 만들 수 없습니다: ${e instanceof Error ? e.message : String(e)}`
                }
              })()}
            </div>
          </>
        ) : (
          mode !== 'feature-get' && (
            <textarea
              rows={3}
              style={{ marginTop: 10 }}
              placeholder="예: 55 a9 00 00   (체크섬은 직접 맞춰야 합니다)"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          )
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={send} disabled={!connected || busy}>
            {busy ? '전송 중…' : '전송'}
          </button>
          <button
            className="danger"
            onClick={() => {
              cancelled.current = true
            }}
            disabled={!busy}
          >
            중지
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
        <Panel title={`응답 ${shots.length}건`}>
          {(() => {
            const r = parseReply(shots[0]!.reply)
            return (
              <div className="small dim" style={{ marginBottom: 8 }}>
                {r.kind === 'ack' && `ACK — 명령 0x${(r.command ?? 0).toString(16).padStart(2, '0')} 수신 확인만, 데이터 없음`}
                {r.kind === 'data' && `데이터 응답 — 선언 길이 ${r.length}바이트: ${toHex(r.data ?? [])}`}
                {r.kind === 'unknown' && '알 수 없는 응답 형식'}
              </div>
            )
          })()}

          {shots.length > 1 && (
            <div className="small" style={{ marginBottom: 8 }}>
              {moving.size === 0 ? (
                <span className="dim">
                  반복 {shots.length}회 동안 모든 바이트가 동일 — 살아 있는 값이 아니라 상수입니다.
                </span>
              ) : (
                <span style={{ color: 'var(--ok)' }}>
                  변하는 바이트 오프셋: {[...moving].sort((a, b) => a - b).join(', ')} — 실시간 값입니다.
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
