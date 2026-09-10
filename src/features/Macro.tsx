import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeviceSpec, useLayout } from '../device/active'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { usageForCode } from '../keyboard/hostKeys'
import { KEYCODES, keycodeDefLabel, keycodeLabel } from '../keyboard/keycodes'
import { supports } from '../protocol/codec'
import { MODIFIERS, type KeyBinding } from '../protocol/keymap'
import {
  MACRO_MAX_DELAY_MS,
  eventForUsage,
  isMacroEmpty,
  MACRO_STOCK,
  macroEventCapacity,
  macroSlotsExposed,
  macroEventHex,
  macroEventsUsed,
  overStockBudget,
  modifierMaskLabel,
  repeatEvents,
  tapEvents,
  withMacro,
  type Macro as MacroBody,
  type MacroEvent,
} from '../protocol/macros'
import type { KeymapEntry, MacroSnapshot, MacroUse } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { macroNames, useMacroNames } from '../state/macroNames'
import { useSettings } from '../state/settings'
import { GridFrame } from '../ui/GridFrame'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { Select, type SelectOption } from '../ui/Select'
import { SubTabs, type SubTab } from '../ui/SubTabs'

/**
 * Macros — the 32-slot store at flash 0x21100, and the keys that start one.
 *
 * `protocol/macros.ts` is the format and the evidence; this is the screen, and
 * three things about it are decided by the format rather than by taste.
 *
 * ### The store is written whole, so "apply" writes every slot
 *
 * There is no per-slot write and there cannot be one: the offset table indexes
 * all 32 bodies, so a body that changes length moves the offsets of the ones
 * after it. The panel therefore edits a copy of the whole store and applies it
 * in one go. What the status line names is the slots that actually changed,
 * because "wrote 4 KB" is true and useless.
 *
 * ### Binding is the second write, and never the first
 *
 * A body nothing points at does nothing; a key pointing at a body that does not
 * stop makes the board type the contents of its own flash — the player has no
 * bound on its cursor (see the module header). So the order is fixed: the store
 * goes out, and only then the keymap entry. That is also why the remap tab does
 * **not** offer macros in its picker even though the record type is decoded and
 * a bound macro shows up there by name: binding from a tab that cannot check
 * the store would be the one path around this rule.
 *
 * ### The repeat count is shown and not offered
 *
 * The keymap record's third byte is a repeat count the firmware stores and
 * never reads. Offering a control for it would be offering a setting that does
 * nothing, so the panel writes the stock driver's 1, reports whatever a slot
 * already holds, and gives the repeat that does work: more records in the body,
 * which is what "repeat" below does.
 *
 * Nothing on this tab is confirmed on hardware. Every write is read back and
 * compared, the same as everywhere else here, and that proves the bytes are in
 * the store — not that the board plays them.
 */

/** Delay a hand-added tap holds the key for, and the gap it leaves after. */
const DEFAULT_HOLD_MS = 20
const DEFAULT_GAP_MS = 40

/** What a recorded pause is rounded to, so an event list stays readable. */
const RECORD_ROUND_MS = 5

type Busy = null | 'read' | 'write' | 'bind'

/** Every plain usage, plus the eight modifiers as themselves. */
function usageOptions(): SelectOption[] {
  const out: SelectOption[] = []
  for (const def of KEYCODES) out.push({ value: String(def.code), label: keycodeDefLabel(def) })
  return out
}

const USAGES = usageOptions()

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

/**
 * What one event reads as.
 *
 * `unknown` is handled by the caller rather than here, because the only honest
 * label for it is its two bytes and that needs a translated string.
 */
function eventLabel(event: MacroEvent): string {
  switch (event.action.kind) {
    case 'key':
      return keycodeLabel(event.action.usage)
    case 'modifiers':
      return modifierMaskLabel(event.action.mask) || '—'
    case 'unknown':
      return '?'
  }
}

export function Macro() {
  const t = useT()
  const codec = useCodec()
  const spec = useDeviceSpec()
  const { keys } = useLayout()
  const { connected } = useConnection()
  const names = useMacroNames()

  const canRead = supports(codec, 'readMacros')
  const canWrite = supports(codec, 'writeMacros')
  const canBind = canWrite && supports(codec, 'writeKeymap')
  /** Unbinding puts the cap back to the board's own factory record. */
  const canUnbind = canBind && supports(codec, 'readKeymapDefaults')

  const { debug } = useSettings()
  const [layer, setLayer] = useState(0)
  const [slot, setSlot] = useState(0)
  const [selectedKey, setSelectedKey] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<MacroSnapshot | null>(null)
  /** The whole store as edited. Null until a read, then always the full 32. */
  const [draft, setDraft] = useState<MacroBody[] | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)

  // Editor controls that are not part of the store.
  const [addUsage, setAddUsage] = useState(KEYCODES[0]?.code ?? 4)
  const [holdMs, setHoldMs] = useState(DEFAULT_HOLD_MS)
  const [gapMs, setGapMs] = useState(DEFAULT_GAP_MS)
  const [repeatTimes, setRepeatTimes] = useState(2)
  const [repeatGapMs, setRepeatGapMs] = useState(100)
  const [fixedDelayMs, setFixedDelayMs] = useState(0)
  const [recording, setRecording] = useState(false)

  const inFlight = useRef(false)

  const read = useCallback(async () => {
    if (!codec.readMacros) return
    inFlight.current = true
    setBusy('read')
    setError(null)
    setMismatch(null)
    try {
      const next = await codec.readMacros(link)
      setSnapshot(next)
      setDraft(next.macros.map((m) => ({ ...m, events: [...m.events] })))
      setStatus(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [codec])

  /*
   * Opening the tab reads, and a failure is not retried — the same rule the
   * remap and advanced-key tabs follow. Leaving the tab and coming back is the
   * retry; without that, a board answering nothing would be asked once per
   * render.
   */
  useEffect(() => {
    if (!connected || !canRead || inFlight.current || snapshot) return
    void read()
  }, [connected, canRead, read, snapshot])

  const current = draft?.[slot] ?? null
  const capacity = macroEventCapacity(spec.macros)
  const used = draft ? macroEventsUsed(draft, spec.macros) : 0
  // Not a limit — the block holds more and the firmware would take more still.
  // It is where the store stops being one the stock driver's recorder budgets
  // for, which matters to anyone who still uses it (see protocol/macros.ts).
  const overStock = draft ? overStockBudget(draft, spec.macros) : false
  // Ten by default and all 32 in debug mode. Not a board limit — see
  // `macroSlotsExposed`. A slot past the tenth still gets written, terminated
  // and read back like any other; what it does not get is a stock driver that
  // knows it exists.
  const exposed = macroSlotsExposed(debug, spec.macros)

  const editSlot = (events: MacroEvent[]) => {
    if (!draft || !current) return
    setDraft(withMacro(draft, { ...current, events, programmed: true, terminated: true }))
    setStatus(null)
  }

  // --- recording -----------------------------------------------------------

  /**
   * Records what the reader types, with the pauses between keystrokes.
   *
   * A record's delay is the pause that *follows* it, so a key event closes the
   * previous event rather than opening its own: the gap measured between two
   * keystrokes belongs to the earlier one. The last event of a pass keeps a
   * delay of 0, because there is nothing after it to wait for.
   *
   * `preventDefault` on every event, and `keydown` capture on the window:
   * recording Ctrl+W has to not close the tab, and Tab has to not move the
   * focus out of the panel. Auto-repeat is dropped — the board has no concept
   * of it and a held key would otherwise fill the store.
   */
  useEffect(() => {
    if (!recording || !current) return
    let last = performance.now()
    const events: MacroEvent[] = [...current.events]

    const push = (usage: number, press: boolean) => {
      const now = performance.now()
      const gap = Math.min(
        MACRO_MAX_DELAY_MS,
        Math.round((now - last) / RECORD_ROUND_MS) * RECORD_ROUND_MS,
      )
      last = now
      const previous = events[events.length - 1]
      if (previous) events[events.length - 1] = { ...previous, delayMs: gap }
      events.push(eventForUsage(usage, press, 0))
      editSlot([...events])
    }

    const onDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.repeat) return
      const usage = usageForCode(e.code)
      if (usage !== undefined) push(usage, true)
    }
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault()
      const usage = usageForCode(e.code)
      if (usage !== undefined) push(usage, false)
    }
    window.addEventListener('keydown', onDown, { capture: true })
    window.addEventListener('keyup', onUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true })
      window.removeEventListener('keyup', onUp, { capture: true })
    }
    /*
     * `current` is deliberately not a dependency, and this is the one place in
     * the app that leaves one out on purpose. The listeners hold their own copy
     * of the event list and their own clock; re-attaching them on every
     * keystroke would reset that clock, and every pause would measure as zero.
     *
     * Nothing else can change the slot's events while this is running — every
     * control that edits them, the slot picker included, is disabled while
     * recording — so the copy cannot go stale under it.
     */
  }, [recording])

  // --- writing -------------------------------------------------------------

  /**
   * Writes the store, then — if a cap is picked and not already bound to this
   * slot — the keymap entry that starts it.
   *
   * Always in that order, and the keymap write is skipped entirely when the
   * store write reported a mismatch. A key pointing at a body the board did not
   * accept is the one outcome worth refusing outright.
   */
  const apply = async () => {
    if (!draft || !codec.writeMacros) return
    // Refused here rather than left to `encodeMacros` to throw. Its error
    // carries the numbers but not a translated sentence, and this is a state
    // the panel can see coming — the notice under the button is already up.
    if (used > capacity) {
      setError(t('macro.capacityFull', { used, total: capacity }))
      return
    }
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const written = await codec.writeMacros(link, draft)
      if (written.mismatch.length > 0) {
        setMismatch(
          t('macro.mismatch', {
            detail: written.mismatch
              .map((m) => `#${m.slot} ${m.wanted} → ${m.got}`)
              .join(' · '),
          }),
        )
        return
      }
      await read()
      setStatus(
        written.sent
          ? t('macro.applied', {
              slots: written.changed.length,
              total: spec.macros.slots,
              bytes: written.bytes,
            })
          : t('macro.unchanged'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Points the selected cap at the selected slot.
   *
   * Refuses while the store on the board is not canonical, rather than writing
   * the store itself: an implicit 4 KB write behind a button labelled "bind" is
   * not what the button says, and the store button is right there. `repeat` goes
   * out as 1 — the byte the firmware never reads (see the header).
   */
  const bind = async () => {
    if (!snapshot || !codec.writeKeymap || selectedKey === null) return
    if (!snapshot.canonical) {
      setError(t('macro.bindNeedsStore'))
      return
    }
    setBusy('bind')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const binding: KeyBinding = { kind: 'macro', slot, repeat: 1 }
      const entries: (KeymapEntry | null)[] = keys.map((k) =>
        k.index === selectedKey ? { binding } : null,
      )
      const result = await codec.writeKeymap(link, layer, entries)
      if (result.mismatched.length > 0) {
        setMismatch(
          t('macro.keymapMismatch', {
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
        return
      }
      const label = keys.find((k) => k.index === selectedKey)?.label ?? ''
      await read()
      setStatus(t('macro.bound', { slot, key: label }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Takes the macro off the selected cap.
   *
   * The factory record comes from the board (0x07) rather than from this app's
   * idea of the default, the same as the advanced-key tab: the two agree on the
   * base layer and this app has no opinion at all about the Fn one. The body is
   * left in the store — it is 32 slots of shared storage, and clearing one
   * because a key stopped pointing at it would lose a macro the user still has.
   */
  const unbind = async () => {
    if (!codec.writeKeymap || !codec.readKeymapDefaults || selectedKey === null) return
    setBusy('bind')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const table = await codec.readKeymapDefaults(link, layer)
      const factory = table[selectedKey]
      if (!factory) {
        setError(t('macro.unbindUnavailable'))
        return
      }
      const entries: (KeymapEntry | null)[] = keys.map((k) =>
        k.index === selectedKey ? { binding: factory.binding } : null,
      )
      const result = await codec.writeKeymap(link, layer, entries)
      if (result.mismatched.length > 0) {
        setMismatch(
          t('macro.keymapMismatch', {
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
        return
      }
      const label = keys.find((k) => k.index === selectedKey)?.label ?? ''
      await read()
      setStatus(t('macro.unbound', { key: label }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // --- the grid ------------------------------------------------------------

  const uses = snapshot?.uses.filter((u) => u.layer === layer) ?? []
  const useByKey = new Map<number, MacroUse>()
  for (const u of uses) if (u.index >= 0) useByKey.set(u.index, u)

  const grid = (
    // Collapsible here and nowhere else: the grid picks the one cap a macro
    // is bound to, and everything below it — the recording, the store, the
    // event list — is longer than the window. See ui/GridFrame.tsx.
    <GridFrame selectable={false} marquee={false} collapsible>
      <KeyGrid
        selected={selectedKey === null ? undefined : new Set([selectedKey])}
        onSelect={(index) => setSelectedKey(index)}
        sub={(key) => {
          const u = useByKey.get(key.index)
          return u ? `M${u.macro}` : undefined
        }}
        label={(key) => {
          const u = useByKey.get(key.index)
          // `undefined` rather than `''`: a key with no macro keeps whatever
          // legend the rest of the app gives it.
          return u ? t('macro.capLabel', { slot: u.macro }) : undefined
        }}
      />
    </GridFrame>
  )

  if (!canRead) {
    return (
      <>
        {grid}
        <Panel title={t('macro.title')}>
          <NotDecoded what="macro.what" />
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="macro.note" />
          </div>
        </Panel>
      </>
    )
  }

  const tabs: SubTab[] = Array.from({ length: spec.keymap.layers }, (_, i) => ({
    id: String(i),
    labelKey: i === 0 ? ('keymap.layer.main' as const) : ('keymap.layer.fn1' as const),
    ...(i > 1 && { label: `FN${i}` }),
    render: () => null,
  }))

  const slotOptions: SelectOption[] = Array.from({ length: exposed }, (_, i) => {
    const name = names[`${spec.id}/${i}`]
    const count = draft?.[i]?.events.length ?? 0
    return {
      value: String(i),
      label: name
        ? t('macro.slotNamed', { slot: i, name, count })
        : t('macro.slotPlain', { slot: i, count }),
    }
  })

  const pickedKey = selectedKey === null ? undefined : keys.find((k) => k.index === selectedKey)
  const pickedUse = selectedKey === null ? undefined : useByKey.get(selectedKey)

  return (
    <>
      {grid}
      <SubTabs
        tabs={tabs}
        label={t('macro.layers')}
        active={String(layer)}
        onActive={(id) => setLayer(Number(id))}
      />

      <Panel title={t('macro.store')}>
        <Notice kind="warn">
          <T k="macro.unverified" />
        </Notice>
        {snapshot && !snapshot.canonical && (
          <Notice kind="err">
            <T k="macro.storeUnsafe" params={{ slots: snapshot.malformed.length }} />
          </Notice>
        )}
        {snapshot?.canonical && (
          <Notice kind="ok">
            <T k="macro.storeReady" />
          </Notice>
        )}
        {overStock && (
          <Notice kind="warn">
            <T k="macro.overStock" params={{ total: MACRO_STOCK.events }} />
          </Notice>
        )}
        <div className="small dim" style={{ marginTop: 8 }}>
          {t('macro.capacity', { used, total: capacity })}
        </div>
        <div className="small dim" style={{ marginTop: 4 }}>
          {t('macro.slotNumbering', { shown: exposed, total: spec.macros.slots })}
        </div>
        {debug && exposed > MACRO_STOCK.slots && (
          <Notice kind="warn">
            <T k="macro.slotsUnlocked" params={{ stock: MACRO_STOCK.slots, total: exposed }} />
          </Notice>
        )}
      </Panel>

      <Panel title={t('macro.title')}>
        <Row label={t('macro.slot')}>
          <Select
            label={t('macro.slot')}
            value={String(slot)}
            options={slotOptions}
            disabled={busy !== null || recording}
            onChange={(v) => setSlot(Number(v))}
          />
        </Row>
        <Row label={t('macro.name')}>
          <input
            type="text"
            value={names[`${spec.id}/${slot}`] ?? ''}
            placeholder={t('macro.namePlaceholder', { slot })}
            disabled={busy !== null}
            onChange={(e) => macroNames.set(spec.id, slot, e.target.value)}
          />
        </Row>
        <div className="small dim">
          <T k="macro.nameNote" />
        </div>
      </Panel>

      <Panel title={t('macro.events')}>
        {snapshot?.macros[slot]?.aliasOf !== undefined && (
          <Notice kind="warn">
            <T
              k="macro.aliasOf"
              params={{ slot, owner: snapshot!.macros[slot]!.aliasOf! }}
            />
          </Notice>
        )}
        {!current || isMacroEmpty(current) ? (
          <div className="small dim">
            <T k="macro.noEvents" />
          </div>
        ) : (
          <table className="small" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('macro.eventKey')}</th>
                <th>{t('macro.eventDir')}</th>
                <th>{t('macro.delayMs')}</th>
                <th>{t('macro.hex')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {current.events.map((event, i) => (
                <tr key={i}>
                  <td className="dim">{i + 1}</td>
                  <td>
                    {event.action.kind === 'unknown'
                      ? t('macro.eventUnknown', {
                          nibble: event.action.nibble,
                          value: event.action.value,
                        })
                      : eventLabel(event)}
                  </td>
                  <td>{event.press ? t('macro.down') : t('macro.up')}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={MACRO_MAX_DELAY_MS}
                      value={event.delayMs}
                      disabled={busy !== null || recording || !canWrite}
                      style={{ width: '5.5rem' }}
                      onChange={(e) => {
                        const next = [...current.events]
                        next[i] = { ...event, delayMs: Number(e.target.value) || 0 }
                        editSlot(next)
                      }}
                    />
                  </td>
                  <td>
                    <code>{macroEventHex(event)}</code>
                  </td>
                  <td>
                    <button
                      className="ghost"
                      disabled={busy !== null || recording || !canWrite}
                      onClick={() => editSlot(current.events.filter((_, j) => j !== i))}
                    >
                      {t('macro.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <button
            disabled={busy !== null || !canWrite || !current}
            onClick={() => setRecording((on) => !on)}
          >
            {recording ? t('macro.recordStop') : t('macro.record')}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || recording || !canWrite || !current}
            onClick={() => editSlot([])}
          >
            {t('macro.clear')}
          </button>
        </div>
        {recording && (
          <Notice kind="info">
            <T k="macro.recordingNow" />
          </Notice>
        )}
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="macro.recordNote" />
        </div>
      </Panel>

      <Panel title={t('macro.addTitle')}>
        <Row label={t('macro.addKey')}>
          <Select
            label={t('macro.addKey')}
            value={String(addUsage)}
            options={USAGES}
            disabled={busy !== null || recording || !canWrite}
            onChange={(v) => setAddUsage(Number(v))}
          />
        </Row>
        <Row label={t('macro.holdMs')}>
          <input
            type="number"
            min={0}
            max={MACRO_MAX_DELAY_MS}
            value={holdMs}
            disabled={busy !== null || recording || !canWrite}
            style={{ width: '5.5rem' }}
            onChange={(e) => setHoldMs(Number(e.target.value) || 0)}
          />
        </Row>
        <Row label={t('macro.gapMs')}>
          <input
            type="number"
            min={0}
            max={MACRO_MAX_DELAY_MS}
            value={gapMs}
            disabled={busy !== null || recording || !canWrite}
            style={{ width: '5.5rem' }}
            onChange={(e) => setGapMs(Number(e.target.value) || 0)}
          />
        </Row>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            disabled={busy !== null || recording || !canWrite || !current}
            onClick={() =>
              current && editSlot([...current.events, ...tapEvents(addUsage, holdMs, gapMs)])
            }
          >
            {t('macro.addTap')}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || recording || !canWrite || !current}
            onClick={() =>
              current &&
              editSlot([...current.events, eventForUsage(addUsage, true, holdMs)])
            }
          >
            {t('macro.addDown')}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || recording || !canWrite || !current}
            onClick={() =>
              current && editSlot([...current.events, eventForUsage(addUsage, false, gapMs)])
            }
          >
            {t('macro.addUp')}
          </button>
        </div>
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="macro.modifierNote" params={{ mods: MODIFIERS.map((m) => m.label).join(', ') }} />
        </div>
      </Panel>

      <Panel title={t('macro.tools')}>
        <Row label={t('macro.repeatTimes')}>
          <input
            type="number"
            min={1}
            max={64}
            value={repeatTimes}
            disabled={busy !== null || recording || !canWrite}
            style={{ width: '5.5rem' }}
            onChange={(e) => setRepeatTimes(Number(e.target.value) || 1)}
          />
        </Row>
        <Row label={t('macro.repeatGap')}>
          <input
            type="number"
            min={0}
            max={MACRO_MAX_DELAY_MS}
            value={repeatGapMs}
            disabled={busy !== null || recording || !canWrite}
            style={{ width: '5.5rem' }}
            onChange={(e) => setRepeatGapMs(Number(e.target.value) || 0)}
          />
        </Row>
        <Row label={t('macro.fixedDelay')}>
          <input
            type="number"
            min={0}
            max={MACRO_MAX_DELAY_MS}
            value={fixedDelayMs}
            disabled={busy !== null || recording || !canWrite}
            style={{ width: '5.5rem' }}
            onChange={(e) => setFixedDelayMs(Number(e.target.value) || 0)}
          />
        </Row>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="ghost"
            disabled={busy !== null || recording || !canWrite || !current || isMacroEmpty(current)}
            onClick={() =>
              current && editSlot(repeatEvents(current.events, repeatTimes, repeatGapMs))
            }
          >
            {t('macro.repeatApply')}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || recording || !canWrite || !current || isMacroEmpty(current)}
            onClick={() =>
              current &&
              editSlot(current.events.map((e) => ({ ...e, delayMs: fixedDelayMs })))
            }
          >
            {t('macro.flattenApply')}
          </button>
        </div>
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="macro.repeatNote" />
        </div>
      </Panel>

      <Panel title={t('macro.applyTitle')}>
        <div className="row">
          <button
            disabled={busy !== null || recording || !canWrite || used > capacity}
            onClick={() => void apply()}
          >
            {busy === 'write' ? t('macro.applying') : t('macro.apply')}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || recording}
            onClick={() => {
              if (snapshot) setDraft(snapshot.macros.map((m) => ({ ...m, events: [...m.events] })))
              setStatus(null)
            }}
          >
            {t('macro.revert')}
          </button>
        </div>
        {used > capacity && (
          <Notice kind="err">
            <T k="macro.capacityFull" params={{ used, total: capacity }} />
          </Notice>
        )}
        {status && <Notice kind="ok">{status}</Notice>}
        {mismatch && <Notice kind="err">{mismatch}</Notice>}
        {error && <Notice kind="err">{error}</Notice>}
      </Panel>

      <Panel title={t('macro.bindTitle')}>
        {!pickedKey ? (
          <div className="small dim">
            <T k="macro.pickKey" />
          </div>
        ) : (
          <>
            <Row label={t('macro.key')}>
              <strong>{pickedKey.label}</strong>
            </Row>
            {pickedUse && (
              <Row label={t('macro.boundTo')}>
                <span className="small">
                  {t('macro.slotPlain', {
                    slot: pickedUse.macro,
                    count: draft?.[pickedUse.macro]?.events.length ?? 0,
                  })}
                  {pickedUse.repeat !== 1 && ` · ${t('macro.repeatByte', { n: pickedUse.repeat })}`}
                </span>
              </Row>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button
                disabled={busy !== null || recording || !canBind || !snapshot?.canonical}
                onClick={() => void bind()}
              >
                {busy === 'bind' ? t('macro.binding') : t('macro.bind', { slot })}
              </button>
              {pickedUse && (
                <button
                  className="ghost"
                  disabled={busy !== null || recording || !canUnbind}
                  onClick={() => void unbind()}
                >
                  {t('macro.unbind')}
                </button>
              )}
            </div>
          </>
        )}
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="macro.bindNote" />
        </div>
      </Panel>

      <Panel title={t('macro.inUse')}>
        {uses.length === 0 ? (
          <div className="small dim">
            <T k="macro.noneBound" />
          </div>
        ) : (
          <table className="small" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>{t('macro.key')}</th>
                <th>{t('macro.slot')}</th>
                <th>{t('macro.eventCount')}</th>
                <th>{t('macro.repeatColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((u) => (
                <tr key={`${u.layer}:${u.slot}`}>
                  <td>{u.label || `#${u.slot}`}</td>
                  <td>
                    {names[`${spec.id}/${u.macro}`]
                      ? t('macro.slotNamed', {
                          slot: u.macro,
                          name: names[`${spec.id}/${u.macro}`]!,
                          count: draft?.[u.macro]?.events.length ?? 0,
                        })
                      : `#${u.macro}`}
                  </td>
                  <td>{draft?.[u.macro]?.events.length ?? 0}</td>
                  <td className="dim">{u.repeat}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="macro.repeatByteNote" />
        </div>
      </Panel>
    </>
  )
}
