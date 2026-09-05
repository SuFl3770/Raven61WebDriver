import { useCallback, useState } from 'react'
import { t as translate, useT } from '../i18n'
import { T } from '../i18n/T'
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
import { configStore, useDirtyKeys, useKeyConfigs, useLastRead } from '../state/config'
import { globalStore, useGlobalSettings } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * What the board currently has, for every key.
 *
 * It does not read on mount. Opening a section reads the board (see
 * InputPoint), and this panel is one of those sections — reading here as well
 * would send the same two blocks twice on every visit. The raw block is the one
 * thing the shared read does not keep, so the button stays: it is what fetches
 * the bytes for the dump, not a general refresh.
 */

type Status = 'idle' | 'loading' | 'ok' | 'error'

/** Full travel depends on the switch fitted — see SWITCH_TYPES. */
function travelOf(config: KeyConfig): number {
  return switchTypeInfo(config.switchType)?.travelMm ?? DEFAULT_TRAVEL_MM
}

function rtLabel(config: KeyConfig): string {
  const rt = config.rapidTrigger
  if (!rt.enabled) return translate('perf.off')
  return rt.continuous ? translate('perf.rt.full') : translate('perf.on')
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
  if (!dz.enabled) return translate('perf.off')
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
  if (group.keys.length === RAVEN61_KEYS.length)
    return translate('perf.allKeys', { count: group.keys.length })
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
  // The store timestamps its own loads, so "when was the board read" has one
  // source — including after a write, which loads the verify read's values.
  const readAt = useLastRead()
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const global = useGlobalSettings()
  const [snapshot, setSnapshot] = useState<KeyPerfSnapshot | null>(null)
  const [perKey, setPerKey] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const t = useT()

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
          globalStore.load(await codec.readGlobalSettings!(link))
        } catch {
          globalStore.clear()
        }
      }
      setStatus('ok')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [codec, canReadRaw, canReadGlobal])

  // Disconnected means the fallback codec is active, which implements nothing —
  // reporting that as "protocol not decoded" would blame the wrong thing.
  if (!canRead) {
    return (
      <Panel title={t('perf.title')}>
        {connected ? (
          <NotDecoded what="perf.what" />
        ) : (
          <Notice>
            <T k="perf.needDevice" params={{ keys: RAVEN61_KEYS.length }} />
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
    <Panel title={t('perf.title')}>
      <div className="row" style={{ marginBottom: 10 }}>
        <button disabled={!connected || status === 'loading'} onClick={() => void read()}>
          {status === 'loading' ? t('perf.reading') : t('perf.reread')}
        </button>
        <span className="small dim">
          {!connected
            ? t('app.disconnected')
            : status === 'ok' && readAt
              ? t('perf.status.ok', { time: readAt.toLocaleTimeString() })
              : status === 'error'
                ? t('perf.status.error')
                : status === 'loading'
                  ? t('perf.status.loading')
                  : t('perf.status.idle')}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {snapshot && (
          <span className="small dim">
            {t('perf.slotMap.label')}{' '}
            {snapshot.slotMap.source === 'keymap' ? (
              <b style={{ color: 'var(--ok)' }}>{t('perf.slotMap.keymap')}</b>
            ) : (
              <b style={{ color: 'var(--warn)' }}>{t('perf.slotMap.guess')}</b>
            )}{' '}
            ·{' '}
            {t('perf.slotMap.count', {
              resolved: snapshot.slotMap.slotByKey.size,
              total: RAVEN61_KEYS.length,
            })}
          </span>
        )}
        {dirty.length > 0 && (
          <span className="small" style={{ color: 'var(--warn)' }}>
            {t('perf.dirty', { count: dirty.length })}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}


      <div className="row" style={{ marginTop: 14, alignItems: 'flex-start' }}>
        <div className="small dim" style={{ flex: '1 1 320px' }}>
          <b style={{ color: 'var(--fg)' }}>{t('perf.bottomOut')}</b>{' '}
          {global ? (
            <span className={global.bottomOutTrigger ? '' : 'dim'}>
              {global.bottomOutTrigger ? t('perf.on') : t('perf.off')}
            </span>
          ) : (
            <span>—</span>
          )}
          <div style={{ marginTop: 4 }}>
            <T k="perf.bottomOutNote" />
            {global && (
              <>
                {' '}
                <T
                  k="perf.sameByte"
                  params={{
                    tachyon: global.tachyon ? t('perf.on') : t('perf.off'),
                    actuationCheck: global.actuationCheck ? t('perf.on') : t('perf.off'),
                    magnetTest: global.magnetTest ? t('perf.on') : t('perf.off'),
                    debounce: global.debounceLevel,
                  }}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <span className="small dim">
          {uniform ? t('perf.uniform') : t('perf.groups', { count: groups.length })}
        </span>
        <label className="small">
          <input type="checkbox" checked={perKey} onChange={(e) => setPerKey(e.target.checked)} />{' '}
          {t('perf.expandAll', { rows: RAVEN61_KEYS.length })}
        </label>
      </div>

      <div style={{ marginTop: 8, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>{t('perf.col.key')}</th>
              <th>{t('perf.col.actuation')}</th>
              <th>{t('perf.col.rt')}</th>
              <th>{t('perf.col.sensitivity')}</th>
              <th>{t('perf.col.deadzone')}</th>
              <th>{t('perf.col.switch')}</th>
              <th>{t('perf.col.travel')}</th>
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
            <strong>
              {t('perf.emptySlots.title', {
                count: emptyKeys.length,
                bytes: KEY_PERF.recordSize,
              })}
            </strong>
            <div className="small" style={{ marginTop: 4 }}>
              {emptyKeys.map((k) => `${k.label}(${k.index})`).join(', ')}
              <div style={{ marginTop: 4 }}>
                <T
                  k="perf.emptySlots.note"
                  params={{ mm: MM_PER_COUNT.toFixed(2), switchName: switchTypeName(0) }}
                />
              </div>
            </div>
          </Notice>
        </div>
      )}

      {snapshot && (
        <div style={{ marginTop: 12 }}>
          <div className="row">
            <button onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('perf.hideRaw') : t('perf.showRaw', { slots: KEY_PERF.slots })}
            </button>
            {showRaw && (
              <button
                onClick={() => void navigator.clipboard?.writeText(dumpText(snapshot, global))}
              >
                {t('perf.copyDump')}
              </button>
            )}
            <span className="small dim">
              {t('perf.nonEmpty', {
                used: KEY_PERF.slots - snapshot.emptySlots.length,
                total: KEY_PERF.slots,
              })}
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
        <T k="perf.footnote" params={{ step: MM_PER_COUNT.toFixed(2) }} />
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
        {count !== undefined && count > 1 && (
          <span className="dim small"> {translate('perf.keyCount', { count })}</span>
        )}
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
