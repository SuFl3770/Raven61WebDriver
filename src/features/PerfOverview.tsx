import { useCallback, useEffect, useRef, useState } from 'react'
import { RAVEN61_KEYS, DEFAULT_TRAVEL_MM, type KeyDef } from '../keyboard/raven61'
import { supports } from '../protocol/codec'
import { MM_PER_COUNT, mmToCounts } from '../protocol/encoding'
import {
  switchTypeInfo,
  switchTypeName,
  type GlobalSettings,
  type KeyConfig,
  type KeyPerfSnapshot,
} from '../protocol/types'
import { KEY_PERF, decodeKeyPerfRecord } from '../protocol/keyPerf'
import { KEYMAP } from '../protocol/slotMap'
import { configStore, useDirtyKeys, useKeyConfigs } from '../state/config'
import { selection, useSelection } from '../state/selection'
import { link, useCodec, useConnection } from '../state/link'
import { KeyGrid } from '../ui/KeyGrid'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * What the board currently has, for every key.
 *
 * The stock driver reads this blob on connect rather than on entering its
 * performance tab, then renders from its own cache — which is why its values
 * appear instantly. There is no cache here, so the read happens on entry, once
 * per mount.
 */

type Status = 'idle' | 'loading' | 'ok' | 'error'

/** Which value the key grid colours and labels. */
const METRICS = [
  { id: 'actuation', label: '동작 지점' },
  { id: 'rt', label: '래피드 트리거' },
  { id: 'switch', label: '스위치' },
] as const
type Metric = (typeof METRICS)[number]['id']

/** Full travel depends on the switch fitted — see SWITCH_TYPES. */
function travelOf(config: KeyConfig): number {
  return switchTypeInfo(config.switchType)?.travelMm ?? DEFAULT_TRAVEL_MM
}

function rtLabel(config: KeyConfig): string {
  const rt = config.rapidTrigger
  if (!rt.enabled) return '꺼짐'
  return rt.continuous ? '전체 스트로크' : '켜짐'
}

function sensitivityLabel(config: KeyConfig): string {
  const rt = config.rapidTrigger
  if (!rt.enabled) return '—'
  return rt.pressMm === rt.releaseMm
    ? rt.pressMm.toFixed(2)
    : `${rt.pressMm.toFixed(2)} / ${rt.releaseMm.toFixed(2)}`
}

function deadZoneLabel(config: KeyConfig): string {
  const dz = config.deadZone
  if (!dz.enabled) return '꺼짐'
  return `${dz.topMm.toFixed(2)} / ${dz.bottomMm.toFixed(2)}`
}

/**
 * Keys that share every value collapse into one row. With 61 keys usually set
 * identically, the per-key list buries the one key that differs — which is the
 * thing worth seeing.
 */
function signatureOf(c: KeyConfig): string {
  return [
    c.actuationMm,
    c.rapidTrigger.enabled,
    c.rapidTrigger.continuous,
    c.rapidTrigger.pressMm,
    c.rapidTrigger.releaseMm,
    c.deadZone.enabled,
    c.deadZone.topMm,
    c.deadZone.bottomMm,
    c.switchType,
  ].join('|')
}

interface Group {
  keys: KeyDef[]
  config: KeyConfig
}

function groupKeys(configs: readonly KeyConfig[]): Group[] {
  const byId = new Map<string, Group>()
  for (const key of RAVEN61_KEYS) {
    const config = configs[key.index]
    if (!config) continue
    const id = signatureOf(config)
    const hit = byId.get(id)
    if (hit) hit.keys.push(key)
    else byId.set(id, { keys: [key], config })
  }
  // Largest group first: the board's baseline, then the exceptions.
  return [...byId.values()].sort((a, b) => b.keys.length - a.keys.length)
}

function groupLabel(group: Group): string {
  if (group.keys.length === RAVEN61_KEYS.length) return `전체 ${group.keys.length}키`
  const shown = group.keys.slice(0, 10).map((k) => k.label)
  const rest = group.keys.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}

/**
 * Both blocks as text, one line per slot.
 *
 * Exists to be pasted back during reverse engineering. The decoded table can
 * look entirely reasonable while every record belongs to the wrong key, and
 * only the slot bytes show it — which is exactly how the first two cuts of this
 * codec went wrong. The keymap column is the mapping's evidence: it is what
 * says slot 14 is Backspace rather than Tab.
 */
function dumpText(snap: KeyPerfSnapshot, global: GlobalSettings | null): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  const lines: string[] = []
  lines.push(
    `# key perf blob — ${snap.blob.length} bytes, ${KEY_PERF.slots} slots x ${KEY_PERF.recordSize}`,
  )
  lines.push(
    `# slot map: ${snap.slotMap.source} — ${snap.slotMap.slotByKey.size}/${RAVEN61_KEYS.length} keys resolved`,
  )
  if (snap.slotMap.unknownUsages.length > 0) {
    lines.push(
      `# keymap usages with no key in this layout: ` +
        snap.slotMap.unknownUsages.map((u) => `${u.slot}=0x${hex(u.usage)}`).join(' '),
    )
  }
  lines.push(`# empty perf slots (${snap.emptySlots.length}): ${snap.emptySlots.join(',') || 'none'}`)
  if (global) lines.push(`# global 0x05 reply: ${[...global.raw].map(hex).join(' ')}`)
  lines.push('# slot  perf bytes               keymap    key         act mode rtP rtR dzT dzB sw flags')
  for (let slot = 0; slot < KEY_PERF.slots; slot++) {
    const at = slot * KEY_PERF.recordSize
    const bytes = [...snap.blob.subarray(at, at + KEY_PERF.recordSize)].map(hex).join(' ')
    const km = snap.keymap
      ? [...snap.keymap.subarray(slot * KEYMAP.entrySize, slot * KEYMAP.entrySize + KEYMAP.entrySize)]
          .map(hex)
          .join(' ')
      : '-- -- --'
    const key = snap.slotMap.keyBySlot.get(slot)
    const r = decodeKeyPerfRecord(snap.blob, slot)
    const decoded = snap.emptySlots.includes(slot)
      ? '(zero)'
      : `${r.actuationCounts} ${r.keyMode} ${r.rtPressCounts} ${r.rtReleaseCounts} ` +
        `${r.pressDeadzoneCounts} ${r.releaseDeadzoneCounts} ${r.switchType} 0x${hex(r.switchFlags)}`
    lines.push(
      `${String(slot).padStart(5)}  ${bytes}  ${km}  ${(key?.label ?? '-').padEnd(10)}  ${decoded}`,
    )
  }
  return lines.join('\n')
}

export function PerfOverview() {
  const codec = useCodec()
  const { connected } = useConnection()
  const configs = useKeyConfigs()
  const dirty = useDirtyKeys()
  const sel = useSelection()
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<Date | null>(null)
  const [global, setGlobal] = useState<GlobalSettings | null>(null)
  const [snapshot, setSnapshot] = useState<KeyPerfSnapshot | null>(null)
  const [metric, setMetric] = useState<Metric>('actuation')
  const [perKey, setPerKey] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const tried = useRef(false)

  const canRead = supports(codec, 'readKeyConfigs')
  const canReadRaw = supports(codec, 'readKeyPerf')
  const canReadGlobal = supports(codec, 'readGlobalSettings')

  const read = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      // Prefer the snapshot: it carries the raw block, which is what makes a
      // wrong slot mapping visible instead of merely implausible.
      if (canReadRaw) {
        const snap = await codec.readKeyPerf!(link)
        setSnapshot(snap)
        configStore.load(snap.configs)
      } else {
        setSnapshot(null)
        configStore.load(await codec.readKeyConfigs!(link))
      }
      // The global block is a second command, and the panel is still useful
      // without it — a failure there must not throw away the per-key values.
      if (canReadGlobal) {
        try {
          setGlobal(await codec.readGlobalSettings!(link))
        } catch {
          setGlobal(null)
        }
      }
      setReadAt(new Date())
      setStatus('ok')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [codec, canReadRaw, canReadGlobal])

  useEffect(() => {
    if (!connected || !canRead || tried.current) return
    // Never on entry with unsaved edits: loading replaces the working copy, and
    // silently discarding the user's edits is worse than showing stale values.
    if (dirty.length > 0) return
    tried.current = true
    void read()
  }, [connected, canRead, dirty.length, read])

  // Disconnected means the fallback codec is active, which implements nothing —
  // reporting that as "protocol not decoded" would blame the wrong thing.
  if (!canRead) {
    return (
      <Panel title="보드 현재 설정">
        {connected ? (
          <NotDecoded what="키별 성능 설정 읽기" />
        ) : (
          <Notice>
            장치가 연결되면 보드에서 61키의 현재 설정을 읽어 옵니다. <b>장치</b> 탭에서 먼저 연결하세요.
          </Notice>
        )}
      </Panel>
    )
  }

  const groups = groupKeys(configs)
  const uniform = groups.length === 1
  const emptyKeys = snapshot
    ? RAVEN61_KEYS.filter((k) => {
        const slot = snapshot.slotMap.slotByKey.get(k.index)
        return slot === undefined || snapshot.emptySlots.includes(slot)
      })
    : []

  return (
    <Panel title="보드 현재 설정">
      <div className="row" style={{ marginBottom: 10 }}>
        <button disabled={!connected || status === 'loading'} onClick={() => void read()}>
          {status === 'loading' ? '읽는 중…' : '보드에서 다시 읽기'}
        </button>
        <span className="small dim">
          {!connected
            ? '미연결'
            : status === 'ok' && readAt
              ? `${readAt.toLocaleTimeString()} 기준 · 0xa0 · 1024바이트 · 128슬롯`
              : status === 'error'
                ? '읽기 실패'
                : status === 'loading'
                  ? '0xa0 블록 19청크 수신 중'
                  : '아직 읽지 않았습니다'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {snapshot && (
          <span className="small dim">
            슬롯 매핑{' '}
            {snapshot.slotMap.source === 'keymap' ? (
              <b style={{ color: 'var(--ok)' }}>보드 키맵 기준</b>
            ) : (
              <b style={{ color: 'var(--warn)' }}>추정값 (키맵 읽기 실패)</b>
            )}{' '}
            · {snapshot.slotMap.slotByKey.size}/{RAVEN61_KEYS.length}키
          </span>
        )}
        {dirty.length > 0 && (
          <span className="small" style={{ color: 'var(--warn)' }}>
            편집한 키 {dirty.length}개 — 다시 읽으면 되돌아갑니다
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="small dim">그리드 표시</span>
        {METRICS.map((m) => (
          <button
            key={m.id}
            className={metric === m.id ? 'primary' : undefined}
            onClick={() => setMetric(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <KeyGrid
        selected={sel}
        onSelect={(i, additive) => selection.toggle(i, additive)}
        sub={(k) => {
          const c = configs[k.index]
          if (!c) return undefined
          if (metric === 'actuation') return c.actuationMm.toFixed(2)
          if (metric === 'rt') return c.rapidTrigger.enabled ? (c.rapidTrigger.continuous ? 'FULL' : 'RT') : undefined
          return c.switchType === undefined ? undefined : `S${c.switchType}`
        }}
        fill={(k) => {
          const c = configs[k.index]
          if (!c) return 0
          if (metric === 'actuation') return c.actuationMm / travelOf(c)
          if (metric === 'rt') return c.rapidTrigger.enabled ? 1 : 0
          return c.switchType === undefined ? 0 : 0.35
        }}
      />

      <div className="row" style={{ marginTop: 14, alignItems: 'flex-start' }}>
        <div className="small dim" style={{ flex: '1 1 320px' }}>
          <b style={{ color: 'var(--fg)' }}>바닥까지 입력시 트리거</b>{' '}
          {global ? (
            <span className={global.bottomOutTrigger ? '' : 'dim'}>
              {global.bottomOutTrigger ? '켜짐' : '꺼짐'}
            </span>
          ) : (
            <span>—</span>
          )}
          <div style={{ marginTop: 4 }}>
            이 항목만 키별이 아니라 <b>전역</b> 설정입니다 (0x05 블록{' '}
            <span className="mono">payload[15]</span> bit 1).
            {global && (
              <>
                {' '}
                같은 바이트: Tachyon {global.tachyon ? '켜짐' : '꺼짐'} · actuation_check{' '}
                {global.actuationCheck ? '켜짐' : '꺼짐'} · 자석축 테스트{' '}
                {global.magnetTest ? '켜짐' : '꺼짐'} · 디바운스 {global.debounceLevel}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <span className="small dim">
          {uniform ? '모든 키가 같은 설정입니다' : `설정이 다른 그룹 ${groups.length}개`}
        </span>
        <label className="small">
          <input type="checkbox" checked={perKey} onChange={(e) => setPerKey(e.target.checked)} />{' '}
          키별로 모두 펼치기 ({RAVEN61_KEYS.length}행)
        </label>
      </div>

      <div style={{ marginTop: 8, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>키</th>
              <th>동작 지점</th>
              <th>래피드 트리거</th>
              <th>RT 민감도 (누름 / 뗌)</th>
              <th>데드존 (위 / 아래)</th>
              <th>장착된 스위치</th>
              <th>총 스트로크</th>
            </tr>
          </thead>
          <tbody>
            {perKey
              ? RAVEN61_KEYS.map((k) => {
                  const c = configs[k.index]
                  if (!c) return null
                  return <Row key={k.index} name={k.label} config={c} />
                })
              : groups.map((g) => (
                  <Row
                    key={signatureOf(g.config)}
                    name={groupLabel(g)}
                    config={g.config}
                    // The all-keys label already carries the count.
                    count={g.keys.length === RAVEN61_KEYS.length ? undefined : g.keys.length}
                  />
                ))}
          </tbody>
        </table>
      </div>

      {snapshot && emptyKeys.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Notice kind="warn">
            <strong>슬롯 {emptyKeys.length}개가 비어 있습니다 (8바이트 전부 0)</strong>
            <div className="small" style={{ marginTop: 4 }}>
              {emptyKeys.map((k) => `${k.label}(${k.index})`).join(', ')}
              <div style={{ marginTop: 4 }}>
                전부 0인 레코드는 동작 지점 {MM_PER_COUNT.toFixed(2)}mm · RT 꺼짐 ·{' '}
                {switchTypeName(0)} 으로 해독됩니다. 실제 설정이 아니라 <b>읽지 못한 것</b>입니다.
              </div>
            </div>
          </Notice>
        </div>
      )}

      {snapshot && (
        <div style={{ marginTop: 12 }}>
          <div className="row">
            <button onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? '원본 블록 숨기기' : '원본 블록 보기 (128슬롯)'}
            </button>
            {showRaw && (
              <button
                onClick={() => void navigator.clipboard?.writeText(dumpText(snapshot, global))}
              >
                덤프 복사
              </button>
            )}
            <span className="small dim">
              비어 있지 않은 슬롯 {KEY_PERF.slots - snapshot.emptySlots.length}개 / {KEY_PERF.slots}
            </span>
          </div>
          {showRaw && (
            <pre className="dump" style={{ marginTop: 8, maxHeight: 320 }}>
              {dumpText(snapshot, global)}
            </pre>
          )}
        </div>
      )}

      <div className="small dim" style={{ marginTop: 10 }}>
        단위는 mm 이고 보드의 최소 단위는 {MM_PER_COUNT.toFixed(2)}mm 입니다. 표의 값은 그대로 보드에서 읽은
        것이며, 아래 패널에서 편집한 값은 <b>보드에 적용</b>할 때까지 반영되지 않습니다.
      </div>
    </Panel>
  )
}

function Row({ name, config, count }: { name: string; config: KeyConfig; count?: number }) {
  const rt = config.rapidTrigger
  const travel = travelOf(config)
  return (
    <tr>
      <td>
        {name}
        {count !== undefined && count > 1 && <span className="dim small"> ({count}키)</span>}
      </td>
      <td className="mono">
        {config.actuationMm.toFixed(2)}
        <span className="dim small"> ({mmToCounts(config.actuationMm)})</span>
      </td>
      <td className={rt.enabled ? undefined : 'dim'}>{rtLabel(config)}</td>
      <td className="mono">{sensitivityLabel(config)}</td>
      <td className={config.deadZone.enabled ? 'mono' : 'dim'}>{deadZoneLabel(config)}</td>
      <td>
        {switchTypeName(config.switchType)}
        {config.switchType !== undefined && (
          <span className="dim small"> ({config.switchType})</span>
        )}
      </td>
      <td className="mono dim">{travel.toFixed(2)}</td>
    </tr>
  )
}
