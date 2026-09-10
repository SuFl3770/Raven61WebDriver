import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { KEYBOARD_ROWS, keycodeLabel } from '../keyboard/keycodes'
import { useDeviceSpec, useLayout } from '../device/active'
import type { KeyDef } from '../device/spec'
import { supports } from '../protocol/codec'
import {
  BINDING_GROUPS,
  MODIFIERS,
  RECORD_TYPE,
  bindingGroups,
  bindingLabel,
  decodeRecord,
  encodeRecord,
  factoryBinding,
  sameBinding,
  type KeyBinding,
} from '../protocol/keymap'
import type { KeymapEntry } from '../protocol/types'
import { legends } from '../state/legends'
import { link, useCodec, useConnection } from '../state/link'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { GridFrame } from '../ui/GridFrame'
import { SubTabs, type SubTab } from '../ui/SubTabs'

/**
 * Remapping — the stock driver's "Remap" tab, against the live keymap.
 *
 * What the board stores is three bytes per key per layer, and they hold a good
 * deal more than a HID usage: mouse buttons, consumer keys, macros, advanced
 * keys and firmware actions all live in the same record. The picker below is
 * the stock driver's own catalog of those, recovered from its list builder —
 * see protocol/keymap.ts for where each entry's value comes from.
 *
 * The page is laid out like the input-point tab, and for the same reason: there
 * is one board, so there is one grid. It sits above the strip, the caps carry
 * what each key sends on the open layer, and the layer strip is that tab's
 * section strip — the grid follows whichever layer is open.
 *
 * Two things are deliberately *not* shared with that tab:
 *
 *   - **One key at a time.** Its panels edit a number a whole cluster sensibly
 *     shares, so they paint a selection and "select all" means something. A
 *     binding is the opposite: two keys sending the same thing is a mistake far
 *     more often than an intention. So the grid picks one key — and because
 *     remapping is nearly always a run of keys, choosing a binding steps to the
 *     next one (see `advance`).
 *   - **Edits are not written as they are made.** On the input-point tab a
 *     slider is a number that can be nudged back; here a mis-click is a key
 *     that stops typing what its cap says, on a board whose keymap this app
 *     would then have to be used to repair. So the write stays an explicit
 *     press, and the button says how many keys are waiting.
 *
 * Two things the panel does not offer:
 *
 *   - layers 2 and 3. The firmware indexes four, and only two have storage; the
 *     other two land on the per-key RGB blob and the macro table.
 *   - macros and advanced keys. Both are records that point *into another
 *     block*, and neither block is written by this app yet, so binding one
 *     would point at whatever happens to be there. They are decoded and shown,
 *     which is the honest half of the feature.
 */

/**
 * The picker's categories, in the stock driver's order.
 *
 * Basic is this project's own HID table (keycodes.ts) rather than a catalog
 * entry: the stock tab draws it as a keyboard instead of a list, and it is the
 * one group whose members are already named everywhere else in this app.
 */
const BASIC = 'keymap.group.basic'
/** The section KC_NO is in, and where the KC_TRNS button joins it. */
const UNBOUND = 'keymap.section.unbound'

/**
 * A key width in grid columns.
 *
 * The picker's keyboard is a grid of quarter-units — 22.5u a row, so 90 columns
 * — because that is the smallest step any standard key width lands on.
 */
const span = (u: number) => Math.round(u * 4)
const CATEGORIES: { id: string; nameKey: MessageKey }[] = [
  { id: BASIC, nameKey: 'keymap.group.basic' },
  ...BINDING_GROUPS.map((g) => ({ id: g.nameKey as string, nameKey: g.nameKey })),
]

/** Per layer, the keys the board reported, in this project's key order. */
type LayerRead = { entries: KeymapEntry[] }

/** The binding a key shows: the pending edit if there is one, else the board's. */
function shownBinding(
  read: LayerRead | undefined,
  edits: Record<number, KeyBinding>,
  index: number,
): KeyBinding | undefined {
  return edits[index] ?? read?.entries[index]?.binding
}

function hex(binding: KeyBinding): string {
  return encodeRecord(binding)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

/**
 * What the cap's second line says, or nothing.
 *
 * Nothing is the common case on the base layer, and that is the point: a cap
 * already carries the key's own name, so repeating "A" under the A key would
 * fill the grid with noise and hide the two keys that were actually remapped.
 * So the line appears when the binding is *not* what the legend says — which on
 * the Fn layer is nearly everything, since that is what an Fn layer is.
 *
 * A pending edit always shows, in the warning colour, because "this is not what
 * the board holds yet" is the one thing the grid cannot say any other way.
 *
 * Unbound splits in two. `KC_NO` — the record an unassign writes — is a setting
 * like any other and shows wherever it is set, which matters more here than
 * anywhere else: its entire visible effect on the keyboard is that the key
 * stopped doing anything, so a cap that says nothing about it is a cap that
 * makes the feature look broken. The factory's never-set marker is the other
 * one, and it is most of an Fn layer straight out of the box; a dash on all of
 * those would be the noise this function exists to avoid, so it shows only on
 * the base layer, where every key has a factory binding and empty means someone
 * emptied it.
 */
function capBinding(
  key: KeyDef,
  binding: KeyBinding | undefined,
  edited: boolean,
  baseLayer: boolean,
): ReactNode {
  if (!binding) return undefined
  const label = bindingLabel(binding, keycodeLabel)
  if (edited) return <span className="pending">{label}</span>
  // An explicit `KC_NO` shows on every layer: it is a setting, and one whose
  // whole visible effect is that the key stopped working. Only the factory's
  // never-set marker is hidden, and only off the base layer — see bindingLabel.
  if (binding.kind === 'none') {
    return binding.raw === RECORD_TYPE.key || baseLayer ? label : undefined
  }
  if (sameBinding(binding, factoryBinding(key.code))) return undefined
  return label
}

export function Keymap() {
  const codec = useCodec()
  const t = useT()
  // The attached board's key table and block geometry. A layer is `entrySize`
  // bytes per slot wide, and how many layers there are decides how many tabs
  // and which FN keys the picker offers.
  const { keys } = useLayout()
  const spec = useDeviceSpec()
  const entrySize = spec.keymap.entrySize
  const groups = bindingGroups(spec.keymap.layers)
  const { connected } = useConnection()

  const [layer, setLayer] = useState(0)
  const [category, setCategory] = useState<string>(BASIC)
  /** The one key being bound. Local: nothing else on this tab acts on a set. */
  const [selected, setSelected] = useState<number | null>(null)
  const [reads, setReads] = useState<Record<number, LayerRead>>({})
  /** Pending edits, per layer, by key index. Cleared by a read or a revert. */
  const [edits, setEdits] = useState<Record<number, Record<number, KeyBinding>>>({})
  const [defaults, setDefaults] = useState<Record<number, (KeymapEntry | null)[]>>({})
  /** The same edits, for the read effect to check without depending on them. */
  const editsRef = useRef(edits)
  editsRef.current = edits
  /** What the board is doing, so the column can say which of the two it is. */
  const [busy, setBusy] = useState<null | 'read' | 'write'>(null)
  const inFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)

  const canRead = supports(codec, 'readKeymap')
  const canWrite = supports(codec, 'writeKeymap')
  const canReset = supports(codec, 'readKeymapDefaults')

  const read = reads[layer]
  const layerEdits = edits[layer] ?? {}
  const dirty = Object.keys(layerEdits).length

  /*
   * What the line under the grid says: the cap that is picked, and what it is
   * set to send.
   *
   * It used to say "reading" or "applying", which is the one thing the bars
   * already show — the apply button goes dead while either runs, and a failure
   * lands in `error` beside this. What was missing is the pair this tab is
   * entirely about, and which the grid can only half say: the cap carries its
   * own legend, and the second line appears only when the binding differs from
   * it, so a key rebound to what it already says shows nothing at all.
   *
   * `edited` is kept separate from the binding so the arrow's right-hand side
   * can be marked as pending in the same colour the cap uses for it.
   */
  const pickedKey = selected === null ? undefined : keys.find((k) => k.index === selected)
  const pickedBinding = selected === null ? undefined : shownBinding(read, layerEdits, selected)
  const pickedEdited = selected !== null && layerEdits[selected] !== undefined

  const readLayer = useCallback(
    async (which: number) => {
      if (!codec.readKeymap) return
      inFlight.current = true
      setBusy('read')
      setError(null)
      setMismatch(null)
      try {
        const entries = await codec.readKeymap(link, which)
        setReads((prev) => ({ ...prev, [which]: { entries } }))
        // Every other grid in the app reads its caps off the base layer. This
        // is the tab that has it, so this is where it is handed over — see
        // state/legends.ts.
        if (which === 0) legends.set(entries)
        setEdits((prev) => ({ ...prev, [which]: {} }))
        setStatus(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
        setBusy(null)
      }
    },
    [codec],
  )

  /*
   * Opening the tab, or a layer inside it, reads that layer. There is no read
   * button: this is the refresh, the same way the input-point tab reads on
   * entering a section.
   *
   * Two things it will not do. It does not re-read a layer that has edits
   * waiting — the one thing worse than a stale view is a view that silently
   * discards what was just typed into it — and it does not run itself again on
   * failure, because a board that answers nothing would otherwise be asked once
   * per render, forever. A failed read is retried by leaving the layer and
   * coming back, which is also how a stale one is refreshed.
   *
   * The dependencies are deliberately just those three: adding `busy` would
   * make the effect re-run the moment a read finished, which is the loop this
   * is written to avoid.
   */
  useEffect(() => {
    if (!connected || !canRead || inFlight.current) return
    if (Object.keys(editsRef.current[layer] ?? {}).length > 0) return
    void readLayer(layer)
  }, [connected, canRead, layer, readLayer])

  /**
   * Steps to the next cap, in layout order.
   *
   * Remapping is nearly always a run — a row of function keys, the four arrows,
   * a handful of media keys — and moving the selection by hand between each one
   * is most of the work. So choosing a binding moves on.
   *
   * The last key clears the selection rather than wrapping round to Esc. Both
   * are arbitrary; only one of them can rebind a key nobody was looking at when
   * the next click lands on the catalog instead of the grid.
   */
  const advance = () => {
    setSelected((cur) => (cur === null || cur + 1 >= keys.length ? null : cur + 1))
  }

  /**
   * Binds the selected key.
   *
   * `step` is false for the modifier row: a held modifier is half a binding,
   * and the key it belongs to has not been chosen yet.
   */
  const assign = (binding: KeyBinding, step = true) => {
    if (selected === null) return
    const index = selected
    setEdits((prev) => {
      const forLayer = { ...(prev[layer] ?? {}) }
      const onBoard = read?.entries[index]?.binding
      // An edit back to what the board holds is not an edit. Keeping it would
      // put the key in the pending count and send a write that changes nothing.
      if (onBoard && sameBinding(onBoard, binding)) delete forLayer[index]
      else forLayer[index] = binding
      return { ...prev, [layer]: forLayer }
    })
    if (step) advance()
  }

  const apply = async () => {
    if (!codec.writeKeymap) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    try {
      const entries: (KeymapEntry | null)[] = keys.map((k) => {
        const binding = layerEdits[k.index]
        return binding ? { binding, slot: read?.entries[k.index]?.slot } : null
      })
      const result = await codec.writeKeymap(link, layer, entries)
      // The write already read the layer back; decoding those bytes saves a
      // third read of the same block just to show what the board now holds.
      const applied = (reads[layer]?.entries ?? []).map((entry) => {
        const slot = entry.slot
        if (slot === undefined) return entry
        const binding = decodeFrom(result.after, slot * entrySize, entrySize)
        return binding ? { slot, binding } : entry
      })
      setReads((prev) => ({ ...prev, [layer]: { entries: applied } }))
      // Applied, so the rest of the app's caps follow. Pending edits never get
      // this far: until the write lands they are this tab's business alone.
      if (layer === 0) legends.set(applied)
      setEdits((prev) => ({ ...prev, [layer]: {} }))
      setStatus(
        result.slots.length === 0
          ? t('keymap.noChange')
          : t('keymap.applied', { count: result.keys.length }),
      )
      if (result.mismatched.length > 0) {
        setMismatch(
          t('keymap.mismatch', {
            count: result.mismatched.length,
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Puts the selected key back to what the board left the factory with.
   *
   * From the board's own factory table (0x07), not from this app's idea of the
   * default — the two agree on the base layer, and this app has no idea at all
   * about the Fn one.
   */
  const resetSelected = async () => {
    if (selected === null || !codec.readKeymapDefaults) return
    setBusy('read')
    setError(null)
    try {
      const table = defaults[layer] ?? (await codec.readKeymapDefaults(link, layer))
      setDefaults((prev) => ({ ...prev, [layer]: table }))
      const factory = table[selected]
      if (!factory) {
        setError(t('keymap.resetUnavailable'))
        return
      }
      assign(factory.binding)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * "KC_TRNS" — the base layer's binding, copied into this key on this layer.
   *
   * The name is QMK's and the behaviour is not. This board has no transparent
   * record: the firmware fetches one record at `0x20b00 + layer * 512 + slot * 3`
   * and hands it straight to its dispatch, which has no branch for 0x00 or 0xff
   * and no second look at layer 0 — an unbound key on a higher layer does
   * nothing at all. See docs/protocol.md §7.3.
   *
   * So this button writes a **copy**, not a link: the record it stores is
   * whatever the base layer holds right now, and a later edit to the base layer
   * does not follow it. That is the whole of the difference, and the note under
   * the row says so.
   *
   * It reads what the base layer *shows* rather than what the board holds, so
   * copying from a layer with edits waiting gives what the grid is showing
   * there — the alternative is a button whose result contradicts the tab it was
   * pressed on.
   */
  const baseBinding =
    selected === null ? undefined : shownBinding(reads[0], edits[0] ?? {}, selected)
  const canTrns = layer !== 0 && baseBinding !== undefined

  const selectedKey = selected === null ? undefined : keys[selected]
  const current = selected === null ? undefined : shownBinding(read, layerEdits, selected)
  const modifiers = current?.kind === 'key' ? current.modifiers : 0
  const none = selectedKey === undefined

  const unmapped = read
    ? keys.filter((k) => read.entries[k.index]?.slot === undefined)
    : []

  /**
   * The layer strip is this tab's section strip: it chooses what is edited, and
   * the grid above follows it. Both layers edit the same way, so both render
   * the same picker.
   */
  const picker = (
    <>
      <Panel title={t('keymap.picker.title')}>
        {/* A notice is something a panel holds, not something stacked on the
            page — so the two that belong to the grid live at the top of the
            first panel under it, the way the other tabs do it. */}
        {connected && canRead && !read && busy === null && !error && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">{t('keymap.unread')}</Notice>
          </div>
        )}
        {unmapped.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">
              {t('keymap.unmapped', {
                count: unmapped.length,
                keys: unmapped.map((k) => k.label).join(', '),
              })}
            </Notice>
          </div>
        )}

        <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
          <span className="small dim">
            {none
              ? t('keymap.picker.empty')
              : t('keymap.picker.key', { index: selectedKey.index, key: selectedKey.label })}
          </span>
          <b>{current ? bindingLabel(current, keycodeLabel) : '—'}</b>
          {current && <span className="mono small dim">{hex(current)}</span>}
          <span style={{ flex: 1 }} />
          <button
            disabled={none}
            onClick={() => assign({ kind: 'none', raw: RECORD_TYPE.key })}
          >
            {t('keymap.picker.unassign')}
          </button>
          <button
            disabled={none || !connected || !canReset || busy !== null}
            onClick={() => void resetSelected()}
          >
            {t('keymap.reset')}
          </button>
        </div>

        {/*
          Modifiers ride along with a plain key, exactly as the record does: a
          0x10 record carries a modifier bitmask beside its usage, so Ctrl+C is
          one binding rather than a macro. The stock driver stores only one
          modifier per binding — its `macro_value2` goes through a single
          usage-to-bit conversion — while the firmware ORs the whole mask, so
          several are offered here.

          These are the one thing that does not step to the next key: the
          modifier is picked before the key it is held with, and moving on would
          attach it to the wrong one.
        */}
        <div className="row" style={{ gap: 4 }}>
          <span className="small dim" style={{ marginRight: 4 }}>
            {t('keymap.picker.modifiers')}
          </span>
          {MODIFIERS.map((m) => (
            <button
              key={m.bit}
              disabled={none}
              className={(modifiers & m.bit) !== 0 ? 'primary' : ''}
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.8125rem' }}
              onClick={() => {
                const base =
                  current?.kind === 'key'
                    ? current
                    : { kind: 'key' as const, usage: 0, modifiers: 0 }
                assign({ ...base, modifiers: base.modifiers ^ m.bit }, false)
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          {category === BASIC ? (
            /*
             * A keyboard, not a list of groups. See KEYBOARD_ROWS: a remap is
             * "make this key send Home", and the hand knows where Home is.
             *
             * The cap wins over the long name where the position already says
             * which key it is — the keypad reads `7`, not `Num 7` — and the
             * long name is on the button's tooltip and in the readout under the
             * grid, which is where the two `/` keys are told apart.
             */
            <div className="kbpick-scroll">
              <div className="kbpick">
                {KEYBOARD_ROWS.map((row, r) => (
                  <div className="kbpick-row" key={r}>
                    {row.map((slot, i) =>
                      'gap' in slot ? (
                        <span key={`gap${i}`} style={{ gridColumn: `span ${span(slot.gap)}` }} />
                      ) : (
                        <button
                          key={slot.code}
                          disabled={none}
                          title={keycodeLabel(slot.code)}
                          className={
                            current?.kind === 'key' && current.usage === slot.code ? 'primary' : ''
                          }
                          style={{ gridColumn: `span ${span(slot.u ?? 1)}` }}
                          onClick={() => assign({ kind: 'key', usage: slot.code, modifiers })}
                        >
                          {slot.cap ?? keycodeLabel(slot.code)}
                        </button>
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /*
             * The rest are lists, split into the sets a person looks for — see
             * BindingSection. A group that is one set has no header, because it
             * would repeat the tab above it.
             */
            <>
              <div className="picker-sections">
                {(groups.find((g) => g.nameKey === category)?.sections ?? []).map((s, i) => (
                  <div className="picker-section" key={s.nameKey ?? i}>
                    {s.nameKey && <div className="small dim">{t(s.nameKey)}</div>}
                    <div className="row" style={{ gap: 4 }}>
                      {s.choices.map((choice) => (
                        <button
                          key={choice.label}
                          disabled={none}
                          className={`picker-choice${
                            current && sameBinding(current, choice.binding) ? ' primary' : ''
                          }`}
                          onClick={() => assign(choice.binding)}
                        >
                          {choice.label}
                        </button>
                      ))}
                      {/* KC_TRNS sits with KC_NO because that is where someone
                          looking for the triangle will look, and because the two
                          are the same question — what this key does on *this*
                          layer. It is not a `BindingChoice`: what it writes
                          depends on the base layer, so it cannot be in a
                          catalog. */}
                      {s.nameKey === UNBOUND && (
                        <button
                          className="picker-choice"
                          disabled={none || !canTrns}
                          onClick={() => baseBinding && assign(baseBinding)}
                        >
                          KC_TRNS
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {/* Under the whole row rather than under its own section: the
                  sections are columns now, and a paragraph in one of them would
                  be a two-word-wide wall of text. */}
              {category === 'keymap.group.special' && (
                <div className="small dim" style={{ marginTop: 10 }}>
                  <T k="keymap.trnsNote" />
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      {!canWrite && (
        <Panel title={t('keymap.apply')}>
          <NotDecoded what="keymap.writeWhat" />
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="keymap.writeNote" />
          </div>
        </Panel>
      )}

      <div className="small dim" style={{ padding: '0 2px' }}>
        <T k="keymap.layerNote" />
      </div>
    </>
  )

  /**
   * One tab per category of thing that can be bound.
   *
   * These were a row of buttons inside the panel, under the strip that chose
   * the layer. Swapping the two puts the frequent choice in the frequent place:
   * a session on this tab switches category constantly and the layer once or
   * twice, and the strip under the grid is the app's own place for "which of
   * these am I looking at". The layer moved up into the grid's own bar, which is
   * where the things that act on the grid live — and the grid is what follows
   * the layer.
   */
  const categories: SubTab[] = CATEGORIES.map((c) => ({
    id: c.id,
    labelKey: c.nameKey,
    render: () => picker,
  }))

  /**
   * The layer names, for the pair of buttons in the grid's bar.
   *
   * The first two keep the names they had — the base layer and Fn — and a board
   * with more gets numbered ones, because the bundles cannot name a layer this
   * app has never seen. A layer with no storage behind it is not offered at
   * all: on the Raven61 those addresses hold the RGB blob and the macro table,
   * and reading them as a keymap is what layers.ts warns about.
   */
  const layerName = (i: number) => {
    if (i === 0) return t('keymap.layer.main')
    if (i === 1) return t('keymap.layer.fn1')
    return `FN${i}`
  }

  return (
    <>
      {/*
        The input-point tab's band, with both of its multi-select gestures off:
        the rubber band is disabled and the caps take a plain click rather than
        a paint drag. `selectable={false}` for the same reason — select-all and
        a selection count have nothing to say about one key — so the bars carry
        only what acts on this grid.
      */}
      <GridFrame
        selectable={false}
        top={
          <>
            {/*
              Which layer the grid is showing, and so what everything below it
              edits. In the bar rather than on a strip of its own because it is
              the grid's own state — the same place the input-point tab keeps
              what acts on its grid.
            */}
            <div className="row" style={{ gap: 4 }} role="group" aria-label={t('keymap.layers')}>
              {Array.from({ length: spec.keymap.layers }, (_, i) => (
                <button
                  key={i}
                  className={i === layer ? 'primary' : ''}
                  onClick={() => setLayer(i)}
                >
                  {layerName(i)}
                </button>
              ))}
            </div>
            <hr className="sep" />
            <button
              className="primary"
              disabled={!connected || !canWrite || busy !== null || dirty === 0}
              onClick={() => void apply()}
            >
              {dirty === 0 ? t('keymap.apply') : t('keymap.applyCount', { count: dirty })}
            </button>
            <button
              disabled={dirty === 0 || busy !== null}
              onClick={() => setEdits((prev) => ({ ...prev, [layer]: {} }))}
            >
              {t('keymap.revert')}
            </button>
          </>
        }
        foot={
          <>
            <span>
              {pickedKey ? (
                <>
                  {t('keymap.picked', { key: pickedKey.label })}
                  {pickedBinding && (
                    <>
                      {' → '}
                      <span className={pickedEdited ? 'pending' : undefined}>
                        {bindingLabel(pickedBinding, keycodeLabel)}
                      </span>
                    </>
                  )}
                </>
              ) : (
                t('keymap.pickNone')
              )}
            </span>
            {error && <span className="err">{error}</span>}
            {mismatch && <span className="err">{mismatch}</span>}
            {status && !mismatch && !error && <span>{status}</span>}
          </>
        }
      >
        {/*
          The one grid that keeps the board's printing on the cap whatever the
          keymap says. It is the tab where a key is remapped *from* its legend,
          and `capBinding` below is written around that: the second line appears
          only when the binding differs from the cap, which is a comparison that
          says nothing at all once the cap has been made to agree.
        */}
        <KeyGrid
          physical
          selected={selected === null ? undefined : new Set([selected])}
          onSelect={(i) => setSelected(i)}
          /* Which layer's bindings are on the caps. Switching layer rewrites
             the second line of every cap, and this is what fades the new one
             in — the same treatment the input-point tab's sections get. */
          subKey={String(layer)}
          sub={(k) =>
            capBinding(
              k,
              shownBinding(read, layerEdits, k.index),
              layerEdits[k.index] !== undefined,
              layer === 0,
            )
          }
        />
      </GridFrame>

      <SubTabs
        tabs={categories}
        label={t('keymap.categories')}
        active={category}
        onActive={setCategory}
      />
    </>
  )
}

/** The record at `at` of a blob, or undefined when the blob is too short. */
function decodeFrom(blob: Uint8Array, at: number, entrySize: number): KeyBinding | undefined {
  if (at + entrySize > blob.length) return undefined
  return decodeRecord(blob, at)
}
