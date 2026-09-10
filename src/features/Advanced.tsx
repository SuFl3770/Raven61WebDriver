import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeviceSpec, useLayout } from '../device/active'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { KEYCODES, keycodeDefLabel } from '../keyboard/keycodes'
import {
  ADVANCED_KINDS,
  ADVANCED_TYPE,
  DKS_BINDINGS,
  DKS_STAGES,
  MT_DEFAULT_HOLD_MS,
  MT_HOLD_MS_PER_UNIT,
  PAIRED_KINDS,
  decodeAdvancedRecord,
  dksMmToSteps,
  encodeAdvancedRecord,
  encodeDksSpan,
  dksStepsToMm,
  emptyAdvancedRecord,
  firstFreeRecord,
  mtBindings,
  oksBindings,
  pairUsages,
  recordHex,
  withMtBindings,
  withOksBindings,
  withPairUsages,
  type AdvancedKind,
  type AdvancedRecord,
  type PairRecord,
  type ToggleRecord,
} from '../protocol/advancedKeys'
import { supports } from '../protocol/codec'
import { BINDING_GROUPS, encodeRecord, groupChoices, type KeyBinding } from '../protocol/keymap'
import type { AdvancedKeySnapshot, AdvancedKeyUse, KeymapEntry } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { GridFrame } from '../ui/GridFrame'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { Select, type SelectOption } from '../ui/Select'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { Slider } from '../ui/Slider'

/**
 * Advanced keys — DKS, TGL, MT, RS, SOCD and OKS.
 *
 * A tab of its own rather than a panel under rapid trigger. Both are "what a
 * key does when you press it", but the input-point tab is about *where in the
 * stroke* a key triggers and every section in it edits the same per-key
 * performance record. An advanced key is three other blocks and a keymap entry.
 *
 * ### Two writes, in this order
 *
 * Nothing here is one setting. A record in the tables carries the parameters
 * and a keymap entry says which key runs it, which kind it is, and — for RS,
 * SOCD and OKS — which key it is paired with. So applying is:
 *
 *   1. write the record (0xa3 / 0xa5 / 0xa7, whichever table the kind uses)
 *   2. write the keymap entry (0x09)
 *
 * That order matters. Between the two the board has a record nothing points at,
 * which does nothing; the other order would leave a key pointing at a record
 * that has not been written, and the firmware would run whatever was there.
 *
 * ### What this tab does not claim
 *
 * The blocks are decoded from the firmware and every write is read back and
 * compared, the same as everywhere else here — but **none of it is confirmed on
 * hardware**. The panel says so rather than letting a verified write imply a
 * working key.
 *
 * SOCD's resolution mode is deliberately read-only here. It is not in these
 * tables at all: the scan takes it from the high nibble of the key's per-key
 * performance record, so changing it is a write to a block the input-point tab
 * owns. Showing it and pointing at that tab beats a second control that edits
 * the same byte from two places.
 */

/** Millimetres a slider covers. The board stores tenths, so the step is 0.1. */
const DKS_MAX_MM = 4.0

/**
 * One message key per stage, spelled out rather than built from the index.
 *
 * `MessageKey` is derived from the bundle at compile time, so a template
 * literal is not one of its members — and writing them out is what makes a
 * missing translation a build error rather than a blank label.
 */
const DKS_POINT_KEYS = [
  'advanced.dks.point0',
  'advanced.dks.point1',
  'advanced.dks.point2',
  'advanced.dks.point3',
] as const

const DKS_STAGE_KEYS = [
  'advanced.dks.stage0',
  'advanced.dks.stage1',
  'advanced.dks.stage2',
  'advanced.dks.stage3',
] as const

type Draft = { kind: AdvancedKind; record: number; rec: AdvancedRecord; param: number }

/** Every binding the remap catalog offers, flattened for a dropdown. */
function bindingOptions(): { options: SelectOption[]; byValue: Map<string, KeyBinding> } {
  const options: SelectOption[] = []
  const byValue = new Map<string, KeyBinding>()
  const add = (label: string, binding: KeyBinding) => {
    const value = encodeRecord(binding).join(':')
    if (byValue.has(value)) return
    byValue.set(value, binding)
    options.push({ value, label })
  }
  add('—', { kind: 'none', raw: 0 })
  for (const def of KEYCODES) {
    add(keycodeDefLabel(def), { kind: 'key', usage: def.code, modifiers: 0 })
  }
  for (const group of BINDING_GROUPS) {
    for (const choice of groupChoices(group)) add(choice.label, choice.binding)
  }
  return { options, byValue }
}

const BINDINGS = bindingOptions()

function bindingValue(binding: KeyBinding): string {
  return encodeRecord(binding).join(':')
}

/** Plain HID usages, for the kinds whose records hold a bare usage byte. */
function usageOptions(): SelectOption[] {
  const out: SelectOption[] = [{ value: '0', label: '—' }]
  for (const def of KEYCODES) {
    out.push({ value: String(def.code), label: keycodeDefLabel(def) })
  }
  return out
}

const USAGES = usageOptions()

function BindingSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: KeyBinding
  onChange: (binding: KeyBinding) => void
  label: string
  disabled?: boolean
}) {
  return (
    <Select
      label={label}
      value={bindingValue(value)}
      options={BINDINGS.options}
      disabled={disabled}
      onChange={(v) => {
        const binding = BINDINGS.byValue.get(v)
        if (binding) onChange(binding)
      }}
    />
  )
}

function UsageSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: number
  onChange: (usage: number) => void
  label: string
  disabled?: boolean
}) {
  return (
    <Select
      label={label}
      value={String(value)}
      options={USAGES}
      disabled={disabled}
      onChange={(v) => onChange(Number(v))}
    />
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="small dim" style={{ minWidth: 120 }}>
        {label}
      </span>
      {children}
    </div>
  )
}

export function Advanced() {
  const t = useT()
  const codec = useCodec()
  const spec = useDeviceSpec()
  const { keys } = useLayout()
  const { connected } = useConnection()

  const canRead = supports(codec, 'readAdvancedKeys')
  const canWrite = supports(codec, 'writeAdvancedKey') && supports(codec, 'writeKeymap')
  /** Unbinding needs the factory table as well, to put the cap back to itself. */
  const canUnbind = canWrite && supports(codec, 'readKeymapDefaults')

  const [layer, setLayer] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<AdvancedKeySnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<null | 'read' | 'write'>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)
  const inFlight = useRef(false)

  const read = useCallback(async () => {
    if (!codec.readAdvancedKeys) return
    inFlight.current = true
    setBusy('read')
    setError(null)
    setMismatch(null)
    try {
      setSnapshot(await codec.readAdvancedKeys(link))
      setDraft(null)
      setStatus(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [codec])

  /*
   * Opening the tab reads. No read button, the same as the remap tab — and for
   * the same reason it does not re-run itself on failure: a board that answers
   * nothing would otherwise be asked once per render. Leaving the tab and
   * coming back is the retry, and the refresh.
   */
  useEffect(() => {
    if (!connected || !canRead || inFlight.current || snapshot) return
    void read()
  }, [connected, canRead, read, snapshot])

  const uses = snapshot?.uses.filter((u) => u.layer === layer) ?? []
  const useByKey = new Map<number, AdvancedKeyUse>()
  for (const u of uses) if (u.index >= 0) useByKey.set(u.index, u)

  const pickedKey = selected === null ? undefined : keys.find((k) => k.index === selected)
  const pickedUse = selected === null ? undefined : useByKey.get(selected)

  /** The draft for the picked key, or what the board holds turned into one. */
  const current: Draft | null =
    draft ??
    (pickedUse && snapshot
      ? {
          kind: pickedUse.kind,
          record: pickedUse.record,
          rec: decodeAdvancedRecord(snapshot.blobs, pickedUse.record, pickedUse.kind),
          param: pickedUse.param,
        }
      : null)

  /** Starts a new advanced key on the picked cap, in the first free record. */
  const create = (kind: AdvancedKind) => {
    if (!snapshot) return
    const record = firstFreeRecord(snapshot.blobs, spec.advancedKeys.usable)
    if (record < 0) {
      setError(t('advanced.noFreeRecord', { limit: spec.advancedKeys.usable }))
      return
    }
    setError(null)
    setDraft({
      kind,
      record,
      rec: emptyAdvancedRecord(kind),
      param: kind === 'mt' ? MT_DEFAULT_HOLD_MS / MT_HOLD_MS_PER_UNIT : 0,
    })
  }

  const edit = (patch: Partial<Draft>) => {
    if (!current) return
    setDraft({ ...current, ...patch })
  }

  const apply = async () => {
    if (!current || !codec.writeAdvancedKey || !codec.writeKeymap || selected === null) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      // The record first: between the two writes the board holds a record
      // nothing points at, which does nothing. The other order points a key at
      // bytes that have not been written yet.
      const written = await codec.writeAdvancedKey(link, current.record, current.rec)
      if (written.mismatch) {
        setMismatch(
          t('advanced.mismatch', {
            record: current.record,
            wanted: written.mismatch.wanted,
            got: written.mismatch.got,
          }),
        )
        return
      }
      const binding: KeyBinding = {
        kind: 'advanced',
        type: ADVANCED_TYPE[current.kind],
        record: current.record,
        param: current.param & 0xff,
      }
      const entries: (KeymapEntry | null)[] = keys.map((k) =>
        k.index === selected ? { binding } : null,
      )
      const result = await codec.writeKeymap(link, layer, entries)
      if (result.mismatched.length > 0) {
        setMismatch(
          t('advanced.keymapMismatch', {
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
        return
      }
      setDraft(null)
      // After the read, not before: the read clears the status line, so a
      // message set first would be wiped by the refresh it triggered.
      await read()
      setStatus(t('advanced.applied', { record: current.record, kind: t(kindKey(current.kind)) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Takes the advanced key off the selected cap.
   *
   * Two steps, in the mirror image of `apply`: the keymap entry goes back to
   * the board's own factory binding first, so nothing is pointing at the record
   * while it is cleared. The record itself is only zeroed when **no other
   * keymap entry on any layer names it** — records are shared, and a pair of
   * RS keys or the same advanced key on two layers would otherwise lose its
   * parameters because one of its keys was unbound.
   *
   * The factory binding comes from the board (0x07), not from this app's idea
   * of the default: the two agree on the base layer, and this app has no idea
   * at all about the Fn one.
   */
  const unbind = async () => {
    if (!pickedUse || !codec.writeKeymap || !codec.readKeymapDefaults || !snapshot) return
    if (selected === null) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const table = await codec.readKeymapDefaults(link, layer)
      const factory = table[selected]
      if (!factory) {
        setError(t('advanced.unbindUnavailable'))
        return
      }
      const entries: (KeymapEntry | null)[] = keys.map((k) =>
        k.index === selected ? { binding: factory.binding } : null,
      )
      const result = await codec.writeKeymap(link, layer, entries)
      if (result.mismatched.length > 0) {
        setMismatch(
          t('advanced.keymapMismatch', {
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
        return
      }
      const shared = snapshot.uses.some(
        (u) => u.record === pickedUse.record && !(u.layer === layer && u.slot === pickedUse.slot),
      )
      if (!shared && codec.writeAdvancedKey) {
        await codec.writeAdvancedKey(link, pickedUse.record, emptyAdvancedRecord(pickedUse.kind))
      }
      setDraft(null)
      await read()
      setStatus(
        shared
          ? t('advanced.unboundShared', { record: pickedUse.record })
          : t('advanced.unbound', { record: pickedUse.record }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /*
   * The input-point tab's band with both multi-select gestures off, the same
   * as the remap tab: an advanced key is bound to one cap, so "select all"
   * would offer a set nothing on this tab can act on.
   */
  const grid = (
    <GridFrame selectable={false} marquee={false}>
      <KeyGrid
        selected={selected === null ? undefined : new Set([selected])}
        onSelect={(index) => {
          setSelected(index)
          setDraft(null)
        }}
        sub={(key) => {
          const u = useByKey.get(key.index)
          return u ? t(kindKey(u.kind)) : undefined
        }}
        label={(key) => {
          const u = useByKey.get(key.index)
          // `undefined`, not `''`: a key with no advanced record has nothing
          // this tab wants to say about it, so it keeps the legend the rest of
          // the app gives it rather than being blanked.
          return u ? t('advanced.capLabel', { kind: t(kindKey(u.kind)), record: u.record }) : undefined
        }}
      />
    </GridFrame>
  )

  if (!canRead) {
    return (
      <>
        {grid}
        <Panel title={t('advanced.title')}>
          <NotDecoded what="advanced.what" />
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="advanced.note" />
          </div>
        </Panel>
      </>
    )
  }

  /*
   * The same layer strip the remap tab draws, and for the same reason: which
   * key runs an advanced key is a keymap entry, so it is per layer even though
   * the records themselves are one global set.
   */
  const tabs: SubTab[] = Array.from({ length: spec.keymap.layers }, (_, i) => ({
    id: String(i),
    labelKey: i === 0 ? ('keymap.layer.main' as const) : ('keymap.layer.fn1' as const),
    ...(i > 1 && { label: `FN${i}` }),
    render: () => null,
  }))

  return (
    <>
      {grid}
      <SubTabs
        tabs={tabs}
        label={t('advanced.layers')}
        active={String(layer)}
        onActive={(id) => {
          setLayer(Number(id))
          setDraft(null)
        }}
      />

      <Panel title={t('advanced.title')}>
        <Notice kind="warn">
          <T k="advanced.unverified" />
        </Notice>

        {!pickedKey && (
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="advanced.pickKey" />
          </div>
        )}

        {pickedKey && (
          <div style={{ marginTop: 8 }}>
            <Row label={t('advanced.key')}>
              <strong>{pickedKey.label}</strong>
            </Row>
            <Row label={t('advanced.kind')}>
              <Select
                label={t('advanced.kind')}
                value={current?.kind ?? ''}
                disabled={busy !== null || !canWrite}
                options={[
                  { value: '', label: t('advanced.kindNone') },
                  ...ADVANCED_KINDS.map((k) => ({ value: k, label: t(kindKey(k)) })),
                ]}
                onChange={(v) => {
                  // Choosing "none" only drops a draft. Taking an advanced key
                  // off a cap the board already holds is two writes, so it is
                  // the button below rather than a silent effect of a dropdown.
                  if (!v) setDraft(null)
                  else if (v !== current?.kind) create(v as AdvancedKind)
                }}
              />
            </Row>
            {current && (
              <>
                <Row label={t('advanced.record')}>
                  <span className="small">
                    #{current.record} · <code>{recordBytes(current)}</code>
                  </span>
                </Row>
                <Editor
                  draft={current}
                  disabled={busy !== null || !canWrite}
                  onChange={(rec, param) => edit({ rec, param })}
                />
                <div className="row" style={{ marginTop: 10 }}>
                  <button disabled={busy !== null || !canWrite} onClick={() => void apply()}>
                    {busy === 'write' ? t('advanced.applying') : t('advanced.apply')}
                  </button>
                  {draft && (
                    <button
                      className="ghost"
                      disabled={busy !== null}
                      onClick={() => setDraft(null)}
                    >
                      {t('advanced.revert')}
                    </button>
                  )}
                  {pickedUse && (
                    <button
                      className="ghost"
                      disabled={busy !== null || !canUnbind}
                      onClick={() => void unbind()}
                    >
                      {t('advanced.unbind')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {status && <Notice kind="ok">{status}</Notice>}
        {mismatch && <Notice kind="err">{mismatch}</Notice>}
        {error && <Notice kind="err">{error}</Notice>}
      </Panel>

      <Panel title={t('advanced.inUse')}>
        {uses.length === 0 ? (
          <div className="small dim">
            <T k="advanced.noneBound" />
          </div>
        ) : (
          <table className="small" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>{t('advanced.key')}</th>
                <th>{t('advanced.kind')}</th>
                <th>{t('advanced.record')}</th>
                <th>{t('advanced.param')}</th>
                <th>{t('advanced.bytes')}</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((u) => (
                <tr key={`${u.layer}:${u.slot}`}>
                  <td>{u.label || t('advanced.unmappedSlot', { slot: u.slot })}</td>
                  <td>{t(kindKey(u.kind))}</td>
                  <td>#{u.record}</td>
                  <td>{paramLabel(t, u)}</td>
                  <td>
                    <code>
                      {snapshot ? recordHex(blobOf(snapshot, u.kind), u.record, u.kind) : ''}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {snapshot && snapshot.orphans.length > 0 && (
          <Notice kind="info">
            {t('advanced.orphans', { records: snapshot.orphans.map((r) => `#${r}`).join(', ') })}
          </Notice>
        )}
      </Panel>
    </>
  )
}

function blobOf(snapshot: AdvancedKeySnapshot, kind: AdvancedKind): Uint8Array {
  if (kind === 'dks') return snapshot.blobs.dks
  if (kind === 'tgl') return snapshot.blobs.toggle
  return snapshot.blobs.pair
}

/**
 * The bytes the apply button would send, through the same encoder it uses.
 *
 * Not a second rendering of the draft: a DKS stage mask is derived from the
 * span, so a display that rebuilt the bytes its own way could show one thing
 * and write another.
 */
function recordBytes(draft: Draft): string {
  return Array.from(encodeAdvancedRecord(draft.rec), (b) => b.toString(16).padStart(2, '0')).join(
    ' ',
  )
}

function kindKey(kind: AdvancedKind) {
  return `advanced.kinds.${kind}` as const
}

function paramLabel(t: ReturnType<typeof useT>, u: AdvancedKeyUse): string {
  if (u.kind === 'mt') return t('advanced.holdMs', { ms: u.param * MT_HOLD_MS_PER_UNIT })
  if (PAIRED_KINDS.includes(u.kind)) return t('advanced.partnerSlot', { slot: u.param })
  return '—'
}

/** The per-kind fields. One component because they share the draft's shape. */
function Editor({
  draft,
  disabled,
  onChange,
}: {
  draft: Draft
  disabled: boolean
  onChange: (rec: AdvancedRecord, param: number) => void
}) {
  const t = useT()
  const spec = useDeviceSpec()
  const countsPerMm = spec.encoding.countsPerMm

  if (draft.rec.kind === 'dks') {
    const rec = draft.rec
    return (
      <>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="advanced.dks.help" />
        </div>
        {Array.from({ length: DKS_STAGES }, (_, i) => (
          <Row key={i} label={t(DKS_POINT_KEYS[i] ?? DKS_POINT_KEYS[0])}>
            <Slider
              min={0}
              max={dksMmToSteps(DKS_MAX_MM, countsPerMm)}
              step={1}
              disabled={disabled}
              value={rec.thresholds[i] ?? 0}
              onChange={(e) => {
                const thresholds = rec.thresholds.slice()
                thresholds[i] = Number(e.target.value)
                onChange({ ...rec, thresholds }, draft.param)
              }}
            />
            <span className="small">
              {dksStepsToMm(rec.thresholds[i] ?? 0, countsPerMm).toFixed(1)} mm
            </span>
          </Row>
        ))}
        {Array.from({ length: DKS_BINDINGS }, (_, i) => {
          const span = rec.spans[i]
          if (!span) return null
          /*
           * The mask is recomputed here rather than left to the encoder alone,
           * so the draft carries the bytes it will be written as — the hex line
           * above reads it, and a stale mask would make that line a lie.
           */
          const setSpan = (next: Partial<typeof span>) => {
            const merged = { ...span, ...next }
            const spans = rec.spans.slice()
            spans[i] = {
              ...merged,
              mask:
                merged.binding.kind === 'none'
                  ? 0
                  : encodeDksSpan(merged.pressAt, merged.releaseAt),
            }
            onChange({ ...rec, spans }, draft.param)
          }
          return (
            <Row key={`b${i}`} label={t('advanced.dks.binding', { n: i + 1 })}>
              <BindingSelect
                label={t('advanced.dks.binding', { n: i + 1 })}
                value={span.binding}
                disabled={disabled}
                onChange={(binding) => setSpan({ binding })}
              />
              <Select
                label={t('advanced.dks.pressAt')}
                value={String(span.pressAt)}
                disabled={disabled}
                options={stageOptions(t)}
                onChange={(v) => setSpan({ pressAt: Number(v) })}
              />
              <Select
                label={t('advanced.dks.releaseAt')}
                value={String(span.releaseAt)}
                disabled={disabled}
                options={stageOptions(t)}
                onChange={(v) => setSpan({ releaseAt: Number(v) })}
              />
            </Row>
          )
        })}
      </>
    )
  }

  if (draft.rec.kind === 'tgl') {
    const rec: ToggleRecord = draft.rec
    return (
      <>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="advanced.tgl.help" />
        </div>
        <Row label={t('advanced.tgl.key')}>
          <BindingSelect
            label={t('advanced.tgl.key')}
            value={rec.binding}
            disabled={disabled}
            onChange={(binding) => onChange({ ...rec, binding }, draft.param)}
          />
        </Row>
      </>
    )
  }

  const rec: PairRecord = draft.rec

  if (rec.kind === 'mt') {
    const { tap, hold } = mtBindings(rec)
    return (
      <>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="advanced.mt.help" />
        </div>
        <Row label={t('advanced.mt.tap')}>
          <BindingSelect
            label={t('advanced.mt.tap')}
            value={tap}
            disabled={disabled}
            onChange={(b) => onChange(withMtBindings(rec, b, hold), draft.param)}
          />
        </Row>
        <Row label={t('advanced.mt.hold')}>
          <BindingSelect
            label={t('advanced.mt.hold')}
            value={hold}
            disabled={disabled}
            onChange={(b) => onChange(withMtBindings(rec, tap, b), draft.param)}
          />
        </Row>
        <Row label={t('advanced.mt.time')}>
          <input
            type="number"
            min={MT_HOLD_MS_PER_UNIT}
            max={0xff * MT_HOLD_MS_PER_UNIT}
            step={MT_HOLD_MS_PER_UNIT}
            disabled={disabled}
            value={draft.param * MT_HOLD_MS_PER_UNIT}
            onChange={(e) =>
              onChange(rec, Math.round(Number(e.target.value) / MT_HOLD_MS_PER_UNIT) & 0xff)
            }
          />
          <span className="small dim">ms</span>
        </Row>
      </>
    )
  }

  const { own, partner } = pairUsages(rec)
  const oks = oksBindings(rec)
  return (
    <>
      <div className="small dim" style={{ marginTop: 8 }}>
        <T k={`advanced.${rec.kind}.help` as const} />
      </div>
      <Row label={t('advanced.pair.own')}>
        <UsageSelect
          label={t('advanced.pair.own')}
          value={rec.kind === 'oks' ? oks.own : own}
          disabled={disabled}
          onChange={(usage) =>
            onChange(
              rec.kind === 'oks'
                ? withOksBindings(rec, usage, oks.onRelease, oks.holdTicks)
                : withPairUsages(rec, usage, partner),
              draft.param,
            )
          }
        />
      </Row>
      <Row label={t(rec.kind === 'oks' ? 'advanced.oks.onRelease' : 'advanced.pair.partner')}>
        <UsageSelect
          label={t(rec.kind === 'oks' ? 'advanced.oks.onRelease' : 'advanced.pair.partner')}
          value={rec.kind === 'oks' ? oks.onRelease : partner}
          disabled={disabled}
          onChange={(usage) =>
            onChange(
              rec.kind === 'oks'
                ? withOksBindings(rec, oks.own, usage, oks.holdTicks)
                : withPairUsages(rec, own, usage),
              draft.param,
            )
          }
        />
      </Row>
      <Row label={t('advanced.pair.partnerSlot')}>
        <input
          type="number"
          min={0}
          max={spec.keymap.slots - 1}
          disabled={disabled}
          value={draft.param}
          onChange={(e) => onChange(rec, Number(e.target.value) & 0xff)}
        />
        <span className="small dim">
          <T k="advanced.pair.partnerSlotNote" />
        </span>
      </Row>
      {rec.kind === 'socd' && (
        <Notice kind="info">
          <T k="advanced.socd.modeNote" />
        </Notice>
      )}
    </>
  )
}

function stageOptions(t: ReturnType<typeof useT>): SelectOption[] {
  return Array.from({ length: DKS_STAGES }, (_, i) => ({
    value: String(i),
    label: t(DKS_STAGE_KEYS[i] ?? DKS_STAGE_KEYS[0]),
  }))
}
