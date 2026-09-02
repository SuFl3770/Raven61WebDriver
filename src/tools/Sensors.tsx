import { useEffect, useRef, useState, type RefObject } from 'react'
import { BASELINE_TOLERANCE, KEY_FINGERPRINTS } from '../keyboard/fingerprints'
import { DEFAULT_TRAVEL_MM, RAVEN61_KEYS, keyByIndex } from '../keyboard/raven61'
import { isEvent, parseKeyEvent } from '../protocol/frame'
import { MONITOR, armAnalogStream } from '../protocol/raven61'
import { sensorMap, useSensorMap } from '../state/sensorMap'
import { selection, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, Panel } from '../ui/Panel'
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
          deltaLast: e.sensorDelta,
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
      row.deltaLast = e.sensorDelta
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
  const unnamedRows = rows.filter((r) => !r.usageIsReal).sort((a, b) => a.sensorId - b.sensorId)
  const addresses = candidates.filter((c) => c.perfect).slice(0, 4)

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
      <Panel title="실시간 키 깊이 · ADC">
        <Notice>
          <span className="small">
            보드가 올려보내는 것을 그대로 보여줍니다 — 실시간 키 깊이와 <b>원시 센서 숫자 전부</b>
            (현재 ADC, 안 눌린 상태의 기준 ADC, 센서 델타, 센서값). 보드는 누르지 않은 키를 보고하지
            않으므로, 격자가 채워지려면 키를 한 번씩 눌러야 합니다.
          </span>
        </Notice>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void toggle()} disabled={!connected}>
            {listening ? '정지' : '시작'}
          </button>
          <button onClick={clear}>비우기</button>
          <label className="small dim">
            <input
              type="checkbox"
              checked={listenOnly}
              disabled={listening}
              onChange={(e) => setListenOnly(e.target.checked)}
            />{' '}
            <span className="mono">0x{MONITOR.arm.toString(16)}</span> 없이 수신만
          </label>
          <span className="small dim">
            포커스 #{focus} {focusKey?.label ?? ''} — 키를 클릭해 바꿉니다
          </span>
          <span className="small dim">
            키 {resolved.size}/{RAVEN61_KEYS.length}
            {analysis && ` · 식별자 ${rows.length}`}
            {analysis && undecoded.current > 0 && (
              <>
                {' · '}
                <span style={{ color: 'var(--warn)' }}>해석 실패 {undecoded.current}건</span>
              </>
            )}
          </span>
        </div>
        {rows.some((r) => r.identifiable && !r.calibrated) && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              <span className="small">
                <b>보정되지 않은 키가 있습니다.</b> 총 스트로크를 0 으로 보고하고 있어서 깊이는 공칭
                4.00 mm 로 환산한 <b>추정치</b>입니다. 캘리브레이션을 한 번 돌리면 실측으로 바뀝니다.
              </span>
            </Notice>
          </div>
        )}
        {staleTable && !sensorMap.builtInIgnored && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                <b>내장 식별표가 이 보드와 맞지 않습니다.</b> 표에 없는 센서값이 이름 없는 키에서
                관측되었거나, 한 센서값 아래 키 수보다 많은 기준값이 관측되었습니다. 지금 상태에서는
                수정자가 <b>다른 키로 잘못 해석될 수 있습니다</b> — <b>설정</b> 탭에서
                <b> 내장 식별표 무시</b>를 켜고 <b>이벤트</b> 탭에서 직접 연결하세요.
              </span>
            </Notice>
          </div>
        )}
        {armError && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="err">
              <span className="small">
                스트림을 켜지 못했습니다: <span className="mono">{armError}</span>
                <div style={{ marginTop: 4 }}>
                  <b>장치</b> 탭에서 <b>권장</b> 표시가 붙은 인터페이스가 열려 있는지 확인하세요.
                </div>
              </span>
            </Notice>
          </div>
        )}
        {arm && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              <span className="small">
                아날로그 보고를 켰습니다 (<span className="mono">0x{MONITOR.arm.toString(16)}</span> →{' '}
                <span className="mono">0x{MONITOR.disarm.toString(16)}</span>). 보고는 켜진 채 유지되고
                테스트 모드는 빠져나왔으므로 타이핑은 그대로 동작하며 보정도 일어나지 않습니다.
              </span>
            </Notice>
          </div>
        )}
        <div className="small dim" style={{ marginTop: 12, marginBottom: 8 }}>
          채움은 <b>현재 깊이</b>, 아래 숫자는 <b>깊이 mm / 현재 ADC</b> 입니다.
        </div>
        <LiveGrid current={current} selected={sel} running={listening} />
      </Panel>

      <LiveTrace current={current} focus={focus} label={focusKey?.label ?? ''} running={listening} />

      {analysis && rows.length > 0 && (
        <Panel title={`관측된 식별자 ${rows.length}개`}>
          <table>
            <thead>
              <tr>
                <th>키</th>
                <th style={{ width: 70 }}>usage</th>
                <th style={{ width: 110 }}>수정자 비트</th>
                <th style={{ width: 80 }}>센서값</th>
                <th style={{ width: 110 }}>기준 ADC</th>
                <th style={{ width: 80 }}>현재 ADC</th>
                <th style={{ width: 110 }}>ADC 최소–최대</th>
                <th style={{ width: 70 }}>델타</th>
                <th style={{ width: 80 }}>최대 깊이</th>
                <th style={{ width: 70 }}>관측</th>
                <th style={{ width: 90 }}>센서값 형제</th>
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
                          <span style={{ color: 'var(--warn)' }}>미해석</span>
                        ) : (
                          <span className="dim">키 아님</span>
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
                  기준 ADC 가 <b>표류했습니다.</b> 기준 ADC 는 저장된 캘리브레이션 상수이므로, 한
                  세션에서 값이 바뀌거나 한 센서값 아래 키 수보다 많은 값이 관측되면 그 사이에
                  <b> 보정이 일어났다</b>는 뜻입니다. 아래 표류 패널에서 내장 식별표와의 차이를
                  확인하세요.
                </span>
              </Notice>
            </div>
          )}
          {unresolved.length > 0 && (
            <div style={{ marginTop: 10 }} className="small dim">
              미해석 {unresolved.length}개는 <b>이벤트</b> 탭에서 키에 연결할 수 있습니다.
            </div>
          )}
          {nonKey.length > 0 && (
            <div style={{ marginTop: 6 }} className="small dim">
              <b>키 아님</b> {nonKey.length}개 — usage 도 수정자 비트도 기준 ADC 도 없는 리포트입니다
              (<span className="mono">{nonKey.map((r) => `${hex4(r.sensorId)}:${r.lastBaseline}`).join(', ')}</span>).
              정상 동작하는 보드에서도 계속 올라오므로 키 식별에서 제외합니다.
            </div>
          )}
        </Panel>
      )}

      {analysis && candidates.length > 0 && (
        <Panel title="키 주소 후보 — 표류하지 않는 바이트 찾기">
          <div className="small dim" style={{ marginBottom: 8 }}>
            usage 로 스스로 이름을 말하는 키 {candidates[0]!.groups}개를 <b>정답지</b>로 삼아, 바이트마다
            두 가지를 봅니다: 한 키 안에서 <b>항상 같은 값</b>인가, 그리고 키마다 <b>서로 다른 값</b>인가.
            둘을 모두 만족하는 바이트가 곧 캘리브레이션에 흔들리지 않는 키 주소입니다.
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>오프셋</th>
                <th style={{ width: 100 }}>키 내 고정</th>
                <th style={{ width: 110 }}>서로 다른 값</th>
                <th style={{ width: 90 }}>평가</th>
                <th>이미 아는 필드</th>
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
                    {c.perfect ? '주소 후보' : c.constantGroups < c.groups ? '변동' : '중복'}
                  </td>
                  <td className="small dim">{EVENT_FIELDS[c.offset] ?? '미해독'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            {addresses.some((c) => !EVENT_FIELDS[c.offset]) ? (
              <Notice kind="info">
                <span className="small">
                  <b>미해독 바이트가 주소 조건을 만족합니다.</b> 이 값이 수정자 쪽에서도 서로 갈리면,
                  지문 대신 이 바이트로 키를 식별할 수 있습니다 — 캘리브레이션과 무관하게.
                </span>
              </Notice>
            ) : (
              <Notice kind="warn">
                <span className="small">
                  주소 조건을 만족하는 <b>미해독 바이트가 없습니다.</b> 관측이 적어서일 수 있으니 각 키를
                  여러 번, 깊이를 달리해 눌러 보세요. 그래도 없다면 이 이벤트에는 캘리브레이션에 안전한
                  식별자가 없다는 뜻이고, 수정자는 <b>사용자 연결</b>에 의존해야 합니다.
                </span>
              </Notice>
            )}
          </div>
          {unnamedRows.length > 0 && addresses.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="small dim" style={{ marginBottom: 6 }}>
                이름 없는 키(수정자·Fn)에서 그 후보 바이트가 실제로 갈리는지:
              </div>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 200 }}>식별자</th>
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
        <Panel title="기준 ADC 표류 — 내장 식별표 대비">
          <div className="small dim" style={{ marginBottom: 8 }}>
            <span className="mono">fingerprints.ts</span> 의 항목마다, 같은 센서값에서 관측된 기준 ADC
            중 가장 가까운 값을 붙였습니다. 허용 오차는 ±{BASELINE_TOLERANCE} 이고, 그보다 벌어지면
            그 키는 해석되지 않거나 다른 키로 해석됩니다.
          </div>
          <table>
            <thead>
              <tr>
                <th>키</th>
                <th style={{ width: 80 }}>센서값</th>
                <th style={{ width: 90 }}>표의 값</th>
                <th style={{ width: 90 }}>관측값</th>
                <th style={{ width: 70 }}>차이</th>
                <th>상태</th>
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
                  <td className="small dim">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void navigator.clipboard?.writeText(toFingerprintSource(drift))}>
              갱신된 식별표 소스로 복사
            </button>
            <span className="small dim">
              관측된 기준 ADC 로 <span className="mono">KEY_FINGERPRINTS</span> 를 다시 씁니다 — 키
              배정은 그대로 두고 숫자만 갱신합니다.
            </span>
          </div>
          {drift.some((d) => d.ambiguous) && (
            <div style={{ marginTop: 10 }}>
              <Notice kind="err">
                <span className="small">
                  <b>모호한 짝이 있습니다.</b> 같은 센서값 아래 두 키의 관측값이 서로 가까워서, 어느
                  관측값이 어느 키인지 이 표만으로는 정할 수 없습니다. 그 키들은 <b>이벤트</b> 탭에서
                  하나씩 눌러 직접 연결하세요 — 사용자 연결이 내장 표보다 우선합니다.
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
const EVENT_FIELDS: Record<number, string> = {
  0: '0xa0 이벤트 표식',
  1: '길이',
  3: 'usage',
  4: '센서 델타 (상위)',
  5: '센서 델타 (하위)',
  7: '깊이',
  8: '미해독 — 깊이와 함께 움직임',
  9: '방향',
  12: '센서값 (상위)',
  13: '센서값 (하위)',
  14: '총 스트로크 (상위)',
  15: '총 스트로크 (하위)',
  16: '현재 ADC (상위)',
  17: '현재 ADC (하위)',
  18: '기준 ADC (상위)',
  19: '기준 ADC (하위)',
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
  note: string
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
      note: stolen
        ? '같은 센서값의 다른 키와 구별 불가'
        : Math.abs(delta) > BASELINE_TOLERANCE
          ? '허용 오차 초과 — 이 키는 해석되지 않습니다'
          : '일치',
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
    const flag = d?.ambiguous ? ' // ⚠ 모호 — 직접 확인 필요' : ''
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
      onSelect={(i, additive) => selection.toggle(i, additive)}
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
    <Panel title={`트레이스 — #${focus} ${label}`}>
      <canvas ref={canvas} width={880} height={160} style={{ width: '100%', maxWidth: 880 }} />
      <div className="row small dim" style={{ marginTop: 8 }}>
        <span>현재 {(row?.depthMm ?? 0).toFixed(3)} mm</span>
        <span>최소 {row ? row.depthMinMm.toFixed(3) : '—'}</span>
        <span>최대 {row ? row.depthMaxMm.toFixed(3) : '—'}</span>
        <span>현재 ADC {row?.adcLast ?? '—'}</span>
        <span>기준 ADC {row?.lastBaseline ?? '—'}</span>
        <span>
          정지 시 흔들림 {noise.toFixed(3)} mm — 래피드 트리거 민감도는 이 값보다 커야 합니다
        </span>
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
