import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { KEYBOARD_ROWS, keycodeLabel } from '../keyboard/keycodes'
import { useDeviceSpec, useLayout } from '../device/active'
import type { KeyDef } from '../device/spec'
import { kindOfType } from '../protocol/advancedKeys'
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
  isUnsafe,
  sameBinding,
  type KeyBinding,
} from '../protocol/keymap'
import { isMacroEmpty, macroSlotsExposed } from '../protocol/macros'
import type { KeymapEntry, MacroSnapshot } from '../protocol/types'
import { legends } from '../state/legends'
import { link, useCodec, useConnection } from '../state/link'
import { useSettings } from '../state/settings'
import { Dialog, DialogActions } from '../ui/Dialog'
import { KeyGrid } from '../ui/KeyGrid'
import { KindChip } from '../ui/KindChip'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { GridFrame } from '../ui/GridFrame'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { layerName } from '../protocol/layers'

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
 * One thing is deliberately *not* shared with that tab:
 *
 *   - **One key at a time.** Its panels edit a number a whole cluster sensibly
 *     shares, so they paint a selection and "select all" means something. A
 *     binding is the opposite: two keys sending the same thing is a mistake far
 *     more often than an intention. So the grid picks one key — and because
 *     remapping is nearly always a run of keys, choosing a binding steps to the
 *     next one (see `advance`).
 *
 * Edits *are* written as they are made, like every other tab's. This tab used
 * to stage them behind an apply button, on the reasoning that a mis-click here
 * costs a key that stops typing what its cap says. It does — but the staging
 * never bought the caution it promised: the grid showed the pending binding in
 * the same place the applied one goes, so the mistake was already on screen and
 * already looked done, and what the button added was a second screen state to
 * get wrong and one more press between every edit and knowing whether the board
 * took it. Choosing a binding now writes that one key and reads it back (see
 * `commit`), the cap holds the pending colour until the read-back agrees, and a
 * mis-click is repaired the way it is made — by binding the key again.
 *
 * What the panel does not offer:
 *
 *   - layers 2 and 3. The firmware indexes four, and only two have storage; the
 *     other two land on the per-key RGB blob and the macro table.
 *   - advanced keys. A `0x90`-`0x95` record points *into another block* and
 *     this app does not write that block, so binding one would point at
 *     whatever happens to be there. They are decoded and shown, which is the
 *     honest half of the feature.
 *
 * Macros were in that list until this tab could check the store. They are the
 * same shape of hazard — a `0x70` record names a slot in a block written
 * somewhere else — but a *checkable* one: the store says whether every slot
 * points at a body that stops, and a key bound to one that does not sends the
 * player walking through flash. So the macro category reads the store itself,
 * and binds nothing until it comes back sound. See `protocol/macros.ts`.
 */

/**
 * The picker's categories, in the stock driver's order.
 *
 * Basic is this project's own HID table (keycodes.ts) rather than a catalog
 * entry: the stock tab draws it as a keyboard instead of a list, and it is the
 * one group whose members are already named everywhere else in this app.
 *
 * Macro is the stock driver's sixth list (`edi` 5 in its builder at 0x414700)
 * and the last one this app was missing, but it is not a catalog either — its
 * entries are slots of a block on the board. Debug is nobody's list; see the
 * two constants below.
 */
const BASIC = 'keymap.group.basic'
/**
 * Macros, which are not a `BindingGroup`: the entries are the board's own store
 * rather than a catalog, so the list is whatever a read of it found.
 */
const MACRO = 'keymap.group.macro'
/**
 * Any record at all, typed in. Debug mode only — see `state/settings.ts`.
 *
 * The catalogs are what the stock driver can produce, which is the right
 * default and the wrong ceiling: the firmware decodes type bytes no list here
 * carries, and the key path will put any usage in the report. This is the way
 * to try one without adding it to a catalog on a guess.
 */
const DEBUG = 'keymap.group.debug'
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
  { id: MACRO, nameKey: 'keymap.group.macro' },
]
const DEBUG_CATEGORY = { id: DEBUG, nameKey: 'keymap.group.debug' } as const

/**
 * Reads a byte someone typed, in whatever base they meant.
 *
 * `0x` or a bare hex pair for the way records are written down everywhere else
 * in this app and in the docs; plain decimal because a HID usage table is as
 * likely to be read off a list of decimals. Undefined for anything that is not
 * one byte, which is what disables the button rather than writing a 0.
 */
function readByte(text: string): number | undefined {
  const s = text.trim()
  if (s === '') return undefined
  const hex = /^(0x|0X)?[0-9a-fA-F]{1,2}$/.test(s)
  const dec = /^[0-9]{1,3}$/.test(s)
  // A bare "10" is ambiguous and this app reads records in hex, so hex wins —
  // which is also what the `0x` form makes explicit for anyone who cares.
  const value = hex ? parseInt(s.replace(/^0[xX]/, ''), 16) : dec ? Number(s) : NaN
  return Number.isInteger(value) && value >= 0 && value <= 0xff ? value : undefined
}

/** The three bytes of a record, typed as `70 01 01` or `0x70 1 1`. */
function readRecord(text: string): [number, number, number] | undefined {
  const parts = text.trim().split(/[\s,:]+/).filter(Boolean)
  if (parts.length !== 3) return undefined
  const bytes = parts.map(readByte)
  return bytes.every((b) => b !== undefined) ? (bytes as [number, number, number]) : undefined
}

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
  /*
   * Nothing on the second line for a key that runs an advanced key: the grid
   * draws that as a band along the cap's bottom edge, and `Adv key 3` here
   * would be the same fact again as a record number pointing at a table this
   * tab does not read.
   *
   * Never a pending edit, which is why this is below that branch and not above
   * it: the picker has no advanced group (see `bindingGroups`), so an advanced
   * binding on this tab is always one the board reported. Editing a cap that
   * has one replaces it with whatever was picked, and the pending line above
   * reads that out like any other.
   */
  if (binding.kind === 'advanced') return undefined
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

  const { debug } = useSettings()

  const [layer, setLayer] = useState(0)
  const [category, setCategory] = useState<string>(BASIC)
  /** The one key being bound. Local: nothing else on this tab acts on a set. */
  const [selected, setSelected] = useState<number | null>(null)
  const [reads, setReads] = useState<Record<number, LayerRead>>({})
  /**
   * The same reads, for a queued write to take its slots from.
   *
   * A write needs the slot numbers the layer read gave, and it runs from a
   * queue (see `commit`) — so by the time it runs, the `reads` captured in the
   * render that queued it may be a read older than the one the write before it
   * just landed. The ref is the current one either way.
   */
  const readsRef = useRef(reads)
  readsRef.current = reads
  /**
   * The edits in flight, per layer, by key index.
   *
   * Not a staging area any more — an edit is sent the moment it is made — but
   * the send is a round trip, and between the click and the read-back the cap
   * has to show *something*. It shows the new binding in the pending colour,
   * which is what this holds: the key comes out again when its write reads back
   * (see `commit`), or when a failed one puts the cap back to the board's.
   */
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

  /** The macro store, when the macro category has read it. */
  const [macros, setMacros] = useState<MacroSnapshot | null>(null)
  const [macroBusy, setMacroBusy] = useState(false)
  const [macroError, setMacroError] = useState<string | null>(null)
  const macroInFlight = useRef(false)
  /** Whether the malformed-store dialog is on screen — see the effect below. */
  const [macroAlert, setMacroAlert] = useState(false)
  /** The debug category's two fields, as typed. */
  const [rawUsage, setRawUsage] = useState('')
  const [rawRecord, setRawRecord] = useState('')

  const canRead = supports(codec, 'readKeymap')
  const canWrite = supports(codec, 'writeKeymap')
  const canReset = supports(codec, 'readKeymapDefaults')
  const canMacros = supports(codec, 'readMacros')

  /*
   * Which category is open, which is not quite which one was picked: turning
   * debug mode off takes its category out of the strip, and the one that was
   * picked would then be a category with no tab. Resolved while rendering
   * rather than corrected in an effect, the way App.tsx resolves the same
   * thing for the debug *tabs* — an effect would leave one frame with a strip
   * that has nothing selected in it.
   */
  const categoryTabs = [...CATEGORIES, ...(debug ? [DEBUG_CATEGORY] : [])]
  const open = categoryTabs.some((c) => c.id === category) ? category : BASIC

  const read = reads[layer]
  const layerEdits = edits[layer] ?? {}

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
  /* The picked key's advanced record, when it has one and is not mid-edit —
     the readout draws it as a chip and a record number rather than as the
     `Adv key 3` that is all `bindingLabel` can make of three bytes. */
  const pickedAdvanced =
    pickedBinding?.kind === 'advanced' && !pickedEdited ? pickedBinding : undefined
  const pickedAdvancedKind = pickedAdvanced && kindOfType(pickedAdvanced.type)

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

  /*
   * The macro store, read when its category is opened.
   *
   * Not on entering the tab: it is a 4 KB read for a category most sessions
   * never open, and every other tab that wants it reads it itself. Once per
   * connection is enough — nothing here writes the store, so what changes it is
   * the macro tab, and coming back to this one after that is a category switch
   * away either way.
   *
   * Failure is not retried, for the reason the layer read is not: a board that
   * answers nothing would be asked once per render. Leaving the category and
   * coming back tries again.
   */
  useEffect(() => {
    if (open !== MACRO || !connected || !canMacros) return
    if (macros !== null || macroInFlight.current) return
    if (!codec.readMacros) return
    macroInFlight.current = true
    setMacroBusy(true)
    setMacroError(null)
    codec
      .readMacros(link)
      .then(setMacros)
      .catch((e: unknown) => setMacroError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        macroInFlight.current = false
        setMacroBusy(false)
      })
  }, [open, connected, canMacros, codec, macros])

  /* A board swap or a disconnect makes the store this app read someone else's. */
  useEffect(() => {
    if (!connected) setMacros(null)
  }, [connected])

  /*
   * A store that is not canonical stops the category, so it is said out loud.
   *
   * A store every slot of which ends in a stop record says nothing at all —
   * nothing happened, and a line confirming that is a line read every visit for
   * no reason. The other half is not a remark: the slot buttons are dead until
   * the store is written from the macro tab, and without this the category is a
   * row of disabled buttons with no cause on screen.
   *
   * It comes back on every entry to the category rather than once per run,
   * because it is not a caution to be remembered — it is the reason this
   * category cannot be used yet, and it holds for as long as the store does.
   * Dismissing closes it until the category is left, or until a fresh read
   * replaces the snapshot.
   */
  useEffect(() => {
    if (open !== MACRO || !macros || macros.canonical) return
    setMacroAlert(true)
  }, [open, macros])

  const dismissMacroAlert = useCallback(() => setMacroAlert(false), [])

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
   * The queue the writes go through, one at a time.
   *
   * Binding a run of keys is a run of clicks faster than a round trip to the
   * board, and every one of these writes the *whole* 512-byte layer: the codec
   * reads the block, patches the slot, sends it back and reads it again. Two of
   * those in the air together and the second one is patching a block it read
   * before the first one landed, which puts the earlier key back. So each waits
   * for the one before it, and the queue is a promise chain rather than a
   * `busy` check — a check would drop the clicks made while a write was out,
   * which is exactly the run this tab is used for.
   */
  const queue = useRef<Promise<void>>(Promise.resolve())

  /**
   * Writes one key's binding, and takes the cap out of the pending colour.
   *
   * The single-key shape is the whole of what changed when the apply button
   * went: `writeKeymap` already takes a sparse array — one entry per key, null
   * for the ones this write leaves alone — and the button filled it from the
   * staged set. Here exactly one is filled in.
   *
   * A failure leaves the edit out of `edits` all the same. The cap then shows
   * what the board last read as holding, which is the truth as far as this app
   * knows it; leaving it pending would colour the cap for a binding that is not
   * on the board and is no longer on its way there either.
   */
  const commit = (which: number, index: number, binding: KeyBinding) => {
    if (!codec.writeKeymap) return Promise.resolve()
    const run = queue.current.then(async () => {
      const write = codec.writeKeymap
      if (!write) return
      setBusy('write')
      setError(null)
      setMismatch(null)
      try {
        const entries: (KeymapEntry | null)[] = keys.map((k) =>
          k.index === index
            ? { binding, slot: readsRef.current[which]?.entries[k.index]?.slot }
            : null,
        )
        const result = await write(link, which, entries)
        // The write already read the layer back; decoding those bytes saves a
        // third read of the same block just to show what the board now holds.
        const applied = (readsRef.current[which]?.entries ?? []).map((entry) => {
          const slot = entry.slot
          if (slot === undefined) return entry
          const record = decodeFrom(result.after, slot * entrySize, entrySize)
          return record ? { slot, binding: record } : entry
        })
        setReads((prev) => ({ ...prev, [which]: { entries: applied } }))
        // Applied, so the rest of the app's caps follow.
        if (which === 0) legends.set(applied)
        // The macro category lists which keys start each body, and that list is
        // read out of the keymap — so a write to the keymap is what makes it
        // stale. Dropping the snapshot re-reads it, and only while that category
        // is the one open (see the effect above).
        setMacros(null)
        const key = keys.find((k) => k.index === index)
        setStatus(
          result.slots.length === 0
            ? t('keymap.noChange')
            : t('keymap.appliedOne', { key: key?.label ?? `#${index}` }),
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
        setEdits((prev) => {
          const forLayer = { ...(prev[which] ?? {}) }
          delete forLayer[index]
          return { ...prev, [which]: forLayer }
        })
        setBusy(null)
      }
    })
    queue.current = run
    return run
  }

  /**
   * Binds the selected key, and sends it.
   *
   * `step` is false for the modifier row: a held modifier is half a binding,
   * and the key it belongs to has not been chosen yet.
   */
  const assign = (binding: KeyBinding, step = true) => {
    if (selected === null) return
    const index = selected
    const which = layer
    const onBoard = readsRef.current[which]?.entries[index]?.binding
    // A binding back to what the board already holds is not an edit. Sending it
    // would be a write that changes nothing, and marking the cap pending for
    // the length of it would say the board disagrees with itself.
    if (onBoard && sameBinding(onBoard, binding)) {
      if (step) advance()
      return
    }
    setEdits((prev) => ({ ...prev, [which]: { ...(prev[which] ?? {}), [index]: binding } }))
    void commit(which, index, binding)
    if (step) advance()
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
  /*
   * What greys the whole catalog out: no key picked, or no board to take the
   * binding. The second half was the apply button's job until it went —
   * choosing a binding *is* the write now, so a catalog that still took clicks
   * off a disconnected board would be a row of buttons that do nothing.
   *
   * It is kept apart from `none` because the line above the catalog says which
   * of the two it is: "pick a key" is wrong advice on a board that is not
   * there, and `none` is what that line reads.
   */
  const locked = none || !connected || !canWrite

  const unmapped = read
    ? keys.filter((k) => read.entries[k.index]?.slot === undefined)
    : []

  /**
   * The macro slots, as buttons that bind one.
   *
   * Two things make this list different from a catalog. It is **read**: the
   * entries are slots of the board's own store, so how many have anything in
   * them is a fact about the board and not about this app. And it is **gated**:
   * a `0x70` record sends the player to `0x21100 + table[slot]`, and the player
   * has no upper bound on its cursor — bound to a slot whose offset names no
   * body, a key walks flash pressing whatever it reads. `canonical` is the
   * store saying every slot ends in a stop record, and nothing binds until it
   * does. Reading the store to answer that is the reason this category could
   * be added at all, and now the reason it is the only place that binds one:
   * the macro tab records and stores, and points here.
   *
   * The repeat byte goes out as 1, which is what the stock driver writes. The
   * firmware stores it at `gp-0x781` and never reads it back, so it is not
   * offered as a setting — see the header of features/Macro.tsx.
   */
  const macroSlots = macroSlotsExposed(debug, spec.macros)
  // `?? []` and not a `!`: the field is null when the read skipped the keymap
  // sweep, and this tab never asks it to — it is the one that needs the list.
  const macroUses = macros ? (macros.uses ?? []).filter((u) => u.layer === layer) : []
  const macroPicker = !canMacros ? (
    <Notice kind="warn">
      <T k="keymap.macro.unsupported" />
    </Notice>
  ) : macroError ? (
    <Notice kind="err">{macroError}</Notice>
  ) : macros === null ? (
    <div className="small dim">
      {macroBusy ? t('keymap.macro.reading') : t('keymap.macro.unread')}
    </div>
  ) : (
    <>
      <Dialog
        open={macroAlert}
        onClose={dismissMacroAlert}
        title={t('keymap.macro.unsafeTitle')}
        tone="warn"
      >
        <div className="small">
          <T k="keymap.macro.unsafe" params={{ slots: macros.malformed.length }} />
        </div>
        <DialogActions>
          {/* The only button: nothing here is being asked, the store is what it
              is and this says why the slots below cannot be bound. */}
          <button className="primary" onClick={dismissMacroAlert}>
            {t('keymap.macro.unsafeDismiss')}
          </button>
        </DialogActions>
      </Dialog>
      <div className="row" style={{ gap: 4 }}>
        {Array.from({ length: macroSlots }, (_, slot) => {
          const body = macros.macros[slot]
          const binding: KeyBinding = { kind: 'macro', slot, repeat: 1 }
          const count = body?.events.length ?? 0
          return (
            <button
              key={slot}
              className={`picker-choice${
                current && sameBinding(current, binding) ? ' primary' : ''
              }`}
              disabled={locked || !macros.canonical}
              title={
                !body || isMacroEmpty(body)
                  ? t('keymap.macro.slotEmpty', { slot })
                  : t('keymap.macro.slotTitle', { slot, count })
              }
              onClick={() => assign(binding)}
            >
              {`#${slot}`}
            </button>
          )
        })}
      </div>
      {macroUses.length > 0 && (
        <div className="small dim" style={{ marginTop: 8 }}>
          {t('keymap.macro.inUse')} — {macroUses.map((u) => `#${u.macro} ${u.label}`).join(', ')}
        </div>
      )}
      {debug && (
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="keymap.macro.slotsUnlocked" params={{ total: spec.macros.slots }} />
        </div>
      )}
    </>
  )

  /**
   * Debug mode's own category: a usage, or a whole record, typed in.
   *
   * The catalogs stop where the stock driver stops, which is the right default
   * — a list this app cannot cite is a list of guesses. It is the wrong ceiling
   * for a protocol lab, though: the firmware's dispatch decodes types no
   * catalog here carries (`0x22`, `0x23`, `0x40`, `0x50`, `0x60`, `0x80`), and
   * the key path puts any usage byte into the report unchanged. So the two
   * fields, and no list.
   *
   * The usage field is separate from the record field on purpose, because it is
   * the one people actually want: it rides the modifier strip above, so
   * `0x66` and Shift is one click apart from `0x66` alone.
   */
  const usageByte = readByte(rawUsage)
  const recordBytes = readRecord(rawRecord)
  const recordBinding = recordBytes ? decodeRecord(recordBytes) : undefined
  const recordUnsafe = recordBinding !== undefined && isUnsafe(recordBinding)
  const badInput =
    (rawUsage.trim() !== '' && usageByte === undefined) ||
    (rawRecord.trim() !== '' && recordBytes === undefined)
  const debugPicker = (
    <>
      <div className="row" style={{ gap: 8 }}>
        <span className="small dim">{t('keymap.debug.usage')}</span>
        <input
          type="text"
          className="mono"
          style={{ width: '6rem' }}
          placeholder="0x66"
          value={rawUsage}
          onChange={(e) => setRawUsage(e.target.value)}
        />
        <b>{usageByte === undefined ? '—' : keycodeLabel(usageByte)}</b>
        <button
          className="picker-choice"
          disabled={locked || usageByte === undefined}
          onClick={() =>
            usageByte !== undefined && assign({ kind: 'key', usage: usageByte, modifiers })
          }
        >
          {t('keymap.debug.usageApply')}
        </button>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <span className="small dim">{t('keymap.debug.record')}</span>
        <input
          type="text"
          className="mono"
          style={{ width: '8rem' }}
          placeholder="70 00 01"
          value={rawRecord}
          onChange={(e) => setRawRecord(e.target.value)}
        />
        <b>{recordBinding === undefined ? '—' : bindingLabel(recordBinding, keycodeLabel)}</b>
        <button
          className="picker-choice"
          disabled={locked || recordBinding === undefined || recordUnsafe}
          onClick={() => recordBinding !== undefined && assign(recordBinding)}
        >
          {t('keymap.debug.recordApply')}
        </button>
      </div>

      {badInput && (
        <div className="small err" style={{ marginTop: 8 }}>
          {t('keymap.debug.bad')}
        </div>
      )}
      {recordUnsafe && (
        <div className="small err" style={{ marginTop: 8 }}>
          <T k="keymap.debug.unsafe" />
        </div>
      )}
    </>
  )

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
            disabled={locked}
            onClick={() => assign({ kind: 'none', raw: RECORD_TYPE.key })}
          >
            {t('keymap.picker.unassign')}
          </button>
          <button
            disabled={locked || !canReset || busy !== null}
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
              disabled={locked}
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
          {open === MACRO ? (
            macroPicker
          ) : open === DEBUG ? (
            debugPicker
          ) : open === BASIC ? (
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
                          disabled={locked}
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
                {(groups.find((g) => g.nameKey === open)?.sections ?? []).map((s, i) => (
                  <div className="picker-section" key={s.nameKey ?? i}>
                    {s.nameKey && <div className="small dim">{t(s.nameKey)}</div>}
                    <div className="row" style={{ gap: 4 }}>
                      {s.choices.map((choice) => (
                        <button
                          key={choice.label}
                          disabled={locked}
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
                          disabled={locked || !canTrns}
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
              {open === 'keymap.group.special' && (
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
  const categories: SubTab[] = categoryTabs.map((c) => ({
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

              Drawn as a section strip all the same (`.layer-tabs`): picking a
              layer is picking one of a handful of views of the same keyboard,
              which is what the strip below the grid means, and a row of
              buttons with one of them lit said "three things you can press"
              instead.
            */}
            <div className="layer-tabs" role="tablist" aria-label={t('keymap.layers')}>
              {Array.from({ length: spec.keymap.layers }, (_, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === layer}
                  onClick={() => setLayer(i)}
                >
                  {layerName(i)}
                </button>
              ))}
            </div>
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
                      {/*
                        The same chip the cap carries, so the line under the
                        grid and the key it is about say the same thing — and
                        the record number after it, which is the one fact the
                        chip drops and the only one this tab can act on. Kept
                        out of the `pending` span because an advanced binding is
                        never an edit here: the picker has no advanced group.
                      */}
                      {pickedAdvanced && pickedAdvancedKind ? (
                        <span>
                          <KindChip kind={pickedAdvancedKind} />{' '}
                          {t('keymap.pickedRecord', { record: pickedAdvanced.record })}
                        </span>
                      ) : (
                        <span className={pickedEdited ? 'pending' : undefined}>
                          {bindingLabel(pickedBinding, keycodeLabel)}
                        </span>
                      )}
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
          /* This tab's own layer, rather than the base one the grid would
             otherwise answer with — and only once it has been read. See the
             `advanced` prop. */
          advanced={
            read
              ? (k) => {
                  const b = shownBinding(read, layerEdits, k.index)
                  return b?.kind === 'advanced' ? kindOfType(b.type) : undefined
                }
              : true
          }
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
        active={open}
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
