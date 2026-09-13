import { useCallback, useState } from 'react'
import { useT } from '../i18n'
import { activeLayout, activeSpec, useDeviceSpec, useLayout } from '../device/active'
import { PerfTable } from '../features/PerfOverview'
import { supports } from '../protocol/codec'
import { decodeKeyPerfRecord } from '../protocol/keyPerf'
import type { GlobalSettings, KeyPerfSnapshot } from '../protocol/types'
import { configStore, useLastRead } from '../state/config'
import { globalStore, useGlobalSettings } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * The per-key performance block as bytes, and the table one row per key.
 *
 * This was the back half of the overview's input-point panel. It came here
 * because it answers protocol questions rather than keyboard ones: which slot
 * holds which key, which slots the firmware left at zero, and the block read
 * back as hex. A report on what the keyboard is set to does not need any of
 * them, and the block they are about is the one thing the shared read does not
 * keep — so it had a read button of its own on a tab where every other value
 * arrives by itself, which read as a page that might be stale.
 *
 * The button belongs here. Fetching the bytes again after a write is the whole
 * loop this tool exists for.
 */

type Status = 'idle' | 'loading' | 'ok' | 'error'

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
  const perf = activeSpec().keyPerf
  lines.push(
    `# key perf blob — ${snap.blob.length} bytes, ${perf.slots} slots x ${perf.recordSize}`,
  )
  lines.push(
    `# slot map: ${snap.slotMap.source} — ${snap.slotMap.slotByKey.size}/${activeLayout().count} keys resolved`,
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
  const keymapEntry = activeSpec().keymap.entrySize
  for (let slot = 0; slot < perf.slots; slot++) {
    const at = slot * perf.recordSize
    const bytes = [...snap.blob.subarray(at, at + perf.recordSize)].map(hex).join(' ')
    const km = snap.keymap
      ? [...snap.keymap.subarray(slot * keymapEntry, slot * keymapEntry + keymapEntry)]
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

export function KeyPerfBlock() {
  const { keys } = useLayout()
  const spec = useDeviceSpec()
  const codec = useCodec()
  const { connected } = useConnection()
  // The store timestamps its own loads, so "when was the board read" has one
  // source — including after a write, which loads the verify read's values.
  const readAt = useLastRead()
  const global = useGlobalSettings()
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<KeyPerfSnapshot | null>(null)
  const [perKey, setPerKey] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const t = useT()

  const canRead = supports(codec, 'readKeyPerf')
  const canReadGlobal = supports(codec, 'readGlobalSettings')

  const read = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const snap = await codec.readKeyPerf!(link)
      setSnapshot(snap)
      // Published, so the overview's table and this one cannot disagree about
      // the same board — the decoded half of this read is exactly what the
      // shared read would have produced.
      configStore.load(snap.configs)
      // The global block is a second command, and the dump is still useful
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
  }, [codec, canReadGlobal])

  // Disconnected means the fallback codec is active, which implements nothing —
  // reporting that as "protocol not decoded" would blame the wrong thing.
  if (!canRead) {
    return (
      <Panel title={t('perf.raw.title')}>
        {connected ? <NotDecoded what="perf.what" /> : <Notice>{t('app.disconnected')}</Notice>}
      </Panel>
    )
  }

  const emptyKeys = snapshot
    ? keys.filter((k) => {
        const slot = snapshot.slotMap.slotByKey.get(k.index)
        return slot === undefined || snapshot.emptySlots.includes(slot)
      })
    : []

  return (
    <Panel title={t('perf.raw.title')}>
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
              total: keys.length,
            })}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <label className="small">
          {t('perf.expandAll', { rows: keys.length })}{' '}
          <input type="checkbox" checked={perKey} onChange={(e) => setPerKey(e.target.checked)} />
        </label>
      </div>

      <PerfTable perKey={perKey} />

      {snapshot && emptyKeys.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Notice kind="warn">
            <strong>
              {t('perf.emptySlots.title', {
                count: emptyKeys.length,
                bytes: spec.keyPerf.recordSize,
              })}
            </strong>
            <div className="small" style={{ marginTop: 4 }}>
              {emptyKeys.map((k) => `${k.label}(${k.index})`).join(', ')}
            </div>
          </Notice>
        </div>
      )}

      {snapshot && (
        <div style={{ marginTop: 12 }}>
          <div className="row">
            <button onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('perf.hideRaw') : t('perf.showRaw', { slots: spec.keyPerf.slots })}
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
                used: spec.keyPerf.slots - snapshot.emptySlots.length,
                total: spec.keyPerf.slots,
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
    </Panel>
  )
}
