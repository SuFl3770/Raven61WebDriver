import { useEffect, useRef, useState, type RefObject } from 'react'
import { BASELINE_TOLERANCE, KEY_FINGERPRINTS, type KeyFingerprint } from '../keyboard/fingerprints'
import { DEFAULT_TRAVEL_MM, RAVEN61_KEYS, keyByIndex } from '../keyboard/raven61'
import { t as translate, useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { EVENT_TYPE, isEvent, parseKeyEvent } from '../protocol/frame'
import { MONITOR, armAnalogStream } from '../protocol/raven61'
import { sensorMap, useSensorMap } from '../state/sensorMap'
import { selection, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { Marquee } from '../ui/Marquee'
import { Notice, Panel } from '../ui/Panel'
import { SelectionBar } from '../ui/SelectionBar'
import { link, useConnection } from '../state/link'

/**
 * Live key travel and every raw sensor number behind it.
 *
 * This was two tabs — a monitor showing depth, and a sensor view showing the
 * numbers depth is derived from. They listened to the same stream and each had
 * its own start button, so running one told you nothing about the other.
 *
 * This exists because the analog test mode recalibrates baselines: after a
 * calibration pass the resting ADC of a key can differ from the one recorded in
 * `fingerprints.ts`, and then a modifier either fails to resolve or — worse —
 * resolves to the wrong key. The identity in use is `sensorId` + resting ADC,
 * so drift in the second half silently rewrites who a key is.
 *
 * One row per identity the board reported: the HID usage when the key names
 * itself, the full `sensorId:baseline` fingerprint otherwise. Grouping the
 * unnamed ones by sensor value alone would merge LCtrl and LShift, which share
 * 0x0805 — the two keys this is meant to tell apart.
 *
 * Drift then shows up two ways, and both are surfaced: a named key reports a
 * new baseline under the same usage, and an unnamed key appears as an extra row
 * under a sensor value that should only have as many rows as it has keys.
 */
interface Observation {
  id: string
  usage: number
  usageIsReal: boolean
  sensorId: number
  /** Distinct resting baselines seen under this identity, with hit counts. */
  baselines: Map<number, number>
  lastBaseline: number
  adcLast: number
  adcMin: number
  adcMax: number
  deltaLast: number
  /** Live travel, and the extremes seen — the monitor's grid and stats. */
  depthMm: number
  depthMinMm: number
  depthMaxMm: number
  count: number
  lastAt: number
  /** `payload[1]` and `payload[2]` — the fields that identify a modifier. */
  type: number
  modifierBits: number
  /** False while the board reports no total stroke, i.e. before calibration. */
  calibrated: boolean
  /** False for reports that cannot name a key at all — kept, but labelled. */
  identifiable: boolean
  /** Distinct values seen at each payload offset, for the address hunt. */
  bytes: Set<number>[]
}

/** Table refresh. The live grid and trace run at display rate instead. */
const TABLE_MS = 250
/** Samples kept in the focused key's trace. */
const HISTORY = 300

const hex4 = (n: number) => `0x${n.toString(16).padStart(4, '0')}`

const isSingleBit = (n: number) => n !== 0 && (n & (n - 1)) === 0

function identityKey(usageIsReal: boolean, usage: number, sensorId: number, baseline: number): string {
  return usageIsReal ? `usage:${usage}` : `fp:${hex4(sensorId)}:${baseline}`
}

/**
 * `analysis` adds the reverse-engineering panels below the live view. The
 * sensors tab leaves them off; the debug tab turns them on, and gets the same
 * live monitor at the top so the stream stays visible while probing.
 */
export function Sensors({ analysis = false }: { analysis?: boolean }) {
  const { connected } = useConnection()
  const sel = useSelection()
  const [listening, setListening] = useState(false)
  const [arm, setArm] = useState(false)
  const [listenOnly, setListenOnly] = useState(false)
  const [armError, setArmError] = useState<string | null>(null)
  const [, forceRender] = useState(0)
  const t = useT()
  const obs = useRef<Map<string, Observation>>(new Map())
  const undecoded = useRef(0)
  const t0 = useRef(0)
  const release = useRef<(() => Promise<void>) | null>(null)
  const armSeq = useRef(0)
  // Subscribes to the binding store, so toggling the built-in table or binding
  // a key in the events tab re-resolves these rows immediately.
  useSensorMap()

  useEffect(() => {
    if (!listening) return
    t0.current = performance.now()
    return link.onInput((_reportId, data) => {
      const e = parseKeyEvent(data)
      if (!e) {
        // An 0xA0 report that will not decode is worth counting rather than
        // dropping: it is the difference between "no stream" and "a stream we
        // do not understand", and those need opposite fixes.
        if (isEvent(data)) undecoded.current++
        return
      }
      const id = identityKey(e.usageIsReal, e.usage, e.sensorId, e.adcBaseline)
      let row = obs.current.get(id)
      if (!row) {
        row = {
          id,
          usage: e.usage,
          usageIsReal: e.usageIsReal,
          sensorId: e.sensorId,
          baselines: new Map(),
          lastBaseline: e.adcBaseline,
          adcLast: e.adc,
          adcMin: e.adc,
          adcMax: e.adc,
          deltaLast: e.travelRaw,
          depthMm: e.depthMm,
          depthMinMm: e.depthMm,
          depthMaxMm: e.depthMm,
          count: 0,
          lastAt: 0,
          type: e.type,
          modifierBits: e.modifierBits,
          calibrated: e.calibrated,
          identifiable: e.identifiable,
          bytes: Array.from({ length: data.length }, () => new Set<number>()),
        }
        obs.current.set(id, row)
      }
      row.type = e.type
      row.modifierBits = e.modifierBits
      row.calibrated = e.calibrated
      row.identifiable = e.identifiable
      for (let i = 0; i < data.length && i < row.bytes.length; i++) row.bytes[i]!.add(data[i]!)
      row.baselines.set(e.adcBaseline, (row.baselines.get(e.adcBaseline) ?? 0) + 1)
      row.lastBaseline = e.adcBaseline
      row.adcLast = e.adc
      row.adcMin = Math.min(row.adcMin, e.adc)
      row.adcMax = Math.max(row.adcMax, e.adc)
      row.deltaLast = e.travelRaw
      row.depthMm = e.depthMm
      row.depthMinMm = Math.min(row.depthMinMm, e.depthMm)
      row.depthMaxMm = Math.max(row.depthMaxMm, e.depthMm)
      row.count++
      row.lastAt = Math.round(performance.now() - t0.current)
    })
  }, [listening])

  /**
   * Arming is driven from the checkbox, not from an effect.
   *
   * In an effect it fought itself: StrictMode mounts, unmounts and remounts, so
   * the first `armAnalogStream` resolved *after* its own cleanup had run and
   * sent the disarm — which landed after the second arm and left the board out
   * of analog mode. The monitor tab was unaffected because it arms from a click
   * handler, which is why only this tab looked dead.
   *
   * The sequence number covers the same race for fast toggling.
   */
  const toggle = async () => {
    const seq = ++armSeq.current
    const previous = release.current
    release.current = null
    await previous?.()
    if (listening) {
      setListening(false)
      setArm(false)
      return
    }
    setArmError(null)
    setListening(true)
    if (listenOnly) return
    try {
      const fn = await armAnalogStream(link)
      if (seq !== armSeq.current) await fn()
      else {
        release.current = fn
        setArm(true)
      }
    } catch (e) {
      setArmError(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = () => {
    obs.current = new Map()
    undecoded.current = 0
    forceRender((n) => n + 1)
  }

  // Leaving the tab must hand typing back, whatever the reason for leaving.
  useEffect(
    () => () => {
      armSeq.current++
      void release.current?.()
      release.current = null
    },
    [],
  )

  useEffect(() => {
    if (!listening) return
    const timer = setInterval(() => forceRender((n) => n + 1), TABLE_MS)
    return () => clearInterval(timer)
  }, [listening])


  const rows = [...obs.current.values()]
  const resolved = new Map<number, Observation>()
  // The trace runs on rAF, outside React's render, so it reads the resolution
  // through a ref rather than closing over a map that is rebuilt every render.
  const current = useRef<Map<number, Observation>>(new Map())
  for (const r of rows) {
    const index = sensorMap.resolve({
      usage: r.usage,
      usageIsReal: r.usageIsReal,
      fingerprint: `${r.sensorId.toString(16).padStart(4, '0')}:${r.lastBaseline}`,
      sensorId: r.sensorId,
      adcBaseline: r.lastBaseline,
    })
    if (index !== undefined && !resolved.has(index)) resolved.set(index, r)
  }
  current.current = resolved

  // How many distinct baselines each sensor value has shown. A sensor value
  // shared by two keys legitimately shows two; more than that is drift.
  const siblings = new Map<number, Set<number>>()
  for (const r of rows) {
    if (r.usageIsReal || !r.identifiable) continue
    const set = siblings.get(r.sensorId) ?? new Set<number>()
    for (const b of r.baselines.keys()) set.add(b)
    siblings.set(r.sensorId, set)
  }
  const keysPerSensor = new Map<number, number>()
  for (const f of KEY_FINGERPRINTS) {
    keysPerSensor.set(f.sensorId, (keysPerSensor.get(f.sensorId) ?? 0) + 1)
  }

  const candidates = addressCandidates(rows)
  const drift = driftReport(rows)
  const bound = [...resolved.values()]
  const unresolved = rows.filter((r) => r.identifiable && !bound.includes(r))
  // Reports that name no key by any route. The board emits these steadily on a
  // perfectly working keyboard, so they are shown but never flagged.
  const nonKey = rows.filter((r) => !r.identifiable)
  // Keys that would need the fingerprint table. Reports that name no key at all
  // must not count: `0601:0` arrives steadily on a healthy board, its sensor
  // value is in no table, and letting it in here raised the stale-table alarm
  // permanently on a keyboard where every key resolved correctly.
  const unnamedRows = rows
    .filter((r) => !r.usageIsReal && r.identifiable)
    .sort((a, b) => a.sensorId - b.sensorId)
  const addresses = candidates.filter((c) => c.perfect).slice(0, 4)

  const sensorSummary = summariseSensors(rows, resolved)

  const focus = [...sel][0] ?? 0
  const focusKey = keyByIndex(focus)
  // Either signal means the table no longer describes this board: a sensor
  // value it has never heard of, or more baselines under one value than that
  // value has keys.
  const staleTable =
    unnamedRows.some((r) => !keysPerSensor.has(r.sensorId)) ||
    excessSensors(siblings, keysPerSensor)

  return (
    <>
      {/*
        The grid at the top with its controls beside it, the way the
        input-point tab is laid out — see features/KeyMetrics.tsx.
        It used to sit at the bottom of a panel, under a row of buttons and
        four possible warnings, so the live display of the thing you are
        pressing moved down the page as the board had more to say about it.
      */}
      <Marquee className="gridband">
        <div className="gridrow">
          <LiveGrid current={current} selected={sel} running={listening} />

          {/*
            `selectable={false}` on purpose: the column is the capture's, not
            the selection's. Selecting here picks the key the trace follows,
            and "select all" would mean nothing to a graph of one key.
          */}
          <SelectionBar selectable={false}>
            <div className="group">
              <button className="primary" onClick={() => void toggle()} disabled={!connected}>
                {listening ? t('sensors.stop') : t('sensors.start')}
              </button>
              <button onClick={clear}>{t('sensors.clear')}</button>
            </div>

            <hr className="sep" />

            <label className="small dim">
              <input
                type="checkbox"
                checked={listenOnly}
                disabled={listening}
                onChange={(e) => setListenOnly(e.target.checked)}
              />{' '}
              <T k="sensors.listenOnly" params={{ arm: `0x${MONITOR.arm.toString(16)}` }} />
            </label>

            <div className="small dim">
              {t('sensors.focus', { index: focus, key: focusKey?.label ?? '' })}
              <div style={{ marginTop: 4 }}>
                {t('sensors.keyCount', { seen: resolved.size, total: RAVEN61_KEYS.length })}
              </div>
              {analysis && (
                <div style={{ marginTop: 4 }}>
                  {t('sensors.identities', { count: rows.length })}
                </div>
              )}
              {analysis && undecoded.current > 0 && (
                <div style={{ marginTop: 4, color: 'var(--warn)' }}>
                  {t('sensors.undecoded', { count: undecoded.current })}
                </div>
              )}
            </div>
          </SelectionBar>
        </div>
      </Marquee>

      <Panel title={t('sensors.title')}>
        <Notice>
          <span className="small">
            <T k="sensors.intro" />
          </span>
        </Notice>
        <div className="small dim" style={{ marginTop: 10 }}>
          <T k="sensors.gridLegend" />
        </div>
        {rows.some((r) => r.identifiable && !r.calibrated) && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              <span className="small">
                <T k="sensors.uncalibrated" params={{ nominal: DEFAULT_TRAVEL_MM.toFixed(2) }} />
              </span>
            </Notice>
          </div>
        )}
        {staleTable && !sensorMap.builtInIgnored && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                <T k="sensors.staleTable" />
              </span>
            </Notice>
          </div>
        )}
        {armError && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                {t('sensors.armFailed')} <span className="mono">{armError}</span>
                <div style={{ marginTop: 4 }}>
                  <T k="sensors.armFailedHint" />
                </div>
              </span>
            </Notice>
          </div>
        )}
        {arm && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              <span className="small">
                <T
                  k="sensors.armed"
                  params={{
                    arm: `0x${MONITOR.arm.toString(16)}`,
                    disarm: `0x${MONITOR.disarm.toString(16)}`,
                  }}
                />
              </span>
            </Notice>
          </div>
        )}
      </Panel>

      <LiveTrace current={current} focus={focus} label={focusKey?.label ?? ''} running={listening} />

      {analysis && sensorSummary.length > 0 && (
        <Panel title={t('sensors.sensorTable.title')}>
          <div className="small dim" style={{ marginBottom: 8 }}>
            <T k="sensors.sensorTable.intro" />
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t('sensors.sensorTable.col.sensor')}</th>
                <th style={{ width: 140 }}>{t('sensors.sensorTable.col.baselines')}</th>
                <th>{t('sensors.sensorTable.col.keys')}</th>
                <th style={{ width: 110 }}>{t('sensors.sensorTable.col.path')}</th>
                <th>{t('sensors.sensorTable.col.table')}</th>
                <th style={{ width: 150 }}>{t('sensors.sensorTable.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {sensorSummary.map((v) => (
                <tr key={v.sensorId}>
                  <td className="mono">{hex4(v.sensorId)}</td>
                  <td className="mono">{v.baselines.join(', ')}</td>
                  <td className="small">{v.keys.join(', ') || '—'}</td>
                  <td className="small dim">
                    {v.paths.map((k) => t(`sensors.sensorTable.path.${k}`)).join(', ')}
                  </td>
                  <td className="small dim mono">
                    {v.table.length > 0
                      ? v.table.map((f) => `${f.label} ${f.adcBaseline}`).join(', ')
                      : t('sensors.sensorTable.notInTable')}
                  </td>
                  <td
                    className="small"
                    style={{ color: v.status === 'warn' ? 'var(--err)' : 'var(--fg-dim)' }}
                  >
                    {t(`sensors.sensorTable.status.${v.status}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {analysis && rows.length > 0 && (
        <Panel title={t('sensors.identitiesTitle', { count: rows.length })}>
          <table>
            <thead>
              <tr>
                <th>{t('sensors.col.key')}</th>
                <th style={{ width: 70 }}>usage</th>
                <th style={{ width: 110 }}>{t('sensors.col.modifierBits')}</th>
                <th style={{ width: 80 }}>{t('sensors.col.sensor')}</th>
                <th style={{ width: 110 }}>{t('sensors.col.baseline')}</th>
                <th style={{ width: 80 }}>{t('sensors.col.adc')}</th>
                <th style={{ width: 110 }}>{t('sensors.col.adcRange')}</th>
                <th style={{ width: 70 }}>{t('sensors.col.delta')}</th>
                <th style={{ width: 80 }}>{t('sensors.col.maxDepth')}</th>
                <th style={{ width: 70 }}>{t('sensors.col.samples')}</th>
                <th style={{ width: 90 }}>{t('sensors.col.siblings')}</th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => sortIndex(a, resolved) - sortIndex(b, resolved))
                .map((r) => {
                  const index = [...resolved.entries()].find(([, v]) => v === r)?.[0]
                  const key = index === undefined ? undefined : keyByIndex(index)
                  const many = r.baselines.size > 1
                  return (
                    <tr key={r.id}>
                      <td>
                        {key ? (
                          <>
                            <span className="mono">#{index}</span> {key.label}
                          </>
                        ) : r.identifiable ? (
                          <span style={{ color: 'var(--warn)' }}>{t('sensors.unresolved')}</span>
                        ) : (
                          <span className="dim">{t('sensors.notAKey')}</span>
                        )}
                      </td>
                      <td className="mono">{r.usageIsReal ? hex4(r.usage) : '—'}</td>
                      <td className="mono dim">
                        {r.modifierBits === 0
                          ? '—'
                          : `0x${r.modifierBits.toString(16).padStart(2, '0')}${
                              isSingleBit(r.modifierBits) ? ` (bit ${Math.log2(r.modifierBits)})` : ''
                            }`}
                      </td>
                      <td className="mono">{hex4(r.sensorId)}</td>
                      <td className="mono" style={many ? { color: 'var(--warn)' } : undefined}>
                        {[...r.baselines.keys()].sort((a, b) => a - b).join(', ')}
                      </td>
                      <td className="mono">{r.adcLast}</td>
                      <td className="mono dim">
                        {r.adcMin}–{r.adcMax}
                      </td>
                      <td className="mono dim">{r.deltaLast}</td>
                      <td className="mono dim">{r.depthMaxMm.toFixed(2)}</td>
                      <td className="mono dim">{r.count}</td>
                      <td className="mono dim">{siblingNote(r, siblings, keysPerSensor)}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
          {(rows.some((r) => r.baselines.size > 1) || excessSensors(siblings, keysPerSensor)) && (
            <div style={{ marginTop: 10 }}>
              <Notice kind="warn">
                <span className="small">
                  <T k="sensors.drifted" />
                </span>
              </Notice>
            </div>
          )}
          {unresolved.length > 0 && (
            <div style={{ marginTop: 10 }} className="small dim">
              <T k="sensors.unresolvedHint" params={{ count: unresolved.length }} />
            </div>
          )}
          {nonKey.length > 0 && (
            <div style={{ marginTop: 6 }} className="small dim">
              <T
                k="sensors.notAKeyHint"
                params={{
                  count: nonKey.length,
                  ids: nonKey.map((r) => `${hex4(r.sensorId)}:${r.lastBaseline}`).join(', '),
                }}
              />
            </div>
          )}
        </Panel>
      )}

      {analysis && candidates.length > 0 && (
        <Panel title={t('sensors.address.title')}>
          <div className="small dim" style={{ marginBottom: 8 }}>
            <T k="sensors.address.intro" params={{ groups: candidates[0]!.groups }} />
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>{t('sensors.address.col.offset')}</th>
                <th style={{ width: 100 }}>{t('sensors.address.col.constant')}</th>
                <th style={{ width: 110 }}>{t('sensors.address.col.distinct')}</th>
                <th style={{ width: 90 }}>{t('sensors.address.col.verdict')}</th>
                <th>{t('sensors.address.col.known')}</th>
              </tr>
            </thead>
            <tbody>
              {candidates.slice(0, 12).map((c) => (
                <tr key={c.offset}>
                  <td className="mono">payload[{c.offset}]</td>
                  <td className="mono">
                    {c.constantGroups}/{c.groups}
                  </td>
                  <td className="mono">
                    {c.distinct}/{c.groups}
                  </td>
                  <td className="small" style={{ color: c.perfect ? 'var(--ok)' : 'var(--fg-dim)' }}>
                    {c.perfect
                      ? t('sensors.address.candidate')
                      : c.constantGroups < c.groups
                        ? t('sensors.address.varies')
                        : t('sensors.address.duplicate')}
                  </td>
                  <td className="small dim">
                    {EVENT_FIELDS[c.offset] ? t(EVENT_FIELDS[c.offset]!) : t('sensors.field.unknown')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            {addresses.some((c) => !EVENT_FIELDS[c.offset]) ? (
              <Notice kind="info">
                <span className="small">
                  <T k="sensors.address.found" />
                </span>
              </Notice>
            ) : (
              <Notice kind="warn">
                <span className="small">
                  <T k="sensors.address.none" />
                </span>
              </Notice>
            )}
          </div>
          {unnamedRows.length > 0 && addresses.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="small dim" style={{ marginBottom: 6 }}>
                {t('sensors.address.unnamedCheck')}
              </div>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 200 }}>{t('sensors.col.fingerprint')}</th>
                    {addresses.map((c) => (
                      <th key={c.offset} className="mono" style={{ width: 110 }}>
                        [{c.offset}]
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unnamedRows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono small">
                        {hex4(r.sensorId)}:{r.lastBaseline}
                      </td>
                      {addresses.map((c) => (
                        <td key={c.offset} className="mono">
                          {[...(r.bytes[c.offset] ?? [])].join(', ')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {analysis && drift.length > 0 && (
        <Panel title={t('sensors.drift.title')}>
          <div className="small dim" style={{ marginBottom: 8 }}>
            <T k="sensors.drift.intro" params={{ tolerance: BASELINE_TOLERANCE }} />
          </div>
          <table>
            <thead>
              <tr>
                <th>{t('sensors.col.key')}</th>
                <th style={{ width: 80 }}>{t('sensors.col.sensor')}</th>
                <th style={{ width: 90 }}>{t('sensors.drift.col.expected')}</th>
                <th style={{ width: 90 }}>{t('sensors.drift.col.observed')}</th>
                <th style={{ width: 70 }}>{t('sensors.drift.col.delta')}</th>
                <th>{t('sensors.drift.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {drift.map((d) => (
                <tr key={`${d.sensorId}-${d.keyIndex}`}>
                  <td>
                    <span className="mono">#{d.keyIndex}</span> {d.label}
                  </td>
                  <td className="mono">{hex4(d.sensorId)}</td>
                  <td className="mono">{d.expected}</td>
                  <td className="mono">{d.observed ?? '—'}</td>
                  <td
                    className="mono"
                    style={d.delta !== null && Math.abs(d.delta) > BASELINE_TOLERANCE
                      ? { color: 'var(--err)' }
                      : undefined}
                  >
                    {d.delta === null ? '—' : d.delta > 0 ? `+${d.delta}` : d.delta}
                  </td>
                  <td className="small dim">{t(d.noteKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void navigator.clipboard?.writeText(toFingerprintSource(drift))}>
              {t('sensors.drift.copySource')}
            </button>
            <span className="small dim">
              <T k="sensors.drift.copyHint" />
            </span>
          </div>
          {drift.some((d) => d.ambiguous) && (
            <div style={{ marginTop: 10 }}>
              <Notice kind="err">
                <span className="small">
                  <T k="sensors.drift.ambiguous" />
                </span>
              </Notice>
            </div>
          )}
        </Panel>
      )}
    </>
  )
}

/**
 * "2/2" — this sensor value has shown two baselines and the layout says two
 * keys share it, so nothing has drifted. "3/2" means an extra identity appeared.
 */
function siblingNote(
  r: Observation,
  siblings: ReadonlyMap<number, Set<number>>,
  keysPerSensor: ReadonlyMap<number, number>,
): string {
  if (r.usageIsReal) return '—'
  const seen = siblings.get(r.sensorId)?.size ?? 0
  const expected = keysPerSensor.get(r.sensorId) ?? 0
  return expected === 0 ? String(seen) : `${seen}/${expected}`
}

interface SensorSummary {
  sensorId: number
  baselines: number[]
  keys: string[]
  paths: IdPath[]
  table: KeyFingerprint[]
  status: 'ok' | 'harmless' | 'warn' | 'nonKey'
}

type IdPath = 'usage' | 'modifier' | 'fingerprint' | 'none'

/** Which of the three routes actually named this key. */
function idPath(r: Observation): IdPath {
  if (!r.identifiable) return 'none'
  if (r.type === EVENT_TYPE.fn) return 'modifier'
  if (isSingleBit(r.modifierBits) && r.usage >= 0xe0 && r.usage <= 0xe7) return 'modifier'
  if (r.usageIsReal) return 'usage'
  return 'fingerprint'
}

/**
 * Groups the observations by sensor value and says, for each, whether the
 * built-in table matters.
 *
 * The point is to separate "this sensor value is not in the table" from "this
 * is a problem". They are not the same: a key that names itself by usage or by
 * modifier bit is identified before the table is ever consulted, so a missing
 * value is only a fault when some key actually needs the fallback.
 */
function summariseSensors(
  rows: readonly Observation[],
  resolved: ReadonlyMap<number, Observation>,
): SensorSummary[] {
  const labelOf = new Map<Observation, string>()
  for (const [index, r] of resolved) labelOf.set(r, `#${index} ${keyByIndex(index)?.label ?? '?'}`)

  const grouped = new Map<number, Observation[]>()
  for (const r of rows) grouped.set(r.sensorId, [...(grouped.get(r.sensorId) ?? []), r])

  const out: SensorSummary[] = []
  for (const [sensorId, group] of grouped) {
    const paths = [...new Set(group.map(idPath))]
    const table = KEY_FINGERPRINTS.filter((f) => f.sensorId === sensorId)
    const status: SensorSummary['status'] =
      table.length > 0
        ? 'ok'
        : paths.every((p) => p === 'none')
          ? 'nonKey'
          : paths.includes('fingerprint')
            ? 'warn'
            : 'harmless'
    out.push({
      sensorId,
      baselines: [...new Set(group.flatMap((r) => [...r.baselines.keys()]))].sort((a, b) => a - b),
      keys: [...new Set(group.map((r) => labelOf.get(r)).filter((v): v is string => !!v))],
      paths,
      table,
      status,
    })
  }
  return out.sort((a, b) => a.sensorId - b.sensorId)
}

function excessSensors(
  siblings: ReadonlyMap<number, Set<number>>,
  keysPerSensor: ReadonlyMap<number, number>,
): boolean {
  for (const [sensorId, set] of siblings) {
    const expected = keysPerSensor.get(sensorId)
    if (expected !== undefined && set.size > expected) return true
  }
  return false
}

/** Keys sort by layout position; identities with no key fall to the bottom. */
function sortIndex(r: Observation, resolved: ReadonlyMap<number, Observation>): number {
  for (const [index, v] of resolved) if (v === r) return index
  return Number.MAX_SAFE_INTEGER
}

/** Offsets already decoded, so a hit there is confirmation rather than news. */
const EVENT_FIELDS: Record<number, MessageKey> = {
  0: 'sensors.field.eventMark',
  1: 'sensors.field.length',
  3: 'sensors.field.usage',
  4: 'sensors.field.deltaHigh',
  5: 'sensors.field.deltaLow',
  7: 'sensors.field.depth',
  8: 'sensors.field.undecodedDepth',
  9: 'sensors.field.direction',
  10: 'sensors.field.calState',
  11: 'sensors.field.scaleUnits',
  12: 'sensors.field.sensorHigh',
  13: 'sensors.field.sensorLow',
  14: 'sensors.field.travelHigh',
  15: 'sensors.field.travelLow',
  16: 'sensors.field.adcHigh',
  17: 'sensors.field.adcLow',
  18: 'sensors.field.baselineHigh',
  19: 'sensors.field.baselineLow',
}

interface ByteCandidate {
  offset: number
  /** Identities used as ground truth: the ones that report a real usage. */
  groups: number
  /** How many of those held a single value at this offset. */
  constantGroups: number
  /** How many distinct values those identities showed. */
  distinct: number
  /** Fixed within every key and different for every key — an address. */
  perfect: boolean
}

/**
 * Looks for a byte that identifies a key on its own.
 *
 * The keys that report a real HID usage are ground truth: we know which key
 * each of their events came from without consulting the fingerprint at all. So
 * for every payload offset we can ask whether the value is fixed per key and
 * distinct between keys — the definition of an address. If such a byte exists,
 * modifier identification stops depending on numbers that calibration rewrites.
 *
 * Offsets are ranked rather than filtered, because a near miss is informative:
 * "fixed per key but shared by two keys" is exactly what the sensor value does.
 */
function addressCandidates(rows: readonly Observation[]): ByteCandidate[] {
  const named = rows.filter((r) => r.usageIsReal)
  if (named.length < 2) return []
  const width = Math.min(...named.map((r) => r.bytes.length))
  const out: ByteCandidate[] = []

  for (let offset = 0; offset < width; offset++) {
    let constantGroups = 0
    const values = new Set<number>()
    for (const r of named) {
      const seen = r.bytes[offset]
      if (!seen || seen.size !== 1) continue
      constantGroups++
      values.add([...seen][0]!)
    }
    out.push({
      offset,
      groups: named.length,
      constantGroups,
      distinct: values.size,
      perfect: constantGroups === named.length && values.size === named.length,
    })
  }

  return out.sort(
    (a, b) =>
      Number(b.perfect) - Number(a.perfect) ||
      b.constantGroups - a.constantGroups ||
      b.distinct - a.distinct ||
      a.offset - b.offset,
  )
}

interface DriftRow {
  sensorId: number
  keyIndex: number
  label: string
  expected: number
  observed: number | null
  delta: number | null
  ambiguous: boolean
  /** Message key for the status cell — resolved when the row is rendered. */
  noteKey: MessageKey
}

/**
 * Pairs each built-in fingerprint with the closest baseline observed under the
 * same sensor value.
 *
 * Nearest-match is only trustworthy while the drift is smaller than half the
 * gap between two keys sharing a sensor value — LCtrl 1880 / LShift 1888 are
 * 8 apart, so a drift over 4 could swap them. Those cases are flagged rather
 * than guessed at, because a wrong pairing here writes a wrong identity table.
 */
function driftReport(rows: readonly Observation[]): DriftRow[] {
  const out: DriftRow[] = []
  const bySensor = new Map<number, number[]>()
  for (const r of rows) {
    if (r.usageIsReal) continue
    bySensor.set(r.sensorId, [
      ...(bySensor.get(r.sensorId) ?? []),
      ...[...r.baselines.keys()],
    ])
  }
  if (bySensor.size === 0) return out

  for (const f of KEY_FINGERPRINTS) {
    const seen = bySensor.get(f.sensorId)
    if (!seen?.length) continue
    const scored = seen
      .map((b) => ({ b, d: Math.abs(b - f.adcBaseline) }))
      .sort((x, y) => x.d - y.d)
    const best = scored[0]!
    const others = KEY_FINGERPRINTS.filter((o) => o.sensorId === f.sensorId && o !== f)
    // Would this observation land closer to a different key in the table?
    const stolen = others.some((o) => Math.abs(best.b - o.adcBaseline) <= best.d)
    const delta = best.b - f.adcBaseline
    out.push({
      sensorId: f.sensorId,
      keyIndex: f.keyIndex,
      label: f.label,
      expected: f.adcBaseline,
      observed: best.b,
      delta,
      ambiguous: stolen,
      noteKey: stolen
        ? 'sensors.drift.note.ambiguous'
        : Math.abs(delta) > BASELINE_TOLERANCE
          ? 'sensors.drift.note.outOfRange'
          : 'sensors.drift.note.match',
    })
  }
  return out
}

/** Emits `KEY_FINGERPRINTS` with the observed baselines substituted in. */
function toFingerprintSource(drift: readonly DriftRow[]): string {
  const patched = new Map(drift.map((d) => [`${d.sensorId}:${d.keyIndex}`, d]))
  const lines = KEY_FINGERPRINTS.map((f) => {
    const d = patched.get(`${f.sensorId}:${f.keyIndex}`)
    const value = d?.observed ?? f.adcBaseline
    const flag = d?.ambiguous ? ` // ⚠ ${translate('sensors.drift.sourceFlag')}` : ''
    return (
      `  { sensorId: 0x${f.sensorId.toString(16).padStart(4, '0')}, ` +
      `adcBaseline: ${value}, keyIndex: ${f.keyIndex}, label: '${f.label}' },${flag}`
    )
  })
  return `export const KEY_FINGERPRINTS: readonly KeyFingerprint[] = [\n${lines.join('\n')}\n]`
}

/**
 * The live parts, on their own render clock.
 *
 * Merging the monitor into this tab put the grid behind the table refresh, and
 * five updates a second looks like stuttering. These two components re-render
 * at display rate off the observation refs, while the tables above stay at
 * TABLE_MS — a 61-cap grid at 60 Hz is cheap, three sortable tables are not.
 */
interface LiveProps {
  current: RefObject<Map<number, Observation>>
  running: boolean
}

function useDisplayClock(running: boolean, onFrame?: () => void): void {
  const [, tick] = useState(0)
  const frame = useRef(onFrame)
  frame.current = onFrame
  useEffect(() => {
    if (!running) return
    let raf = 0
    const loop = () => {
      frame.current?.()
      tick((n) => n + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running])
}

function LiveGrid({
  current,
  selected,
  running,
}: LiveProps & { selected: ReadonlySet<number> }) {
  useDisplayClock(running)
  return (
    <KeyGrid
      selected={selected}
      onToggle={(i, on) => selection.setSelected(i, on)}
      fill={(k) => (current.current?.get(k.index)?.depthMm ?? 0) / DEFAULT_TRAVEL_MM}
      sub={(k) => {
        const r = current.current?.get(k.index)
        return r ? `${r.depthMm.toFixed(2)} / ${r.adcLast}` : undefined
      }}
    />
  )
}

function LiveTrace({
  current,
  focus,
  label,
  running,
}: LiveProps & { focus: number; label: string }) {
  const t = useT()
  const canvas = useRef<HTMLCanvasElement>(null)
  const history = useRef<number[]>([])

  // The trace belongs to one key, so it starts over when the focus moves.
  useEffect(() => {
    history.current = []
  }, [focus, running])

  useDisplayClock(running, () => {
    history.current.push(current.current?.get(focus)?.depthMm ?? 0)
    if (history.current.length > HISTORY) history.current.shift()
    drawTrace(canvas.current, history.current)
  })

  const row = current.current?.get(focus)
  const noise = row && row.depthMaxMm > row.depthMinMm ? row.depthMaxMm - row.depthMinMm : 0

  return (
    <Panel title={t('sensors.trace.title', { index: focus, key: label })}>
      <canvas ref={canvas} width={880} height={160} style={{ width: '100%', maxWidth: 880 }} />
      <div className="row small dim" style={{ marginTop: 8 }}>
        <span>{t('sensors.trace.current', { mm: (row?.depthMm ?? 0).toFixed(3) })}</span>
        <span>{t('sensors.trace.min', { mm: row ? row.depthMinMm.toFixed(3) : '—' })}</span>
        <span>{t('sensors.trace.max', { mm: row ? row.depthMaxMm.toFixed(3) : '—' })}</span>
        <span>{t('sensors.trace.adc', { value: row?.adcLast ?? '—' })}</span>
        <span>{t('sensors.trace.baseline', { value: row?.lastBaseline ?? '—' })}</span>
        <span>{t('sensors.trace.noise', { mm: noise.toFixed(3) })}</span>
      </div>
    </Panel>
  )
}

/** Trace of one key's travel, oldest sample at the left. */
function drawTrace(el: HTMLCanvasElement | null, data: readonly number[]): void {
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  const { width: w, height: h } = el
  ctx.clearRect(0, 0, w, h)
  ctx.strokeStyle = '#2a3441'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  if (data.length < 2) return
  ctx.strokeStyle = '#4c9aff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  data.forEach((mm, i) => {
    const x = (i / (HISTORY - 1)) * w
    const y = (Math.min(mm, DEFAULT_TRAVEL_MM) / DEFAULT_TRAVEL_MM) * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}
