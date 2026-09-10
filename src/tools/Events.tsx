import { useEffect, useMemo, useRef, useState } from 'react'
import { diffOffsets, toHex } from '../hid/hex'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { useLayout } from '../device/active'
import type { KeyEvent as AnalogEvent } from '../protocol/frame'
import { isActiveEvent, parseActiveEvent } from '../protocol/events'
import { identityOf, sensorMap, useSensorMap } from '../state/sensorMap'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, Panel } from '../ui/Panel'
import { analogModeCommands, armActiveStream, commandHex, link, useConnection } from '../state/link'

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
  const { keys } = useLayout()
  const { connected } = useConnection()
  const t = useT()
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
      if (onlyEvents && !isActiveEvent(data)) return
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
      const fn = await armActiveStream()
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
      const ev = parseActiveEvent(e.payload)
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
      <Panel title={t('events.title')}>
        <Notice>
          <span className="small">
            <T k="events.intro" />
          </span>
        </Notice>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => setListening((v) => !v)} disabled={!connected}>
            {listening ? t('events.stop') : t('events.start')}
          </button>
          <button onClick={() => setEvents([])}>{t('events.clear')}</button>
          <label className="small dim">
            <input
              type="checkbox"
              checked={onlyEvents}
              onChange={(e) => setOnlyEvents(e.target.checked)}
            />{' '}
            {t('events.onlyEvents')}
          </label>
          <label className="small dim">
            <input
              type="checkbox"
              checked={arm}
              disabled={!connected}
              onChange={(e) => void setArmed(e.target.checked)}
            />{' '}
            <T
              k="events.armStream"
              params={{
                arm: commandHex(analogModeCommands().arm),
                disarm: commandHex(analogModeCommands().disarm),
              }}
            />
          </label>
          <span className="small dim">{t('events.received', { count: events.length })}</span>
        </div>
        {armError && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                {t('events.armFailed')} <span className="mono">{armError}</span>
              </span>
            </Notice>
          </div>
        )}
        {listening && events.length === 0 && (
          <div className="small dim" style={{ marginTop: 10 }}>
            <T k="events.silent" />
          </div>
        )}
      </Panel>

      {events.length > 0 && (
        <Panel
          title={t('events.reportedKeys', {
            seen: coverage.size,
            total: keys.length,
          })}
        >
          <div className="small dim" style={{ marginBottom: 8 }}>
            {binding === null
              ? t('events.pressHint')
              : t('events.bindHint', { fingerprint: binding })}
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
                  <T k="events.unbound" params={{ count: unbound.length }} />
                </div>
              </Notice>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>{t('events.col.fingerprint')}</th>
                    <th style={{ width: 70 }}>usage</th>
                    <th style={{ width: 90 }}>{t('events.col.sensor')}</th>
                    <th style={{ width: 70 }}>{t('events.col.samples')}</th>
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
                          {binding === event.fingerprint ? t('events.cancel') : t('events.bind')}
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
              <span className="small dim">{t('events.bound', { count: bindings.size })}</span>
              <button onClick={() => navigator.clipboard?.writeText(sensorMap.toSource())}>
                {t('events.copySource')}
              </button>
              <button className="danger" onClick={() => sensorMap.clear()}>
                {t('events.resetBindings')}
              </button>
            </div>
          )}
        </Panel>
      )}

      {latest && (
        <Panel title={t('events.latest')}>
          <div className="small dim" style={{ marginBottom: 8 }}>
            {(() => {
              const ev = parseActiveEvent(latest.payload)
              if (!ev) return t('events.notAnalog')
              const index = sensorMap.resolve(ev)
              const key = index === undefined ? undefined : keys[index]
              return t('events.latestLine', {
                sensor: `0x${ev.sensorId.toString(16).padStart(4, '0')}`,
                usage: `0x${ev.usage.toString(16).padStart(2, '0')}`,
                key: key ? key.label : t('events.unresolved'),
                depth: ev.depthMm.toFixed(2),
                travel: ev.travelMm.toFixed(2),
                direction:
                  ev.direction === 'down' ? t('events.pressing') : t('events.releasing'),
                adc: ev.adc,
                baseline: ev.adcBaseline,
              })
            })()}
          </div>
          {events.length > 1 && (
            <div className="small" style={{ marginBottom: 8 }}>
              {moving.size === 0 ? (
                <span className="dim">{t('events.noMoving', { count: events.length })}</span>
              ) : (
                <span style={{ color: 'var(--ok)' }}>
                  {t('events.movingOffsets', {
                    offsets: [...moving].sort((a, b) => a - b).join(', '),
                  })}
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
