import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeviceSpec, useLayout } from '../device/active'
import type { KeyDef } from '../device/spec'
import { travelMmFor } from '../device/tables'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { KEYCODES, keycodeDefLabel } from '../keyboard/keycodes'
import {
  ADVANCED_KINDS,
  ADVANCED_TYPE,
  DKS_BINDINGS,
  DKS_STAGES,
  MT_DEFAULT_HOLD_MS,
  MT_HOLD_MS_PER_UNIT,
  bindsNothing,
  decodeAdvancedRecord,
  dksMaxSteps,
  dksMmToSteps,
  encodeAdvancedRecord,
  encodeDksSpan,
  dksStepsToMm,
  emptyAdvancedRecord,
  emptyPairRecord,
  firstFreeRecord,
  isFreeRecord,
  KIND_OF_BLOCK,
  kindKey,
  mtBindings,
  recordBlocks,
  oksBindings,
  pairUsages,
  withMtBindings,
  withOksBindings,
  withPairUsages,
  type AdvancedKind,
  type AdvancedRecord,
  type DksSpan,
  UNSTABLE_KINDS,
  type PairRecord,
  type ToggleRecord,
} from '../protocol/advancedKeys'
import { supports } from '../protocol/codec'
import { BINDING_GROUPS, encodeRecord, groupChoices, type KeyBinding } from '../protocol/keymap'
import type { AdvancedKeySnapshot, AdvancedKeyUse, KeymapEntry } from '../protocol/types'
import { useKeyConfigs } from '../state/config'
import { legends } from '../state/legends'
import { link, useCodec, useConnection } from '../state/link'
import { useSettings } from '../state/settings'
import { boardSync } from '../state/sync'
import { GridFrame } from '../ui/GridFrame'
import { KeyCapture } from '../ui/KeyCapture'
import { KeyGrid } from '../ui/KeyGrid'
import { MessageToast } from '../ui/MessageToast'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { Select, type SelectOption } from '../ui/Select'
import { Slider } from '../ui/Slider'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { Argument, rowsOf } from './AdvancedInUse'
import { layerName } from '../protocol/layers'

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
 * ### RS and SOCD are two keys, so they are four writes
 *
 * Neither is a setting on a key. Both are an agreement between two of them:
 * each half owns a record naming the two usages, and each half's keymap entry
 * carries the **other** key's slot, which is how the scan finds the partner's
 * depth (0xf7ce). Four pieces, none of which works alone.
 *
 * So those two kinds are configured by picking both caps on the grid rather
 * than by typing a slot number. One apply writes both records and then both
 * keymap entries — records first, for the reason above, and both of them
 * before either entry, because each entry names the other key's record.
 *
 * The slot number is still what goes in the bytes. It is just not a thing to
 * be looked up in a table and typed in: the slot map already knows which slot
 * a cap is, and a number typed by hand is a pair that silently resolves
 * against the wrong key.
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

/**
 * Where a new DKS record's four points start, in millimetres.
 *
 * Not in `emptyDksRecord`, which has to stay four zeros: that is what a
 * cleared record is, and what `isFreeRecord` reads as "nobody is using this".
 * This is the editor's starting position, applied to a draft nobody has
 * written — shallow on the way down, deep on the way back up, and symmetric,
 * which is the shape a four-point stroke is usually wanted in and a far better
 * place to start than every point on top of each other at zero.
 *
 * Clamped to the switch's own stroke where it has to be: 3.0 mm is past the
 * bottom of a 2.5 mm switch, and a starting point the key cannot reach is a
 * point that never fires.
 */
const DKS_START_MM = [1.0, 3.0, 3.0, 1.0] as const

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

/**
 * The kinds that are an agreement between two caps rather than a setting on
 * one — see the header.
 *
 * OKS is deliberately not here even though its keymap entry carries a partner
 * slot too. Its record is one key's two usages (held, then on release) and the
 * partner is only a gate on firing, so a pair editor would claim a symmetry it
 * does not have. It keeps the slot field.
 */
const DUO_KINDS = ['rs', 'socd'] as const

type DuoKind = (typeof DUO_KINDS)[number]

function isDuoKind(kind: AdvancedKind): kind is DuoKind {
  return kind === 'rs' || kind === 'socd'
}

/** The pair's two usages, while they are being edited. */
type DuoDraft = { kind: DuoKind; usages: [number, number] }

/** The first free record that is not already spoken for by this same apply. */
function freeRecordExcept(
  blobs: AdvancedKeySnapshot['blobs'],
  limit: number,
  taken: readonly number[],
): number {
  for (let i = 0; i < limit; i++) {
    if (!taken.includes(i) && isFreeRecord(blobs, i)) return i
  }
  return -1
}

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

/**
 * What a field needs to put a keyboard picker beside its list — see
 * ui/KeyCapture.
 *
 * The flag is the panel's rather than each field's, because a panel here has
 * up to two of these: mod-tap is a tap and a hold, and a pair is one usage per
 * cap. Two armed at once would answer both questions with one keystroke, and a
 * single "which of you is waiting" cannot.
 */
type Arming = { armed: boolean; onArmed: (armed: boolean) => void }

/** One field's share of that flag, by a name that is unique within its panel. */
function arming(waiting: string | null, set: (id: string | null) => void, id: string): Arming {
  return { armed: waiting === id, onArmed: (on) => set(on ? id : null) }
}

function BindingSelect({
  value,
  onChange,
  label,
  disabled,
  armed,
  onArmed,
}: {
  value: KeyBinding
  onChange: (binding: KeyBinding) => void
  label: string
  disabled?: boolean
} & Partial<Arming>) {
  return (
    <>
      <Select
        label={label}
        value={bindingValue(value)}
        options={BINDINGS.options}
        disabled={disabled}
        onChange={(v) => {
          const binding = BINDINGS.byValue.get(v)
          if (binding) onChange(binding)
          // Picking from the list answers the question the button beside it is
          // waiting for.
          onArmed?.(false)
        }}
      />
      {/*
        Only where the caller handed over a share of the panel's flag. The DKS
        columns deliberately do not: a stroke's four pickers are laid out over
        the four tracks they belong to, and a button after each one would be
        four more columns' worth of width for a shortcut that is already there
        in the two kinds with a plain field.
      */}
      {onArmed && (
        <KeyCapture
          armed={armed ?? false}
          onArmed={onArmed}
          disabled={disabled}
          // A captured key is a plain keystroke with no modifiers held — the
          // same shape `bindingOptions` gives every entry of the key list, so
          // the dropdown beside it shows the capture as one of its own.
          onCapture={(usage) => onChange({ kind: 'key', usage, modifiers: 0 })}
        />
      )}
    </>
  )
}

function UsageSelect({
  value,
  onChange,
  label,
  disabled,
  armed,
  onArmed,
}: {
  value: number
  onChange: (usage: number) => void
  label: string
  disabled?: boolean
} & Partial<Arming>) {
  return (
    <>
      <Select
        label={label}
        value={String(value)}
        options={USAGES}
        disabled={disabled}
        onChange={(v) => {
          onChange(Number(v))
          onArmed?.(false)
        }}
      />
      {onArmed && (
        <KeyCapture
          armed={armed ?? false}
          onArmed={onArmed}
          disabled={disabled}
          onCapture={onChange}
        />
      )}
    </>
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="row adv-row">
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
  /*
   * Record slots, the bytes in them and the orphan sweep are the table
   * underneath the six kinds, not the setting — someone binding a mod-tap
   * has no use for "#4 · 70 00 01". They stay for the protocol work that
   * needs to see what was written, behind the same flag as the debug tabs.
   */
  const { debug } = useSettings()

  const canRead = supports(codec, 'readAdvancedKeys')
  const canWrite = supports(codec, 'writeAdvancedKey') && supports(codec, 'writeKeymap')
  /** Unbinding needs the factory table as well, to put the cap back to itself. */
  const canUnbind = canWrite && supports(codec, 'readKeymapDefaults')
  /** Only for the pair's defaults — the tab reads and writes without it. */
  const canReadKeymap = supports(codec, 'readKeymap')

  const [layer, setLayer] = useState(0)
  /**
   * Which section of the strip under the grid is open.
   *
   * The six kinds were a dropdown inside the panel, under a strip that chose
   * the layer. The two have swapped places, for the reason the remap tab's
   * did: the kind is what a session on this tab changes constantly, and the
   * strip is this app's own place for "which of these am I looking at". The
   * layer moved up into the grid's bar, which is where the things that act on
   * the grid live — and the grid is what follows the layer.
   *
   * Every section is an editor. What the board already runs was a seventh here
   * and is now the overview tab's advanced-key section — it wrote nothing, and
   * a strip where one button in seven does not open an editor is a strip that
   * has to be learned rather than read.
   */
  const [open, setOpen] = useState<AdvancedKind>(ADVANCED_KINDS[0])
  /**
   * The kinds the strip offers.
   *
   * All six in debug mode; outside it, the ones the firmware actually runs —
   * see `UNSTABLE_KINDS`. Derived rather than stored, so turning debug off puts
   * the section away on the next render instead of leaving a tab that writes a
   * kind this app has decided not to write.
   */
  const offered = ADVANCED_KINDS.filter((k) => debug || !UNSTABLE_KINDS.includes(k))
  /**
   * Which section is open, once the strip has had its say.
   *
   * Debug mode going off while one of its kinds is open falls back to the first
   * rather than leaving the strip pointed at a tab that is no longer on it —
   * the same fallback the sidebar makes for the debug tabs (see App.tsx).
   */
  const kind: AdvancedKind = offered.includes(open) ? open : ADVANCED_KINDS[0]
  /**
   * The caps being worked on, in the order they were clicked.
   *
   * One for four of the kinds. Two for RS and SOCD — see the header: those
   * are not a setting on a key, so asking for one cap and then a slot number
   * was asking for half the thing and then a clerical detail. `pick` below
   * keeps the list at whatever the open kind needs.
   */
  const [picked, setPicked] = useState<number[]>([])
  /**
   * The cap the pointer is on, for the readout under the grid.
   *
   * Hover rather than the selection alone, because the question the foot
   * answers — "what is this key running?" — is asked *before* clicking: a cap
   * now reads what is printed on it whatever advanced key it runs (see
   * `legendFor`), so pointing is how the grid is read. The selection is the
   * fallback, so the answer stays up for the key being edited once the pointer
   * has left the keyboard.
   */
  const [hovered, setHovered] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<AdvancedKeySnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  /** The pair's edits, kept apart from `draft`: two records, not one. */
  const [duo, setDuo] = useState<DuoDraft | null>(null)
  /**
   * Which of the pair's two usage fields is waiting for a keystroke — see
   * `arming`. The editor's own fields keep theirs in `Editor`; these two are
   * drawn here, so the flag is here with them.
   */
  const [waitingOn, setWaitingOn] = useState<string | null>(null)
  /**
   * What each key of a layer is bound to, once per layer.
   *
   * Only for defaults. An RS pair is nearly always the two keys keeping the
   * usages they already have, so a blank "this key sends" made every setup two
   * choices that were already on the caps. A layer that has not been read, or
   * a board that will not answer, just falls back to a dash — nothing here
   * writes the keymap from it.
   */
  const [layerBindings, setLayerBindings] = useState<Record<number, KeymapEntry[]>>({})
  /**
   * The per-key performance records, for one field of them: switch type.
   *
   * DKS is the only kind that asks how deep, and how deep a key goes is the
   * switch it has fitted — the board reports one per key and this board's
   * table spreads 2.50 mm to 4.00 mm across eight of them. A depth slider that
   * always ran to the layout's nominal stroke would offer a 2.5 mm switch a
   * millimetre and a half it cannot reach.
   */
  const configs = useKeyConfigs()
  const [busy, setBusy] = useState<null | 'read' | 'write'>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  /** Stable, so the toast's timer is not restarted by every render. */
  const clearStatus = useCallback(() => setStatus(null), [])
  const [mismatch, setMismatch] = useState<string | null>(null)
  /** What the last read's sweep did, if anything. Its own line — see `read`. */
  const [swept, setSwept] = useState<{ cleared: number[]; failed: number[] }>({
    cleared: [],
    failed: [],
  })
  const inFlight = useRef(false)
  /** Orphans whose clear did not read back. Not tried again — see `sweepOrphans`. */
  const unsweepable = useRef<Set<number>>(new Set())

  /**
   * Records with bytes in them that no keymap entry names, zeroed.
   *
   * These are leftovers: a key rebound to a different record, or a kind
   * changed, leaves the old one occupied and unreachable. Nothing runs them
   * and nothing can — the kind and the key are both in the keymap — but the
   * allocator counts them, so 40 of them is a tab that cannot make a 41st
   * advanced key out of a board with none.
   *
   * This used to be a notice instead of a write, on the reasoning that a
   * leftover and a record the stock driver wrote for a profile this app cannot
   * see look identical from here. On this board they do not: the pair table's
   * second page is addressed through `gp-0x7b7`, nothing in the image writes
   * that byte, and the sweep above covers every layer the spec says has
   * storage. So an orphan here is an orphan. The clearing is still *reported*
   * rather than silent — it is a write nobody asked for by name.
   *
   * The kind is the awkward part. A record nothing points at has none, and
   * `writeAdvancedKey` takes a typed record, so this asks which tables have
   * bytes and sends an empty record of a kind that writes each. Usually one
   * table; all three are possible and all three get cleared.
   *
   * A record whose clear does not read back is remembered and not tried again:
   * the read that follows would find it orphaned still, and the tab would
   * spend the rest of the session writing to a byte the board will not take.
   */
  const sweepOrphans = useCallback(
    async (snap: AdvancedKeySnapshot): Promise<{ cleared: number[]; failed: number[] }> => {
      const cleared: number[] = []
      const failed: number[] = []
      if (!codec.writeAdvancedKey) return { cleared, failed }
      for (const record of snap.orphans) {
        if (unsweepable.current.has(record)) continue
        let ok = true
        for (const block of recordBlocks(snap.blobs, record)) {
          const written = await codec.writeAdvancedKey(
            link,
            record,
            emptyAdvancedRecord(KIND_OF_BLOCK[block]),
          )
          if (written.mismatch) {
            ok = false
            break
          }
        }
        if (ok) cleared.push(record)
        else {
          unsweepable.current.add(record)
          failed.push(record)
        }
      }
      return { cleared, failed }
    },
    [codec],
  )

  const read = useCallback(async () => {
    if (!codec.readAdvancedKeys) return
    inFlight.current = true
    setBusy('read')
    setError(null)
    setMismatch(null)
    try {
      let snap = await codec.readAdvancedKeys(link)
      // Inside the read rather than in an effect watching the snapshot: the
      // sweep re-reads, and a re-read drops the draft. Here there is no draft
      // to drop — nothing can be drafted against a snapshot that has not been
      // published yet.
      const { cleared, failed } = await sweepOrphans(snap)
      if (cleared.length > 0) snap = await codec.readAdvancedKeys(link)
      setSnapshot(snap)
      setDraft(null)
      setStatus(null)
      setSwept({ cleared, failed })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [codec, sweepOrphans])

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

  /*
   * And the per-key block, which is where the switch types are. Through the
   * shared queue like the two tabs that already ask for it — it is skipped
   * while their edits are still on the way out, and this tab writes none of it.
   */
  useEffect(() => {
    if (!connected) return
    void boardSync.read()
  }, [connected])

  /**
   * Reads one layer's keymap into `layerBindings`, and hands the base layer on
   * to the legend store.
   *
   * Two callers, and the second is the one that matters outside this tab.
   * Opening a layer needs it for the defaults above. Every write here needs it
   * because **this tab changes what a cap sends**: binding a key to an advanced
   * record replaces its keymap entry, and the remap tab — the only other place
   * that reads the keymap — re-reads on being opened and so looks right, while
   * every other grid in the app draws its caps off `legends` and would go on
   * naming a key the board no longer has. Nothing else re-reads that store, so
   * a write that did not publish here left the whole app stale until the remap
   * tab had been visited.
   *
   * A failure stores an empty layer rather than nothing, so the effect below
   * does not ask a board that will not answer again on every render. The tab
   * still works without it; the pair's dropdowns just start on a dash.
   */
  const refreshKeymap = useCallback(
    async (which: number) => {
      if (!codec.readKeymap) return
      try {
        const entries = await codec.readKeymap(link, which)
        setLayerBindings((prev) => ({ ...prev, [which]: entries }))
        // Only the base layer. An Fn layer is a held state and no grid outside
        // the remap tab draws it — see state/legends.ts.
        if (which === 0) legends.set(entries)
      } catch {
        setLayerBindings((prev) => ({ ...prev, [which]: [] }))
      }
    },
    [codec],
  )

  /* And the open layer's keymap, once per layer, for the defaults above. */
  useEffect(() => {
    if (!connected || !canReadKeymap || layerBindings[layer]) return
    void refreshKeymap(layer)
  }, [connected, canReadKeymap, layer, layerBindings, refreshKeymap])

  const uses = snapshot?.uses.filter((u) => u.layer === layer) ?? []
  const useByKey = new Map<number, AdvancedKeyUse>()
  for (const u of uses) if (u.index >= 0) useByKey.set(u.index, u)

  const pickedKeys: (KeyDef | undefined)[] = picked.map((i) => keys.find((k) => k.index === i))
  const pickedUses = picked.map((i) => useByKey.get(i))

  /** How many caps the open kind is about. */
  const wants = isDuoKind(kind) ? 2 : 1
  const selected = picked[0] ?? null
  const pickedKey = pickedKeys[0]
  const pickedUse = pickedUses[0]
  /** True once every cap the open kind needs has been picked. */
  const complete = picked.length >= wants

  /**
   * The deepest DKS point the picked key's switch can be given, in steps.
   *
   * Floored to a whole 0.1 mm step — see `dksMaxSteps`. With no key picked and
   * on a board whose per-key block has not been read, `travelMmFor` falls back
   * to the layout's nominal stroke, which is what this offered before the
   * switch was consulted at all.
   */
  const dksSteps = dksMaxSteps(
    travelMmFor(selected === null ? undefined : configs[selected]?.switchType),
    spec.encoding.countsPerMm,
  )

  /**
   * What a key sends on the open layer today, as a bare usage.
   *
   * Anything that is not a plain key has none to carry over: a macro, an
   * advanced key or a firmware action is a record, and RS and SOCD read only
   * the two usage bytes of theirs.
   */
  const boundUsage = (index: number): number => {
    const binding = layerBindings[layer]?.[index]?.binding
    if (!binding || binding.kind !== 'key') return 0
    return binding.usage
  }

  /**
   * What the open tab is editing, from the first of three sources that has it.
   *
   * An edit in flight wins, but only while it is *this* kind's: moving to
   * another tab is moving to another record, not converting the one being
   * drafted — so the DKS draft is still there when the DKS tab comes back.
   * Failing that, the board's own record, when the picked cap runs this kind.
   * Failing that, a blank one in the first free slot.
   *
   * That last source is what makes a tab an editor rather than a dropdown
   * entry that has to be chosen before anything appears. It costs nothing:
   * `firstFreeRecord` only reads the tables, so every kind offers the same
   * free record and none of them is written until apply.
   */
  const free = snapshot ? firstFreeRecord(snapshot.blobs, spec.advancedKeys.usable) : -1
  const current: Draft | null =
    draft && draft.kind === kind
      ? draft
      : pickedUse && pickedUse.kind === kind && snapshot
        ? {
            kind: pickedUse.kind,
            record: pickedUse.record,
            rec: decodeAdvancedRecord(snapshot.blobs, pickedUse.record, pickedUse.kind),
            param: pickedUse.param,
          }
        : snapshot && free >= 0
          ? {
              kind,
              record: free,
              rec: startingRecord(kind, spec.encoding.countsPerMm, dksSteps),
              param: kind === 'mt' ? MT_DEFAULT_HOLD_MS / MT_HOLD_MS_PER_UNIT : 0,
            }
          : null

  const edit = (patch: Partial<Draft>) => {
    if (!current) return
    setDraft({ ...current, ...patch })
  }

  /**
   * A record for each half of a pair: the one it already owns, or a free one.
   *
   * `taken` is why this is not two calls to `firstFreeRecord`. Neither record
   * has been written yet, so the tables still read both as free and the second
   * half would be handed the first half's number.
   */
  const pairRecords = ((): [number, number] | null => {
    if (!isDuoKind(kind) || !snapshot || picked.length < 2) return null
    const taken: number[] = []
    const claim = (u: AdvancedKeyUse | undefined): number => {
      if (u && u.kind === kind) return u.record
      const r = freeRecordExcept(snapshot.blobs, spec.advancedKeys.usable, taken)
      if (r >= 0) taken.push(r)
      return r
    }
    const a = claim(pickedUses[0])
    const b = claim(pickedUses[1])
    return a < 0 || b < 0 ? null : [a, b]
  })()

  /** What one half sends: its record's own usage, or what the key sends today. */
  const sentBy = (at: 0 | 1): number => {
    const u = pickedUses[at]
    if (u && u.kind === kind && snapshot) {
      const rec = decodeAdvancedRecord(snapshot.blobs, u.record, u.kind)
      if ('bytes' in rec) return pairUsages(rec).own
    }
    const index = picked[at]
    return index === undefined ? 0 : boundUsage(index)
  }

  const sends: [number, number] =
    duo && duo.kind === kind ? duo.usages : [sentBy(0), sentBy(1)]

  /**
   * One half's record as it would be written.
   *
   * Built on the record the key already owns rather than on a blank, so the
   * bytes these two kinds do not read — the type and modifier bytes the four
   * kinds of this table disagree about — survive an edit of the usages.
   */
  const pairRecordAt = (at: 0 | 1): PairRecord | null => {
    if (!isDuoKind(kind) || !snapshot) return null
    const u = pickedUses[at]
    const held = u && u.kind === kind ? decodeAdvancedRecord(snapshot.blobs, u.record, u.kind) : null
    const base = held && 'bytes' in held ? held : emptyPairRecord(kind)
    return withPairUsages(base, sends[at], sends[at === 0 ? 1 : 0])
  }

  /**
   * Whether the open editor is offering a record that would do nothing.
   *
   * It drives the apply button rather than being checked on the press: the
   * reason belongs beside the fields that would have to change, and a button
   * that says why it is off beats one that refuses after the click. `apply`
   * and `applyPair` check again anyway — they are what writes.
   *
   * A pair is judged on both halves. Half of an RS is not half a feature: the
   * key with nothing bound wins the comparison and then sends nothing.
   */
  const inert = isDuoKind(kind)
    ? picked.length >= 2 &&
      ([0, 1] as const).some((at) => {
        const rec = pairRecordAt(at)
        return rec === null || bindsNothing(rec)
      })
    : current !== null && bindsNothing(current.rec)

  /**
   * The pair, in four writes: both records, then both keymap entries.
   *
   * Both records before either entry, not record-then-entry twice. Each entry
   * names the other key's slot, so after the first pair of writes the board
   * would hold one key resolving against a partner whose own record has not
   * been written — a half-built pair that is live. Records first leaves bytes
   * nothing points at, which is the state this file prefers everywhere.
   *
   * The keymap entries go in one write because they are one write: `writeKeymap`
   * sends the whole layer, and two calls would be two round trips to say what
   * one says.
   */
  const applyPair = async () => {
    if (!isDuoKind(kind) || !codec.writeAdvancedKey || !codec.writeKeymap) return
    if (!snapshot || !pairRecords || picked.length < 2 || inert) return
    const a = picked[0]
    const b = picked[1]
    if (a === undefined || b === undefined) return
    const slotA = snapshot.slotMap.slotByKey.get(a)
    const slotB = snapshot.slotMap.slotByKey.get(b)
    if (slotA === undefined || slotB === undefined) {
      const lost = slotA === undefined ? pickedKeys[0] : pickedKeys[1]
      setError(t('advanced.noSlot', { key: lost?.label ?? '' }))
      return
    }
    const recA = pairRecordAt(0)
    const recB = pairRecordAt(1)
    if (!recA || !recB) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const pairs: [number, PairRecord][] = [
        [pairRecords[0], recA],
        [pairRecords[1], recB],
      ]
      for (const [record, rec] of pairs) {
        const written = await codec.writeAdvancedKey(link, record, rec)
        if (written.mismatch) {
          setMismatch(
            t('advanced.mismatch', {
              record,
              wanted: written.mismatch.wanted,
              got: written.mismatch.got,
            }),
          )
          return
        }
      }
      const type = ADVANCED_TYPE[kind]
      // Each entry carries the *other* key's slot. That is the whole link
      // between the two halves, and the reason this tab asks for both caps.
      const bindingA: KeyBinding = { kind: 'advanced', type, record: pairRecords[0], param: slotB & 0xff }
      const bindingB: KeyBinding = { kind: 'advanced', type, record: pairRecords[1], param: slotA & 0xff }
      const entries: (KeymapEntry | null)[] = keys.map((k) =>
        k.index === a ? { binding: bindingA } : k.index === b ? { binding: bindingB } : null,
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
      setDuo(null)
      await read()
      // The keymap the pair was just written into, so the rest of the app's
      // caps follow it — see `refreshKeymap`.
      await refreshKeymap(layer)
      setStatus(t('advanced.appliedToast'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const apply = async () => {
    if (isDuoKind(kind)) return applyPair()
    if (!current || !codec.writeAdvancedKey || !codec.writeKeymap || selected === null) return
    // A record that binds nothing is refused rather than written — see
    // `bindsNothing`. The button is already off; this is the write saying so.
    if (inert) return
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
      // And the keymap this just wrote into, so the rest of the app's caps
      // follow it — see `refreshKeymap`.
      await refreshKeymap(layer)
      setStatus(t('advanced.appliedToast'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Takes the advanced key off every picked cap.
   *
   * Every, not the first: a pair is one thing, and leaving half of it bound
   * would leave a key resolving against a partner that no longer answers.
   *
   * Two steps, in the mirror image of `apply`: the keymap entries go back to
   * the board's own factory bindings first, so nothing is pointing at a record
   * while it is cleared. A record is only zeroed when **no keymap entry that
   * is still standing names it** — records are shared, and the same advanced
   * key on two layers would otherwise lose its parameters because one of its
   * keys was unbound. The pair's own two entries do not count as still
   * standing: they are the ones being removed.
   *
   * The factory binding comes from the board (0x07), not from this app's idea
   * of the default: the two agree on the base layer, and this app has no idea
   * at all about the Fn one.
   */
  const unbind = async () => {
    if (!codec.writeKeymap || !codec.readKeymapDefaults || !snapshot) return
    const targets = picked
      .map((index) => ({ index, use: useByKey.get(index) }))
      .filter((x): x is { index: number; use: AdvancedKeyUse } => x.use !== undefined)
    if (targets.length === 0) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const table = await codec.readKeymapDefaults(link, layer)
      if (targets.some((x) => !table[x.index])) {
        setError(t('advanced.unbindUnavailable'))
        return
      }
      const entries: (KeymapEntry | null)[] = keys.map((k) => {
        const hit = targets.find((x) => x.index === k.index)
        const factory = hit ? table[hit.index] : undefined
        return factory ? { binding: factory.binding } : null
      })
      const result = await codec.writeKeymap(link, layer, entries)
      if (result.mismatched.length > 0) {
        setMismatch(
          t('advanced.keymapMismatch', {
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
        return
      }
      const gone = new Set(targets.map((x) => `${layer}:${x.use.slot}`))
      const cleared: number[] = []
      const kept: number[] = []
      for (const { use } of targets) {
        if (cleared.includes(use.record) || kept.includes(use.record)) continue
        const shared = snapshot.uses.some(
          (u) => u.record === use.record && !gone.has(`${u.layer}:${u.slot}`),
        )
        if (shared) {
          kept.push(use.record)
          continue
        }
        if (codec.writeAdvancedKey) {
          await codec.writeAdvancedKey(link, use.record, emptyAdvancedRecord(use.kind))
        }
        cleared.push(use.record)
      }
      setDraft(null)
      setDuo(null)
      await read()
      // The caps are back on their factory bindings; the rest of the app has
      // to be told — see `refreshKeymap`.
      await refreshKeymap(layer)
      setStatus(t('advanced.unboundToast'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * A click on a cap, which means different things to the two sorts of kind.
   *
   * Clicking a cap that is already picked drops it, whichever kind is open.
   * Otherwise: a cap that already runs a pair brings its partner in with it —
   * its record names the other key's slot, so the app knows which two keys the
   * click was about, and the alternative is making someone reconstruct a pair
   * they can see on the grid. A pair kind short of its second cap adds one. And
   * anything else starts over on the clicked cap.
   */
  const pick = (index: number) => {
    const u = useByKey.get(index)
    // A cap bound to another kind moves the strip, so the caps picked for the
    // kind being left are not carried into the one arriving.
    const changing = u !== undefined && u.kind !== kind
    const mate =
      u && isDuoKind(u.kind) ? snapshot?.slotMap.keyBySlot.get(u.param)?.index : undefined
    let next: number[]
    if (picked.includes(index)) next = picked.filter((i) => i !== index)
    else if (mate !== undefined && mate !== index) next = [index, mate]
    else if (!changing && isDuoKind(kind) && picked.length < 2) next = [...picked, index]
    else next = [index]
    setPicked(next)
    setDraft(null)
    /*
     * The pair's draft survives the second cap arriving: the usage already
     * chosen for the first is what the apply is being built out of, and
     * dropping it would punish doing the two picks in the obvious order.
     */
    const adding = picked.length === 1 && next.length === 2 && next[0] === picked[0]
    if (!adding) setDuo(null)
    // Whatever was waiting was waiting about the caps that were picked before
    // this click, so it is not waiting any more.
    setWaitingOn(null)
    /*
     * A cap already bound to a kind opens that kind — unless the strip is not
     * offering it (see `UNSTABLE_KINDS`), where the strip stays put and the
     * panel's "this key is already bound as …" notice is what says so. That
     * leaves the one way out of an unstable binding without debug mode: apply
     * another kind over the cap.
     */
    if (u && offered.includes(u.kind)) setOpen(u.kind)
  }


  /*
   * The input-point tab's band with both multi-select gestures off, the same
   * as the remap tab: an advanced key is bound to one cap, so "select all"
   * would offer a set nothing on this tab can act on.
   *
   * The layer sits in the bar rather than on a strip of its own, the way the
   * remap tab keeps it: which key runs an advanced key is a keymap entry, so
   * it is per layer — and the grid is the thing that follows it.
   */
  /*
   * What the cap under the pointer is running, spelled out under the grid.
   *
   * The caps themselves keep the board's printing — a key bound to an advanced
   * key has no keymap record left that names anything a person chose, so the
   * legend that used to read `Adv key 3` now reads what the key is. That moves
   * the whole answer down here, and this is the one place in the app that can
   * give it: the three tables are read by this tab, and the record is what says
   * what the key does.
   *
   * Rows rather than uses, so an RS or SOCD pair is answered as the one setting
   * it is — pointing at either half reads out both. Same folding the in-use
   * table does, and the same component reads it out, in its one-line mode.
   */
  const rows = rowsOf(uses)
  const readingKey = hovered ?? picked[0] ?? null
  const readingRow =
    readingKey === null
      ? undefined
      : rows.find((r) => r.uses.some((u) => u.index === readingKey))

  const grid = (
    <GridFrame
      selectable={false}
      marquee={false}
      foot={
        canRead ? (
          readingRow ? (
            <span>
              {t('advanced.foot.runs', {
                keys: readingRow.uses
                  .map((u) => u.label || t('advanced.unmappedSlot', { slot: u.slot }))
                  .join(', '),
                kind: t(kindKey(readingRow.kind)),
              })}
              {/* The record number only where the rest of them are — see the
                  in-use table's `debug` column. */}
              {debug && ` #${readingRow.uses.map((u) => u.record).join(', #')}`}
              {' · '}
              <Argument row={readingRow} snapshot={snapshot} inline />
            </span>
          ) : (
            <span>{t(uses.length === 0 ? 'advanced.noneBound' : 'advanced.foot.none')}</span>
          )
        ) : undefined
      }
      top={
        canRead ? (
          /* The same section strip the remap tab's layers get, for the same
             reason — see the comment on the strip there. */
          <div className="layer-tabs" role="tablist" aria-label={t('advanced.layers')}>
            {Array.from({ length: spec.keymap.layers }, (_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === layer}
                onClick={() => {
                  setLayer(i)
                  setDraft(null)
                  setDuo(null)
                  setWaitingOn(null)
                }}
              >
                {layerName(i)}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <KeyGrid
        selected={picked.length === 0 ? undefined : new Set(picked)}
        // A cap that already runs an advanced key opens on its own kind. The
        // strip is where the kind is chosen now, so landing anywhere else
        // would hide the very record the click asked about. See `pick`.
        onSelect={pick}
        /* What the foot is reading out. Cleared on the way off the grid, so
           the line falls back to the picked key rather than to the last cap
           the pointer happened to cross on its way out. */
        onHover={(i) => setHovered(i ?? null)}
        /*
         * Which layer's advanced keys are on the caps.
         *
         * The grid draws the band itself and would otherwise draw the base
         * layer's, which is right on every tab but this one and the remap tab —
         * here the layer is the thing being chosen, and an Fn layer's bands are
         * not layer 0's. Handed over only once the read has landed: until then
         * the grid's own answer is the better one, and a band that dropped off
         * every cap for the length of a read is exactly what switching to this
         * tab used to look like.
         */
        advanced={snapshot ? (key) => useByKey.get(key.index)?.kind : true}
        label={(key) => {
          const u = useByKey.get(key.index)
          // `undefined`, not `''`: a key with no advanced record has nothing
          // this tab wants to say about it, so it keeps the legend the rest of
          // the app gives it rather than being blanked. Which slot holds it is
          // the same answer without the flag on — the line under the cap already
          // says the kind, so the legend it came with is worth more than a
          // record number nothing outside debug mode can act on.
          if (!u || !debug) return undefined
          return t('advanced.capLabel', { kind: t(kindKey(u.kind)), record: u.record })
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
        </Panel>
      </>
    )
  }

  /**
   * The open kind's panel — the one thing every tab on the strip renders.
   *
   * One panel rather than six, because the six differ only in the fields
   * `Editor` already switches on: the cap, the record and the two writes are
   * the same sentence whichever kind is being written. Building it here and
   * handing the same element to every tab is what keeps them from drifting.
   */
  const editor = (
    <Panel title={t(kindKey(kind))} hintKey={`advanced.hints.${kind}` as const}>
      {!complete && (
        <PickPrompt
          picked={pickedKeys}
          wants={wants}
          /* Two caps for a pair, and the line says which one is still wanted
             rather than repeating "pick a key" at someone who just did. */
          helpKey={pickHelpKey(isDuoKind(kind), picked.length)}
        />
      )}

      {complete && isDuoKind(kind) && (
        <div className="adv-body">
          {/*
            One row per cap: the key that was picked, and what it sends. No
            partner slot — the slot map already knows both, and each record is
            handed the other's when apply runs.
          */}
          {([0, 1] as const).map((at) => {
            const key = pickedKeys[at]
            const record = pairRecords?.[at]
            return (
              <Row key={at} label={key?.label ?? String(picked[at] ?? '')}>
                <UsageSelect
                  label={t('advanced.pair.sends', { key: key?.label ?? '' })}
                  value={sends[at]}
                  disabled={busy !== null || !canWrite}
                  {...arming(waitingOn, setWaitingOn, `sends${at}`)}
                  onChange={(usage) => {
                    const usages: [number, number] = [sends[0], sends[1]]
                    usages[at] = usage
                    setDuo({ kind, usages })
                  }}
                />
                {debug && (
                  <span className="small dim">
                    {record === undefined ? '' : `#${record}`}
                    {(() => {
                      const rec = pairRecordAt(at)
                      return rec ? ` · ${recordBytes(rec)}` : ''
                    })()}
                  </span>
                )}
              </Row>
            )
          })}
          {!pairRecords && (
            <Notice kind="err">
              {t('advanced.noFreeRecord', { limit: spec.advancedKeys.usable })}
            </Notice>
          )}
          {inert && (
            <div className="small dim" style={{ marginTop: 8 }}>
              <T k="advanced.bindsNothing" />
            </div>
          )}
          <div className="row adv-actions">
            <button
              disabled={busy !== null || !canWrite || !pairRecords || inert}
              onClick={() => void apply()}
            >
              {busy === 'write' ? t('advanced.applying') : t('advanced.apply')}
            </button>
            {duo?.kind === kind && (
              <button className="ghost" disabled={busy !== null} onClick={() => setDuo(null)}>
                {t('advanced.revert')}
              </button>
            )}
            {pickedUses.some((u) => u !== undefined) && (
              <button
                className="ghost"
                disabled={busy !== null || !canUnbind}
                onClick={() => void unbind()}
              >
                {t('advanced.unbind')}
              </button>
            )}
          </div>
        </div>
      )}

      {complete && !isDuoKind(kind) && pickedKey && (
        <div className="adv-body">
          <Row label={t('advanced.key')}>
            <strong>{pickedKey.label}</strong>
          </Row>
          {/*
            The cap already runs a different kind. Applying from here moves it
            to this one and leaves the old record pointed at by nothing —
            recoverable, but not obvious, so it is said before the fields.
          */}
          {pickedUse && pickedUse.kind !== kind && (
            <Notice kind="info">
              {t('advanced.otherKind', {
                kind: t(kindKey(pickedUse.kind)),
                record: pickedUse.record,
              })}
            </Notice>
          )}
          {!current && (
            <Notice kind="err">
              {t('advanced.noFreeRecord', { limit: spec.advancedKeys.usable })}
            </Notice>
          )}
          {current && (
            <>
              {debug && (
                <Row label={t('advanced.record')}>
                  <span className="small">
                    #{current.record} · <code>{recordBytes(current.rec)}</code>
                  </span>
                </Row>
              )}
              <Editor
                draft={current}
                maxSteps={dksSteps}
                disabled={busy !== null || !canWrite}
                onChange={(rec, param) => edit({ rec, param })}
              />
              {inert && (
                <div className="small dim" style={{ marginTop: 8 }}>
                  <T k="advanced.bindsNothing" />
                </div>
              )}
              <div className="row adv-actions">
                <button
                  disabled={busy !== null || !canWrite || inert}
                  onClick={() => void apply()}
                >
                  {busy === 'write' ? t('advanced.applying') : t('advanced.apply')}
                </button>
                {/*
                  Only with something to revert *to*: a blank draft in a free
                  record is what the tab shows with no draft at all, so the
                  button would undo nothing.
                */}
                {draft?.kind === kind && (
                  <button className="ghost" disabled={busy !== null} onClick={() => setDraft(null)}>
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

      {debug && swept.cleared.length > 0 && (
        <Notice kind="info">
          {t('advanced.orphansCleared', { records: recordList(swept.cleared) })}
        </Notice>
      )}
      {debug && swept.failed.length > 0 && (
        <Notice kind="err">
          {t('advanced.orphansFailed', { records: recordList(swept.failed) })}
        </Notice>
      )}
      {mismatch && <Notice kind="err">{mismatch}</Notice>}
      {error && <Notice kind="err">{error}</Notice>}
    </Panel>
  )

  /**
   * One tab per kind, in the order the protocol lists them.
   *
   * They are the dropdown that used to sit in the panel, turned into the strip
   * the rest of the app chooses sections with: they are visible at once instead
   * of behind a click, and opening one *is* opening its editor rather than
   * picking a value that has to be applied before anything shows.
   */
  const tabs: SubTab[] = offered.map((k) => ({
    id: k as string,
    labelKey: kindKey(k),
    render: () => editor,
  }))

  return (
    <>
      {grid}
      <SubTabs
        tabs={tabs}
        label={t('advanced.kind')}
        active={kind}
        onActive={(id) => {
          // Moving to another tab is moving to another record, not converting
          // the picked key's. Leaving the cap selected would have the new tab
          // offering to rewrite a key nobody asked about on the way in — so
          // the grid goes back to nothing picked, and the pick is the next step.
          setOpen(id as AdvancedKind)
          setPicked([])
          setDraft(null)
          setDuo(null)
          setWaitingOn(null)
        }}
      />

      {/*
        Outside the panel, and outside the strip that swaps its contents: it is
        fixed to the window rather than laid out in the tab, and a confirmation
        must not go away with the section that raised it. See `.toast` in
        styles.css.
      */}
      <MessageToast message={status} onDone={clearStatus} />
    </>
  )
}

/**
 * The bytes the apply button would send, through the same encoder it uses.
 *
 * Not a second rendering of the draft: a DKS stage mask is derived from the
 * span, so a display that rebuilt the bytes its own way could show one thing
 * and write another.
 */
function recordBytes(rec: AdvancedRecord): string {
  return Array.from(encodeAdvancedRecord(rec), (b) => b.toString(16).padStart(2, '0')).join(' ')
}

/**
 * What a kind's editor opens on, for a cap that has nothing on it yet.
 *
 * The empty record for five of the six. DKS gets its four points put where
 * `DKS_START_MM` says, because an empty one is four points at zero depth,
 * which is a stroke with no shape to read and four sliders to move before
 * anything can be seen.
 *
 * The seeding is here and not in `emptyAdvancedRecord`: that one is what
 * *clearing* a record writes, and it has to stay all zeros.
 */
function startingRecord(
  kind: AdvancedKind,
  countsPerMm: number,
  maxSteps: number,
): AdvancedRecord {
  const rec = emptyAdvancedRecord(kind)
  if (rec.kind !== 'dks') return rec
  return {
    ...rec,
    thresholds: DKS_START_MM.map((mm) => Math.min(maxSteps, dksMmToSteps(mm, countsPerMm))),
  }
}

/** Record numbers the way every message here spells them. */
function recordList(records: readonly number[]): string {
  return records.map((r) => `#${r}`).join(', ')
}

/** Which "pick a key" line to draw, given what the open kind still wants. */
function pickHelpKey(duo: boolean, got: number) {
  if (!duo) return 'advanced.pickKey' as const
  return got === 0 ? ('advanced.pair.pickTwo' as const) : ('advanced.pair.pickSecond' as const)
}

/**
 * The panel before there is anything in it: a slot per cap the kind is about,
 * and the line saying what to do.
 *
 * This was the line alone, which left a panel that had a heading and a sentence
 * and nothing with a shape to it — a section that reads as empty rather than as
 * waiting. A slot per cap says how many the kind takes *before* the first one
 * is picked, which is the thing a pair kind most needs to say: RS and SOCD want
 * two, and finding that out by picking one and being told to pick another is
 * finding it out a step late.
 *
 * The filled slot wears the grid's own selected cap — same fill, same edge —
 * because it is standing in for exactly that: the cap lit up on the board a
 * few hundred pixels above it. Two pictures of one thing that disagreed about
 * what it looked like would be two things.
 *
 * Only the slots that are still empty are `+`. A pair with one cap picked draws
 * that cap and one `+`, so what is being waited for is the thing on screen that
 * is not yet filled in.
 */
function PickPrompt({
  picked,
  wants,
  helpKey,
}: {
  /** The caps picked so far, in click order — shorter than `wants` until done. */
  picked: readonly (KeyDef | undefined)[]
  wants: number
  helpKey: MessageKey
}) {
  return (
    <div className="adv-pick">
      <div className="adv-pick-slots">
        {Array.from({ length: wants }, (_, at) => {
          const cap = picked[at]
          return (
            <span className={`adv-pick-slot${cap ? ' filled' : ''}`} key={at}>
              {/*
                Keyed on what it holds, so a cap arriving is a new element and
                fades in on its own — the slot around it stays put and lets its
                fill and edge run the transition. A label swapped in place would
                land between two frames, which is the one thing this is for.
              */}
              <span className="adv-pick-mark" key={cap ? cap.label : '+'}>
                {cap ? cap.label : '+'}
              </span>
            </span>
          )
        })}
      </div>
      <div className="adv-pick-say">
        <T k={helpKey} />
      </div>
    </div>
  )
}

/**
 * One binding's stroke: four stages, and the bar across the ones it is held
 * down for.
 *
 * Its own component because the gesture needs refs, and the four of these are
 * built in a loop — a hook cannot live there. It owns no state: the span is
 * the record's, and every change goes straight back up through `onSpan`, so
 * what is drawn and what will be written are the same thing at every frame of
 * a drag.
 *
 * ### Two ways to say the same thing
 *
 * **Drag** draws the bar directly: press on the stage the binding should go
 * down at and pull to the one it should come up at, either direction. This is
 * the one that matches what the bar looks like — a thing with two ends and a
 * length — and it reaches any span in one gesture.
 *
 * **Click** is what is left when the pointer never moved, and keeps the rule
 * it had before the drag existed: outside the bar, reach for that stage;
 * inside it, let the other end go and leave a tap. It is also the whole of the
 * keyboard path — the nodes are buttons, and a click with `detail === 0` is
 * Enter or Space on the focused one.
 *
 * The drag is hit-tested rather than listened for on each node, for the reason
 * the key grid's paint is: the track captures the pointer on the way down, so
 * the nodes themselves stop hearing about it.
 */
function DksTrack({
  span,
  bound,
  disabled,
  onSpan,
}: {
  span: DksSpan
  /** False on a row with no key on it — nothing to give a stroke to. */
  bound: boolean
  disabled: boolean
  onSpan: (pressAt: number, releaseAt: number) => void
}) {
  const t = useT()
  const track = useRef<HTMLDivElement | null>(null)
  /** The stage the gesture started on, and whether it has left it yet. */
  const drag = useRef<{ anchor: number; moved: boolean; sent: string } | null>(null)

  const stageUnder = (x: number, y: number): number | undefined => {
    const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('.dks-cell')
    if (!cell || !track.current?.contains(cell)) return undefined
    const at = cell.dataset.stage
    return at === undefined ? undefined : Number(at)
  }

  const start = (e: React.PointerEvent, at: number) => {
    // Left button only, the way the grid's paint is: a right-click is the
    // context menu and a middle-click paste has no business here.
    if (disabled || !bound || e.button !== 0) return
    drag.current = { anchor: at, moved: false, sent: '' }
    // The span is left alone until the pointer moves. Setting a tap here would
    // make every click a tap and take the click rule away with it.
    try {
      track.current?.setPointerCapture(e.pointerId)
    } catch {
      // Without capture the drag still works inside the track.
    }
  }

  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const at = stageUnder(e.clientX, e.clientY)
    if (at === undefined) return
    if (at !== d.anchor) d.moved = true
    if (!d.moved) return
    // Dragging back onto the anchor is a tap there, which is why this runs off
    // `moved` rather than off the two stages differing.
    const lo = Math.min(d.anchor, at)
    const hi = Math.max(d.anchor, at)
    const sent = `${lo}:${hi}`
    if (sent === d.sent) return
    d.sent = sent
    onSpan(lo, hi)
  }

  const end = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (track.current?.hasPointerCapture(e.pointerId)) {
      track.current.releasePointerCapture(e.pointerId)
    }
    if (d && !d.moved) click(d.anchor)
  }

  const click = (at: number) => {
    if (disabled || !bound) return
    if (at < span.pressAt) onSpan(at, span.releaseAt)
    else if (at > span.releaseAt) onSpan(span.pressAt, at)
    else onSpan(at, at)
  }

  return (
    <div
      className="dks-track"
      ref={track}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {bound && (
        <span
          className="dks-bar"
          style={{
            top: `${((span.pressAt + 0.5) / DKS_STAGES) * 100}%`,
            height: `${((span.releaseAt - span.pressAt) / DKS_STAGES) * 100}%`,
          }}
        />
      )}
      {Array.from({ length: DKS_STAGES }, (_, at) => {
        const held = bound && at >= span.pressAt && at <= span.releaseAt
        const name = t(DKS_STAGE_KEYS[at] ?? DKS_STAGE_KEYS[0])
        return (
          <div className="dks-cell" key={at} data-stage={at}>
            <button
              type="button"
              className={`dks-node${held ? ' on' : ''}`}
              disabled={disabled || !bound}
              aria-pressed={held}
              aria-label={name}
              title={name}
              onPointerDown={(e) => start(e, at)}
              onClick={(e) => {
                // The pointer path already ran on the way up. A click with no
                // pointer behind it is the keyboard activating the focused
                // node, which is the only case left to handle.
                if (e.detail === 0) click(at)
              }}
            >
              {held ? '' : '+'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** The per-kind fields. One component because they share the draft's shape. */
function Editor({
  draft,
  maxSteps,
  disabled,
  onChange,
}: {
  draft: Draft
  /** The deepest DKS point the picked key's switch reaches — see `dksMaxSteps`. */
  maxSteps: number
  disabled: boolean
  onChange: (rec: AdvancedRecord, param: number) => void
}) {
  const t = useT()
  const spec = useDeviceSpec()
  const countsPerMm = spec.encoding.countsPerMm
  /*
   * Which field is waiting for a keystroke — see `arming`. One flag for the
   * whole editor, so mod-tap's tap and hold cannot both be waiting on the one
   * key that is about to be pressed.
   *
   * It survives a change of kind, which is harmless: the ids below are unique
   * across all of them, so a flag left on `tap` matches nothing in the panel
   * that arrives. Changing kind unmounts this anyway — the strip clears the
   * picked cap, and there is no editor without one.
   */
  const [waitingOn, setWaitingOn] = useState<string | null>(null)
  const arm = (id: string) => arming(waitingOn, setWaitingOn, id)

  if (draft.rec.kind === 'dks') {
    const rec = draft.rec
    const setSpanOf = (i: number, span: DksSpan, next: Partial<DksSpan>) => {
      /*
       * The mask is recomputed here rather than left to the encoder alone, so
       * the draft carries the bytes it will be written as — the hex line above
       * reads it, and a stale mask would make that line a lie.
       */
      const merged = { ...span, ...next }
      const spans = rec.spans.slice()
      spans[i] = {
        ...merged,
        mask: merged.binding.kind === 'none' ? 0 : encodeDksSpan(merged.pressAt, merged.releaseAt),
      }
      onChange({ ...rec, spans }, draft.param)
    }

    /** One depth point: which way it is tested, the slider, and the reading. */
    const depth = (i: number) => (
      <div className="dks-depth" key={i}>
        <span className="dks-way" aria-hidden="true">
          {i < DKS_STAGES / 2 ? '▼' : '▲'}
        </span>
        <Slider
          min={0}
          max={maxSteps}
          step={1}
          disabled={disabled}
          aria-label={t(DKS_POINT_KEYS[i] ?? DKS_POINT_KEYS[0])}
          value={rec.thresholds[i] ?? 0}
          onChange={(e) => {
            const thresholds = rec.thresholds.slice()
            thresholds[i] = Number(e.target.value)
            onChange({ ...rec, thresholds }, draft.param)
          }}
        />
        <span className="dks-mm small">
          {dksStepsToMm(rec.thresholds[i] ?? 0, countsPerMm).toFixed(1)} mm
        </span>
      </div>
    )

    /*
     * The stroke, drawn down the page as the axis it is.
     *
     * This was four sliders and then four rows of "binding, press at, release
     * at", which is the record read out field by field and leaves the reader
     * to hold the shape of the stroke in their head. The shape *is* the
     * setting: a DKS key is four depths through one press and four things that
     * come down and go up between them.
     *
     * So the four depth points are four rows in stroke order and each binding
     * is a column with a bar down the stages it is held for. Down the page
     * rather than across it, because that is the direction the key travels:
     * the deeper point is the lower row, and the two halves stack the way the
     * firmware checks them — the top two tested going down, the bottom two
     * coming back up, which is why the depths count back towards the top of
     * the key below the seam.
     *
     * The stroke sits at the head of the block and the four depths at the far
     * end of it. The stroke is a narrow thing — four nodes and a bar — and
     * giving it the whole width left it adrift; pushed apart, each is the size
     * of what it holds and the space between them is what separates the two
     * questions, which stage a binding runs on and how deep that stage is.
     *
     * Which way the key is going is said once per half, down the margin the
     * rows start at, because it is true of a row rather than of either of the
     * things in it.
     */
    return (
      <>
        <div className="dks">
          {/* One picker per column, over the track it fills. */}
          <div className="dks-heads">
            <span className="dks-halves" />
            {Array.from({ length: DKS_BINDINGS }, (_, i) => {
              const span = rec.spans[i]
              if (!span) return null
              const bound = span.binding.kind !== 'none'
              return (
                <div className="dks-head" key={`h${i}`}>
                  <BindingSelect
                    label={t('advanced.dks.binding', { n: i + 1 })}
                    value={span.binding}
                    disabled={disabled}
                    onChange={(binding) =>
                      // A column that had nothing on it gets the ordinary
                      // key's span — down at the first point, up at the last —
                      // rather than a tap at stage 0, which is what an empty
                      // record decodes to and almost never what was wanted.
                      setSpanOf(
                        i,
                        span,
                        binding.kind !== 'none' && !bound
                          ? { binding, pressAt: 0, releaseAt: DKS_STAGES - 1 }
                          : { binding },
                      )
                    }
                  />
                </div>
              )
            })}
            {/* Nothing to put over the depths, and the column has to be here
                anyway: it is what makes this row lay out like the one below. */}
            <span className="dks-side" />
          </div>

          <div className="dks-body">
            <div className="dks-halves small dim">
              <span className="dks-half">{t('advanced.dks.onPress')}</span>
              <span className="dks-half">{t('advanced.dks.onRelease')}</span>
            </div>
            {Array.from({ length: DKS_BINDINGS }, (_, i) => {
              const span = rec.spans[i]
              if (!span) return null
              return (
                <DksTrack
                  key={`b${i}`}
                  span={span}
                  bound={span.binding.kind !== 'none'}
                  disabled={disabled}
                  onSpan={(pressAt, releaseAt) => setSpanOf(i, span, { pressAt, releaseAt })}
                />
              )
            })}
            <div className="dks-side">
              {Array.from({ length: DKS_STAGES }, (_, i) => depth(i))}
            </div>
          </div>
        </div>
      </>
    )
  }

  if (draft.rec.kind === 'tgl') {
    const rec: ToggleRecord = draft.rec
    return (
      <>
        <Row label={t('advanced.tgl.key')}>
          <BindingSelect
            label={t('advanced.tgl.key')}
            value={rec.binding}
            disabled={disabled}
            {...arm('tgl')}
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
        <Row label={t('advanced.mt.tap')}>
          <BindingSelect
            label={t('advanced.mt.tap')}
            value={tap}
            disabled={disabled}
            {...arm('tap')}
            onChange={(b) => onChange(withMtBindings(rec, b, hold), draft.param)}
          />
        </Row>
        <Row label={t('advanced.mt.hold')}>
          <BindingSelect
            label={t('advanced.mt.hold')}
            value={hold}
            disabled={disabled}
            {...arm('hold')}
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

  /*
   * RS and SOCD never reach here: they are a pair of caps, and the tab draws
   * them itself so it can hold both keys' records at once. What is left is
   * OKS, whose record really is one key's two usages.
   */
  if (rec.kind !== 'oks') return null

  const oks = oksBindings(rec)
  return (
    <>
      <Row label={t('advanced.pair.own')}>
        <UsageSelect
          label={t('advanced.pair.own')}
          value={oks.own}
          disabled={disabled}
          {...arm('own')}
          onChange={(usage) =>
            onChange(withOksBindings(rec, usage, oks.onRelease, oks.holdTicks), draft.param)
          }
        />
      </Row>
      <Row label={t('advanced.oks.onRelease')}>
        <UsageSelect
          label={t('advanced.oks.onRelease')}
          value={oks.onRelease}
          disabled={disabled}
          {...arm('onRelease')}
          onChange={(usage) =>
            onChange(withOksBindings(rec, oks.own, usage, oks.holdTicks), draft.param)
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
    </>
  )
}
