import { useEffect, useMemo, useRef, useState } from 'react'
import { diffOffsets, toHex } from '../hid/hex'
import { RAVEN61_KEYS } from '../keyboard/raven61'
import { isEvent, parseKeyEvent, type KeyEvent as AnalogEvent } from '../protocol/frame'
import { MONITOR, armAnalogStream } from '../protocol/raven61'
import { identityOf, sensorMap, useSensorMap } from '../state/sensorMap'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, Panel } from '../ui/Panel'
import { link, useConnection } from '../state/link'

interface Event {
  n: number
  t: number
  payload: Uint8Array
}

const KEEP = 400

/**
 * Listens for reports the board sends without being asked.
 *
 * The stock driver has a dedicated loop for these (0x42c8a0): it reads with a
 * 10 ms timeout and dispatches on payload[1..3] when payload[0] is 0xA0.
 *
 * Listening alone writes nothing, which is what makes this tab safe to leave
 * running. But the board only streams once it has been armed (protocol §3.2),
 * so arming is offered as an explicit opt-in rather than done silently.
 */
export function Events() {
  const { connected } = useConnection()
  const [events, setEvents] = useState<Event[]>([])
  const [onlyEvents, setOnlyEvents] = useState(true)
  const [listening, setListening] = useState(false)
  const [binding, setBinding] = useState<string | null>(null)
  const [arm, setArm] = useState(false)
  const [armError, setArmError] = useState<string | null>(null)
  const release = useRef<(() => Promise<void>) | null>(null)
  const armSeq = useRef(0)
  const bindings = useSensorMap()
  const seq = useRef(0)
  const t0 = useRef(0)

  useEffect(() => {
    if (!listening) return
    t0.current = performance.now()
    return link.onInput((_reportId, data) => {
      if (onlyEvents && !isEvent(data)) return
      setEvents((prev) => {
        const next = [
          ...prev,
          {
            n: seq.current++,
            t: Math.round(performance.now() - t0.current),
            payload: new Uint8Array(data),
          },
        ]
        return next.length > KEEP ? next.slice(next.length - KEEP) : next
      })
    })
  }, [listening, onlyEvents])

  /**
   * Driven from the checkbox rather than an effect. Under StrictMode the effect
   * version disarmed itself: the first arm resolved after its own cleanup and
   * sent 0xa9, which landed after the second arm. See Sensors.tsx.
   */
  const setArmed = async (on: boolean) => {
    const seq = ++armSeq.current
    setArm(on)
    setArmError(null)
    const previous = release.current
    release.current = null
    await previous?.()
    if (!on || seq !== armSeq.current) return
    try {
      const fn = await armAnalogStream(link)
      if (seq !== armSeq.current) await fn()
      else release.current = fn
    } catch (e) {
      setArmError(e instanceof Error ? e.message : String(e))
      setArm(false)
    }
  }

  // Never leave the board unable to type because a tab went away.
  useEffect(
    () => () => {
      armSeq.current++
      void release.current?.()
      release.current = null
    },
    [],
  )

  /**
   * Which physical keys the board has reported at least once. Pressing every
   * key in turn turns "the grid looks dead" into a definite list of which keys
   * emit analog events and which do not.
   */
  const seen = useMemo(() => {
    const out = new Map<string, { count: number; event: AnalogEvent }>()
    for (const e of events) {
      const ev = parseKeyEvent(e.payload)
      if (!ev) continue
      // Group by identity, not by sensor descriptor: that value is shared
      // between some keys (P and "/"), which would merge them into one entry.
      const id = identityOf(ev)
      const prev = out.get(id)
      out.set(id, { count: (prev?.count ?? 0) + 1, event: ev })
    }
    return out
  }, [events])

  /** Key index -> how many samples arrived for it. */
  const coverage = useMemo(() => {
    const out = new Map<number, number>()
    for (const { count, event } of seen.values()) {
      const index = sensorMap.resolve(event)
      if (index !== undefined) out.set(index, (out.get(index) ?? 0) + count)
    }
    return out
  }, [seen, bindings])

  const unbound = [...seen.values()].filter(
    ({ event }) => sensorMap.resolve(event) === undefined,
  )

  /** Byte positions that ever changed — where the live values are. */
  const moving = useMemo(() => {
    if (events.length < 2) return new Set<number>()
    const base = events[0]!.payload
    const out = new Set<number>()
    for (const e of events.slice(1)) for (const i of diffOffsets(base, e.payload)) out.add(i)
    return out
  }, [events])

  const latest = events[events.length - 1]

  return (
    <>
      <Panel title="이벤트 수신">
        <Notice>
          <span className="small">
            보드가 <b>요청 없이 올려보내는</b> 리포트를 듣습니다. 순정 드라이버는 이걸 전용 루프로
            폴링하며, <span className="mono">0xa0</span> 로 시작하는 리포트를 이벤트로 처리합니다.
            듣기만 할 때는 아무것도 전송하지 않습니다. 다만 보드는 <b>켜 줘야</b> 스트림을 흘리므로
            (명세 §3.2), 아무것도 안 오면 아래 <b>스트림 켜기</b> 를 함께 켜세요. 보고를 켠 직후 테스트
            모드를 빠져나오므로 <b>타이핑은 그대로 동작</b>하고 보정도 일어나지 않습니다.
          </span>
        </Notice>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => setListening((v) => !v)} disabled={!connected}>
            {listening ? '정지' : '수신 시작'}
          </button>
          <button onClick={() => setEvents([])}>비우기</button>
          <label className="small dim">
            <input
              type="checkbox"
              checked={onlyEvents}
              onChange={(e) => setOnlyEvents(e.target.checked)}
            />{' '}
            0xa0 이벤트만
          </label>
          <label className="small dim">
            <input
              type="checkbox"
              checked={arm}
              disabled={!connected}
              onChange={(e) => void setArmed(e.target.checked)}
            />{' '}
            스트림 켜기 (<span className="mono">0x{MONITOR.arm.toString(16)}</span> →{' '}
            <span className="mono">0x{MONITOR.disarm.toString(16)}</span>) — <b>켜는 동안 타이핑 안 됨</b>
          </label>
          <span className="small dim">{events.length}건 수신</span>
        </div>
        {armError && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                스트림을 켜지 못했습니다: <span className="mono">{armError}</span>
              </span>
            </Notice>
          </div>
        )}
        {listening && events.length === 0 && (
          <div className="small dim" style={{ marginTop: 10 }}>
            아직 아무것도 오지 않습니다. 키를 눌러 보고, 그래도 없으면 <b>스트림 켜기</b> 를 켜세요 —
            보드는 켜 주지 않으면 아무것도 올려보내지 않습니다.
          </div>
        )}
      </Panel>

      {events.length > 0 && (
        <Panel title={`보고된 키 ${coverage.size}/${RAVEN61_KEYS.length}`}>
          <div className="small dim" style={{ marginBottom: 8 }}>
            {binding === null
              ? '키를 하나씩 눌러 보세요. 회색으로 남는 키는 아직 센서 주소가 연결되지 않은 키입니다.'
              : `연결할 키를 그리드에서 고르세요 (${binding}).`}
          </div>
          <KeyGrid
            fill={(k) => (coverage.has(k.index) ? 1 : 0)}
            sub={(k) => (coverage.has(k.index) ? String(coverage.get(k.index)) : undefined)}
            onSelect={(index) => {
              if (binding === null) return
              sensorMap.bind(binding, index)
              setBinding(null)
            }}
          />

          {unbound.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Notice kind="warn">
                <div className="small">
                  <b>이름을 밝히지 않는 키 {unbound.length}개.</b> 수정자 키와 Fn 은 HID 에서
                  비트마스크로 보고되어 usage 가 없습니다 (0x00 / Fn 은 0x01). 아래에서 하나를 고른 뒤
                  위 그리드에서 해당 키를 클릭하면 연결됩니다. 식별자는 센서값과 기준 ADC 의 조합입니다 —
                  센서값만으로는 일부 키가 겹칩니다.
                </div>
              </Notice>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>식별자</th>
                    <th style={{ width: 70 }}>usage</th>
                    <th style={{ width: 90 }}>센서값</th>
                    <th style={{ width: 70 }}>샘플</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {unbound.map(({ count, event }) => (
                    <tr key={event.fingerprint}>
                      <td className="mono">{event.fingerprint}</td>
                      <td className="mono dim">0x{event.usage.toString(16).padStart(2, '0')}</td>
                      <td className="mono dim">0x{event.sensorId.toString(16).padStart(4, '0')}</td>
                      <td className="dim">{count}</td>
                      <td>
                        <button
                          className={binding === event.fingerprint ? 'primary' : ''}
                          onClick={() =>
                            setBinding(binding === event.fingerprint ? null : event.fingerprint)
                          }
                        >
                          {binding === event.fingerprint ? '취소' : '이 키 연결'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bindings.size > 0 && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small dim">{bindings.size}개 키 연결됨 (브라우저에 저장)</span>
              <button onClick={() => navigator.clipboard?.writeText(sensorMap.toSource())}>
                소스로 복사
              </button>
              <button className="danger" onClick={() => sensorMap.clear()}>
                연결 초기화
              </button>
            </div>
          )}
        </Panel>
      )}

      {latest && (
        <Panel title="최근 이벤트">
          <div className="small dim" style={{ marginBottom: 8 }}>
            {(() => {
              const ev = parseKeyEvent(latest.payload)
              if (!ev) return '아날로그 키 이벤트 형식이 아닙니다'
              const index = sensorMap.resolve(ev)
              const key = index === undefined ? undefined : RAVEN61_KEYS[index]
              return (
                `센서 0x${ev.sensorId.toString(16).padStart(4, '0')}` +
                ` · usage 0x${ev.usage.toString(16).padStart(2, '0')}` +
                `${key ? ` (${key.label})` : ' (미연결)'}` +
                ` · 깊이 ${ev.depthMm.toFixed(2)}/${ev.travelMm.toFixed(2)}mm` +
                ` · ${ev.direction === 'down' ? '누르는 중' : '떼는 중'}` +
                ` · ADC ${ev.adc}/${ev.adcBaseline}`
              )
            })()}
          </div>
          {events.length > 1 && (
            <div className="small" style={{ marginBottom: 8 }}>
              {moving.size === 0 ? (
                <span className="dim">{events.length}건 모두 동일 — 변하는 바이트가 없습니다.</span>
              ) : (
                <span style={{ color: 'var(--ok)' }}>
                  변하는 오프셋: {[...moving].sort((a, b) => a - b).join(', ')}
                </span>
              )}
            </div>
          )}
          <div className="log" style={{ height: 300 }}>
            {events
              .slice(-80)
              .reverse()
              .map((e) => (
                <div key={e.n} className="line in" style={{ gridTemplateColumns: '60px 46px 1fr' }}>
                  <span>{e.t}ms</span>
                  <span>#{e.n}</span>
                  <span>{toHex(e.payload.slice(0, 24))} …</span>
                </div>
              ))}
          </div>
        </Panel>
      )}
    </>
  )
}
