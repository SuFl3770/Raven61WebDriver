/**
 * Advanced keys — DKS, TGL, MT, RS, SOCD and OKS, as the firmware runs them.
 *
 * This block came out of the **firmware**, not the driver, and that matters
 * twice over. The stock driver's own database ships empty of advanced keys
 * (`t_magnetic_key_data` has no rows in either capture), so the DB gave the
 * schema and nothing else; and the driver's write path is what caught this
 * project's flash map being wrong. Its three "apply" functions — 0x429a60,
 * 0x42a740, 0x42b560 — each send `0xa3`, `0xa5` **and** `0xa7`, one after the
 * other. Nothing that writes lighting would do that, and the firmware agrees:
 * no LED code reads 0x224f0 or 0x225f0, and the only code that does is the
 * advanced-key handlers below. So this is one feature spread over three blocks,
 * not one block plus two lighting blocks.
 *
 * ### How a key becomes an advanced key
 *
 * The keymap record does it. Type bytes 0x90-0x95 pick the kind, `param` is the
 * record number in the tables here, and `code` is a per-kind argument — the
 * partner key's slot for RS/SOCD/OKS, the hold time for MT. The dispatch is
 * 0x9ec6: it reads the type byte and hands `param` and `code` to one handler
 * per kind.
 *
 *     0x90 DKS   0x8828, reached from the analog scan at 0xf088
 *     0x91 TGL   0x8c9e
 *     0x92 MT    0x8dea
 *     0x93 RS    0x99d0
 *     0x94 SOCD  0x9bc6
 *     0x95 OKS   0x9d2e
 *
 * DKS is the one kind 0x9ec6 does **not** dispatch — it falls through to the
 * default arm. It cannot be driven by a key-down edge, because it acts on where
 * in the stroke the key is, so the analog scan calls it directly every pass
 * with the current depth.
 *
 * ### The three tables
 *
 * All three are indexed by the same record number, so one advanced key owns
 * record `n` in whichever table its kind uses:
 *
 *     0x22100  1024 B  42 x 24  DKS               read 0xa2, write 0xa3
 *     0x224f0   256 B  42 x  6  MT/RS/SOCD/OKS    read 0xa4, write 0xa5
 *     0x225f0   256 B  42 x  3  TGL               read 0xa6, write 0xa7
 *
 * 42 x 24 = 1008, and 0x22100 + 1008 is exactly 0x224f0 — the three are one
 * contiguous run, which is part of why they read as neighbours of different
 * kinds. 42 records against the driver's documented limit of 40 per profile
 * leaves the same two spare in every table.
 *
 * The RS/SOCD/OKS handlers address the 6-byte table as
 * `0x224f0 + record * 6 + page * 256`, where `page` is the byte at `gp-0x7b7`.
 * Nothing in the image writes that byte, so it is 0 and the second page is
 * unreachable — noted because on a sibling board with profiles it would not be,
 * and it would be the second copy of this table.
 */
import type { AdvancedKeySpec } from '../device/spec'
import { COUNTS_PER_MM } from './encoding'
import { RECORD_TYPE, decodeRecord, encodeRecord, type KeyBinding } from './keymap'

/** Records in every table. 1024 / 24, and the other two match it. */
export const ADVANCED_KEY_COUNT = 42

/**
 * How many of those the stock driver will use — its "40 advanced keys per
 * profile" limit.
 *
 * The firmware has no such limit: `param` is a byte and the handlers index
 * straight off it, so records 40 and 41 work. The cap is kept anyway, so a
 * board configured here stays readable in the stock driver.
 */
export const ADVANCED_KEY_USABLE = 40

/** The three blocks, with the flash addresses the evidence is quoted against. */
export const ADVANCED_KEY_BLOCKS = {
  /** DKS only. Four depth thresholds, then four 5-byte stage bindings. */
  dks: { base: 0x22100, recordSize: 24, blobSize: 1024 },
  /** MT, RS, SOCD and OKS — two 3-byte slots per record. */
  pair: { base: 0x224f0, recordSize: 6, blobSize: 256 },
  /** TGL — one 3-byte record. */
  toggle: { base: 0x225f0, recordSize: 3, blobSize: 256 },
} as const

export type AdvancedBlock = keyof typeof ADVANCED_KEY_BLOCKS

/**
 * The geometry a caller gets when it names no spec.
 *
 * Assembled from the constants above rather than restating them, so the
 * evidence stays with the numbers — the same arrangement `DEFAULT_KEYMAP` uses.
 */
export const DEFAULT_ADVANCED_KEYS: AdvancedKeySpec = {
  records: ADVANCED_KEY_COUNT,
  usable: ADVANCED_KEY_USABLE,
  dksRecordSize: ADVANCED_KEY_BLOCKS.dks.recordSize,
  dksBlobSize: ADVANCED_KEY_BLOCKS.dks.blobSize,
  pairRecordSize: ADVANCED_KEY_BLOCKS.pair.recordSize,
  pairBlobSize: ADVANCED_KEY_BLOCKS.pair.blobSize,
  toggleRecordSize: ADVANCED_KEY_BLOCKS.toggle.recordSize,
  toggleBlobSize: ADVANCED_KEY_BLOCKS.toggle.blobSize,
}

/** Blob size of one table, from a spec. */
export function advancedBlobSize(
  block: AdvancedBlock,
  spec: AdvancedKeySpec = DEFAULT_ADVANCED_KEYS,
): number {
  if (block === 'dks') return spec.dksBlobSize
  if (block === 'pair') return spec.pairBlobSize
  return spec.toggleBlobSize
}

/** The six kinds, in the order their type bytes run. */
export const ADVANCED_KINDS = ['dks', 'tgl', 'mt', 'rs', 'socd', 'oks'] as const

export type AdvancedKind = (typeof ADVANCED_KINDS)[number]

/**
 * Kinds the firmware decodes but does not run reliably.
 *
 * OKS is read and written here like the other five, and the bytes go in and
 * read back as sent — but the handler behind them misbehaves on the board, so
 * a key bound to one does not do what the record says. That is not something a
 * host can encode its way out of, so the advanced-keys tab leaves the section
 * off its strip and nobody is offered a setting that will not hold.
 *
 * A claim about the firmware rather than about the table, which is why it sits
 * beside the kinds and not in `AdvancedKeySpec`: every board this codec drives
 * runs the same handler. A board that fixed it would be the reason to move this
 * into the spec and let each one say for itself.
 *
 * Debug mode ignores the list — an unstable kind is exactly what the protocol
 * work needs to be able to reach. See features/Advanced.
 */
export const UNSTABLE_KINDS: readonly AdvancedKind[] = ['oks']

export const ADVANCED_TYPE: Record<AdvancedKind, number> = {
  dks: RECORD_TYPE.dks,
  tgl: RECORD_TYPE.tgl,
  mt: RECORD_TYPE.mt,
  rs: RECORD_TYPE.rs,
  socd: RECORD_TYPE.socd,
  oks: RECORD_TYPE.oks,
}

/** Which table a kind keeps its parameters in. */
export const ADVANCED_BLOCK_OF: Record<AdvancedKind, AdvancedBlock> = {
  dks: 'dks',
  tgl: 'toggle',
  mt: 'pair',
  rs: 'pair',
  socd: 'pair',
  oks: 'pair',
}

export function kindOfType(type: number): AdvancedKind | undefined {
  return ADVANCED_KINDS.find((k) => ADVANCED_TYPE[k] === type)
}

/**
 * How a kind is named, everywhere it is named.
 *
 * A bundle key rather than a name: the six are initialisms the bundles spell
 * out, and both the editor and the in-use table list all six. Here rather than
 * in either of them because they render each other — the tab draws the table
 * — and a helper one of them exported would be a cycle.
 */
export function kindKey(kind: AdvancedKind) {
  return `advanced.kinds.${kind}` as const
}

/**
 * Kinds that need a second physical key, and take its slot in the keymap
 * record's third byte.
 *
 * OKS is in the list because its handler reads the partner's key-down flag
 * before firing (0x9de4), even though its own bindings are a single key's.
 */
export const PAIRED_KINDS: readonly AdvancedKind[] = ['rs', 'socd', 'oks']

/**
 * The three bytes a binding takes inside these tables.
 *
 * Not `encodeRecord` directly, because the two disagree about *nothing*.
 * `encodeRecord` writes `10 00 00` for an unbound key, which is what the stock
 * driver's keymap encoder does and the right answer in a keymap: 0x00 there is
 * a type the boot check accepts but 0xff is the factory's own marker, so the
 * driver picked the third. In these tables the question is different. A record
 * of all zeros is what the factory reset leaves and what `isFreeRecord` reads
 * as "nobody is using this", so an unbound binding written as `10 00 00` would
 * quietly retire a record that is still free.
 */
function bindingBytes(binding: KeyBinding): [number, number, number] {
  return binding.kind === 'none' ? [0, 0, 0] : encodeRecord(binding)
}

/* ------------------------------------------------------------------ DKS -- */

/** Depth stages in a DKS record: two on the way down, two on the way up. */
export const DKS_STAGES = 4

/** Bindings a DKS record can fire. One 5-byte entry each, from offset 4. */
export const DKS_BINDINGS = 4

/**
 * Counts per unit of a DKS threshold.
 *
 * The scan divides the live depth by 5 before calling the handler
 * (`divu a5, a4, 5` at 0xf060) and the handler compares that byte against
 * `record[0..3]` directly. So one threshold unit is five 0.02 mm counts —
 * 0.1 mm — and a full 4 mm stroke is 40 of them, which is why a byte was
 * enough.
 */
export const DKS_COUNTS_PER_STEP = 5

export function dksStepsToMm(steps: number, countsPerMm: number = COUNTS_PER_MM): number {
  return (steps * DKS_COUNTS_PER_STEP) / countsPerMm
}

export function dksMmToSteps(mm: number, countsPerMm: number = COUNTS_PER_MM): number {
  return Math.round((mm * countsPerMm) / DKS_COUNTS_PER_STEP)
}

/**
 * The deepest point a switch with this stroke can be given, in steps.
 *
 * Floored, not rounded, and that is the whole reason this is not
 * `dksMmToSteps(travelMm)`. A step is 0.1 mm and some of the vendor tables
 * quote travel to the hundredth — 3.45 mm rounds *up* to 34.5 → 35 steps, a
 * point 0.05 mm past where the switch stops. The firmware would simply never
 * see the key reach it, and a slider whose top end cannot be reached is a
 * slider with a dead inch on it.
 *
 * So the ceiling is the last whole step the switch actually gets to: 3.45 mm
 * gives 34, which is 3.4 mm.
 */
export function dksMaxSteps(travelMm: number, countsPerMm: number = COUNTS_PER_MM): number {
  return Math.max(0, Math.floor((travelMm * countsPerMm) / DKS_COUNTS_PER_STEP))
}

/**
 * One binding's span across the four stages.
 *
 * `pressAt` is the stage that sends the key down. `releaseAt` is the stage that
 * lets it up, and equalling `pressAt` means a tap — the firmware presses, waits
 * 2 ms and releases in the same pass.
 *
 * Stages are in stroke order, as the firmware checks them: 0 and 1 are the two
 * thresholds crossed pressing down, 2 and 3 the two crossed coming back up. So
 * `{pressAt: 0, releaseAt: 3}` is an ordinary key — down at the first point, up
 * at the last.
 */
export interface DksSpan {
  binding: KeyBinding
  pressAt: number
  releaseAt: number
  /**
   * The mask exactly as it was read, kept so a record this app did not author
   * round-trips byte for byte.
   *
   * `pressAt` / `releaseAt` describe the one span a mask can hold. A mask with
   * two press bits set is not something the encoder can produce, and rebuilding
   * it from the span would silently drop half of it.
   */
  mask: number
}

/**
 * Bit that says "press here", per stage. The four arms of the handler are at
 * 0x8af2 (stage 0), 0x8b32, 0x8b9a and 0x8c04.
 */
const DKS_PRESS_BIT = [0, 3, 6, 9] as const

/**
 * Bits that say "still down here", per interval between stages.
 *
 * Six bits for four intervals, because each boundary check reads its own pair:
 * stage 1 tests `(1, 2)`, stage 2 tests `(4, 5)`, stage 3 tests `(7, 8)`, and
 * each test releases the key when the first bit is set and the second is not.
 * So being down across the middle of the stroke is written twice.
 * `encodeDksSpan` sets both halves; leaving one clear makes the boundary that
 * reads it drop the key.
 */
const DKS_DOWN_BITS: readonly (readonly number[])[] = [[], [1], [2, 4], [5, 7], [8]]

export function encodeDksSpan(pressAt: number, releaseAt: number): number {
  const press = clampStage(pressAt)
  // A press at the last stage has no later stage to be released by.
  const release = Math.max(press, clampStage(releaseAt))
  let mask = 1 << (DKS_PRESS_BIT[press] ?? 0)
  for (let interval = press + 1; interval <= release; interval++) {
    for (const bit of DKS_DOWN_BITS[interval] ?? []) mask |= 1 << bit
  }
  return mask & 0x3ff
}

export function decodeDksSpan(mask: number): { pressAt: number; releaseAt: number } {
  const found = DKS_PRESS_BIT.findIndex((bit) => (mask >> bit) & 1)
  const press = found < 0 ? 0 : found
  let release = press
  for (let interval = press + 1; interval < DKS_DOWN_BITS.length; interval++) {
    const bits = DKS_DOWN_BITS[interval] ?? []
    if (!bits.some((bit) => (mask >> bit) & 1)) break
    release = interval
  }
  return { pressAt: press, releaseAt: Math.min(release, DKS_STAGES - 1) }
}

function clampStage(stage: number): number {
  return Math.min(Math.max(Math.round(stage), 0), DKS_STAGES - 1)
}

/**
 * A DKS record.
 *
 * `thresholds` are the four depth points in threshold units, in the order the
 * record stores them: `[0]` and `[1]` are tested pressing down and want to be
 * increasing, `[2]` and `[3]` coming back up and want to be decreasing. Nothing
 * in the firmware enforces that — a record whose points are out of order simply
 * has stages that never match.
 */
export interface DksRecord {
  kind: 'dks'
  thresholds: number[]
  spans: DksSpan[]
}

export function decodeDksRecord(blob: ArrayLike<number>, record: number): DksRecord {
  const at = record * ADVANCED_KEY_BLOCKS.dks.recordSize
  const b = (i: number) => blob[at + i] ?? 0
  const spans: DksSpan[] = []
  for (let i = 0; i < DKS_BINDINGS; i++) {
    const o = 4 + i * 5
    const mask = b(o + 3) | (b(o + 4) << 8)
    spans.push({ binding: decodeRecord(blob, at + o), mask, ...decodeDksSpan(mask) })
  }
  return { kind: 'dks', thresholds: [b(0), b(1), b(2), b(3)], spans }
}

export function encodeDksRecord(rec: DksRecord): Uint8Array {
  const out = new Uint8Array(ADVANCED_KEY_BLOCKS.dks.recordSize)
  for (let i = 0; i < DKS_STAGES; i++) out[i] = (rec.thresholds[i] ?? 0) & 0xff
  for (let i = 0; i < DKS_BINDINGS; i++) {
    const span = rec.spans[i]
    if (!span) continue
    const o = 4 + i * 5
    const bytes = bindingBytes(span.binding)
    out[o] = bytes[0]
    out[o + 1] = bytes[1]
    out[o + 2] = bytes[2]
    /*
     * A binding with nothing bound gets a zero mask, so no stage fires it.
     * `encodeDksSpan` always sets a press bit — it is asked for a span, and
     * every span starts somewhere — and a stage that fired `10 00 00` would
     * press a key with no usage. The firmware ORs that into its report and
     * nothing happens, but "nothing bound" should read as nothing in the bytes
     * too, not as a stage that does nothing.
     */
    const mask = span.binding.kind === 'none' ? 0 : encodeDksSpan(span.pressAt, span.releaseAt)
    out[o + 3] = mask & 0xff
    out[o + 4] = (mask >> 8) & 0xff
  }
  return out
}

/** A DKS binding with nothing bound and no stage that fires it. */
export function emptyDksSpan(): DksSpan {
  return { binding: { kind: 'none', raw: 0 }, pressAt: 0, releaseAt: 0, mask: 0 }
}

export function emptyDksRecord(): DksRecord {
  return {
    kind: 'dks',
    thresholds: [0, 0, 0, 0],
    spans: Array.from({ length: DKS_BINDINGS }, emptyDksSpan),
  }
}

/* ------------------------------------------------------------ pair kinds -- */

/**
 * The 6-byte record, as raw bytes plus the reading each kind takes of them.
 *
 * Raw bytes are the record here, rather than a decoded pair, because the four
 * kinds that share this table do **not** agree on what the six bytes are. MT
 * hands both halves to the keymap dispatcher, so for it they really are two
 * records. RS and SOCD read only bytes 2 and 5 — the two HID usages — and never
 * look at the type or modifier bytes. OKS reads bytes 2 and 5 and byte **3**,
 * which for MT would be a type byte and here is a duration. Decoding to a pair
 * of bindings and re-encoding would rewrite bytes those kinds are using for
 * something else.
 */
export interface PairRecord {
  kind: 'mt' | 'rs' | 'socd' | 'oks'
  bytes: number[]
}

export function decodePairRecord(
  blob: ArrayLike<number>,
  record: number,
  kind: PairRecord['kind'],
): PairRecord {
  const at = record * ADVANCED_KEY_BLOCKS.pair.recordSize
  const bytes: number[] = []
  for (let i = 0; i < ADVANCED_KEY_BLOCKS.pair.recordSize; i++) bytes.push(blob[at + i] ?? 0)
  return { kind, bytes }
}

export function encodePairRecord(rec: PairRecord): Uint8Array {
  const out = new Uint8Array(ADVANCED_KEY_BLOCKS.pair.recordSize)
  for (let i = 0; i < out.length; i++) out[i] = (rec.bytes[i] ?? 0) & 0xff
  return out
}

export function emptyPairRecord(kind: PairRecord['kind']): PairRecord {
  return { kind, bytes: [0, 0, 0, 0, 0, 0] }
}

/**
 * MT's two halves: the tap below the hold time and the hold above it.
 *
 * Both are whole keymap records — the handler passes each to 0x9ec6 — so a mod
 * tap can hold a modifier and tap a consumer key, or anything else the remap
 * catalog offers.
 */
export function mtBindings(rec: PairRecord): { tap: KeyBinding; hold: KeyBinding } {
  return { tap: decodeRecord(rec.bytes, 0), hold: decodeRecord(rec.bytes, 3) }
}

export function withMtBindings(rec: PairRecord, tap: KeyBinding, hold: KeyBinding): PairRecord {
  const t = bindingBytes(tap)
  const h = bindingBytes(hold)
  return { ...rec, bytes: [t[0], t[1], t[2], h[0], h[1], h[2]] }
}

/**
 * MT's hold time lives in the **keymap** record, not here: the third byte, in
 * units of 10 ms (the handler stores it straight into the pending-tap slot at
 * 0x8e46, and the stock driver's own note is "hold time / 10").
 */
export const MT_HOLD_MS_PER_UNIT = 10

/** The stock driver's default mod-tap hold, 200 ms. */
export const MT_DEFAULT_HOLD_MS = 200

/**
 * The two HID usages RS and SOCD resolve between.
 *
 * `own` is what this key sends, `partner` what the other one does. Both keys of
 * a pair carry their own record and their own keymap entry; what links them is
 * the keymap entry's third byte, which holds the partner's **slot** — the scan
 * copies it into the runtime struct at 0xf7ce, then reads both keys' depths
 * through it at 0xf7f8 and 0xf826.
 */
export function pairUsages(rec: PairRecord): { own: number; partner: number } {
  return { own: rec.bytes[2] ?? 0, partner: rec.bytes[5] ?? 0 }
}

export function withPairUsages(rec: PairRecord, own: number, partner: number): PairRecord {
  const bytes = rec.bytes.slice()
  bytes[0] = RECORD_TYPE.key
  bytes[2] = own & 0xff
  bytes[3] = RECORD_TYPE.key
  bytes[5] = partner & 0xff
  return { ...rec, bytes }
}

/**
 * OKS: what the key sends while held, and what it fires when it comes up.
 *
 * `holdTicks` is byte 3. The handler copies it into the runtime struct
 * (0x9e7c) alongside a flag and a depth snapshot and does not consume it
 * itself, so this app carries it through faithfully but its unit is **not
 * confirmed** — nothing in the image was found reading it back.
 */
export function oksBindings(rec: PairRecord): {
  own: number
  onRelease: number
  holdTicks: number
} {
  return { own: rec.bytes[2] ?? 0, onRelease: rec.bytes[5] ?? 0, holdTicks: rec.bytes[3] ?? 0 }
}

export function withOksBindings(
  rec: PairRecord,
  own: number,
  onRelease: number,
  holdTicks: number,
): PairRecord {
  const bytes = rec.bytes.slice()
  bytes[0] = RECORD_TYPE.key
  bytes[2] = own & 0xff
  bytes[3] = holdTicks & 0xff
  bytes[5] = onRelease & 0xff
  return { ...rec, bytes }
}

/**
 * SOCD's resolution mode is **not in this table.**
 *
 * The scan takes the high nibble of the key's per-key performance record —
 * `keyMode`, byte 1 of the 8-byte record at 0x20700 — and stores it in the
 * runtime struct (0xf82e), and the handler compares it against 2 and 3. So the
 * two keys of a SOCD pair can disagree, and changing the mode is a `0xa1`
 * write, not an `0xa5` one.
 *
 * Modes 2 and 3 are the two the handler names; 0 and 1 fall through to the same
 * arm, which sends this key and lets the partner alone. See `keyPerf.ts` for
 * where the nibble is read and written.
 */
export const SOCD_MODE = {
  /** Neither key is given priority — both arms fall through to the default. */
  neutral: 0,
  /** The other value the default arm covers. Kept apart because the nibble does. */
  lastInput: 1,
  /** Ignore this key while the partner is already down. */
  firstInputWins: 2,
  /** Release the partner and send this key instead. */
  lastInputWins: 3,
} as const

/* ------------------------------------------------------------------ TGL -- */

/**
 * A toggle: one keymap record, latched down on the first press and released on
 * the next.
 *
 * The handler keeps the latch in a 32-entry table at `gp+0x490` holding
 * `record + 1`, which caps a board at 32 toggles held down at once — not at 32
 * toggle *keys*.
 */
export interface ToggleRecord {
  kind: 'tgl'
  binding: KeyBinding
}

export function decodeToggleRecord(blob: ArrayLike<number>, record: number): ToggleRecord {
  return {
    kind: 'tgl',
    binding: decodeRecord(blob, record * ADVANCED_KEY_BLOCKS.toggle.recordSize),
  }
}

export function encodeToggleRecord(rec: ToggleRecord): Uint8Array {
  return Uint8Array.from(bindingBytes(rec.binding))
}

export function emptyToggleRecord(): ToggleRecord {
  return { kind: 'tgl', binding: { kind: 'none', raw: 0 } }
}

/** Toggles that can be latched down at the same time — `gp+0x490` is 32 long. */
export const TOGGLE_LATCH_SLOTS = 32

/* --------------------------------------------------------------- records -- */

export type AdvancedRecord = DksRecord | PairRecord | ToggleRecord

/** The three blobs, as the board hands them over. */
export interface AdvancedKeyBlobs {
  dks: Uint8Array
  pair: Uint8Array
  toggle: Uint8Array
}

/**
 * True when a record would do nothing — nothing bound, on any of the six.
 *
 * Two reasons a caller should refuse to write one.
 *
 * The plain one: it does not work. A TGL that toggles nothing and an MT with
 * neither a tap nor a hold are a key that has been made advanced and then made
 * inert, which is never what was meant by applying.
 *
 * The one that bites later: for the kinds whose empty record is all zeros, it
 * is *indistinguishable from a free record*. `isFreeRecord` reads zeros as
 * "nobody is using this", so a TGL bound to nothing occupies a number the
 * allocator will hand straight back out, and the record the user thought they
 * made is overwritten by the next one. It is not even an orphan, so the sweep
 * cannot report it.
 *
 * RS, SOCD and OKS are not all-zero even when empty — `withPairUsages` writes
 * a type byte whatever the usages are — so those are only the first reason.
 * They are judged on the usages the firmware actually reads: bytes 2 and 5.
 */
export function bindsNothing(rec: AdvancedRecord): boolean {
  if (rec.kind === 'dks') return rec.spans.every((s) => s.binding.kind === 'none')
  if (rec.kind === 'tgl') return rec.binding.kind === 'none'
  if (rec.kind === 'mt') {
    const { tap, hold } = mtBindings(rec)
    return tap.kind === 'none' && hold.kind === 'none'
  }
  if (rec.kind === 'oks') {
    // Either half alone is a working key: a usage that only fires on release
    // is the point of OKS, and one that only sounds while held is a plain key
    // said the long way. Both empty is nothing.
    const oks = oksBindings(rec)
    return oks.own === 0 && oks.onRelease === 0
  }
  // RS and SOCD resolve *between* two usages. A half with none is a key that
  // wins the comparison and then sends nothing, so both are required.
  const { own, partner } = pairUsages(rec)
  return own === 0 || partner === 0
}

export function emptyAdvancedRecord(kind: AdvancedKind): AdvancedRecord {
  if (kind === 'dks') return emptyDksRecord()
  if (kind === 'tgl') return emptyToggleRecord()
  return emptyPairRecord(kind)
}

export function decodeAdvancedRecord(
  blobs: AdvancedKeyBlobs,
  record: number,
  kind: AdvancedKind,
): AdvancedRecord {
  if (kind === 'dks') return decodeDksRecord(blobs.dks, record)
  if (kind === 'tgl') return decodeToggleRecord(blobs.toggle, record)
  return decodePairRecord(blobs.pair, record, kind)
}

export function encodeAdvancedRecord(rec: AdvancedRecord): Uint8Array {
  if (rec.kind === 'dks') return encodeDksRecord(rec)
  if (rec.kind === 'tgl') return encodeToggleRecord(rec)
  return encodePairRecord(rec)
}

/**
 * Writes one record into a copy of its blob.
 *
 * Read-modify-write, like every other block this app touches: the two spare
 * records, the tables this kind does not use and any byte it does not read all
 * come back unchanged.
 */
export function patchAdvancedRecord(
  blobs: AdvancedKeyBlobs,
  record: number,
  rec: AdvancedRecord,
): AdvancedKeyBlobs {
  const block = ADVANCED_BLOCK_OF[rec.kind]
  const bytes = encodeAdvancedRecord(rec)
  const next = new Uint8Array(blobs[block])
  next.set(bytes, record * ADVANCED_KEY_BLOCKS[block].recordSize)
  return { ...blobs, [block]: next }
}

/**
 * The tables that have a non-zero byte in this record.
 *
 * Usually one: a record belongs to whichever table its kind uses. All three
 * are possible, because a record's number is one index across the three and
 * nothing in the firmware stops bytes being left in two of them — which is
 * exactly the state a caller clearing a record it cannot name has to handle.
 */
export function recordBlocks(blobs: AdvancedKeyBlobs, record: number): AdvancedBlock[] {
  const used = (blob: Uint8Array, block: AdvancedBlock) => {
    const size = ADVANCED_KEY_BLOCKS[block].recordSize
    const at = record * size
    for (let i = 0; i < size; i++) if ((blob[at + i] ?? 0) !== 0) return true
    return false
  }
  const out: AdvancedBlock[] = []
  if (used(blobs.dks, 'dks')) out.push('dks')
  if (used(blobs.pair, 'pair')) out.push('pair')
  if (used(blobs.toggle, 'toggle')) out.push('toggle')
  return out
}

/** True when no table has a non-zero byte in this record. */
export function isFreeRecord(blobs: AdvancedKeyBlobs, record: number): boolean {
  return recordBlocks(blobs, record).length === 0
}

/**
 * A kind that writes each table, for a caller holding a block and no kind.
 *
 * The kind is in the keymap, so a record nothing points at has none — and
 * zeroing it still has to pick one, because every write here goes through a
 * record and a record is typed. Any of the four pair kinds serves for `pair`:
 * an empty record of each is the same six zero bytes.
 */
export const KIND_OF_BLOCK: Record<AdvancedBlock, AdvancedKind> = {
  dks: 'dks',
  pair: 'mt',
  toggle: 'tgl',
}

/**
 * The lowest record number no table has bytes in, or -1.
 *
 * Which record a key uses is the keymap's business, so a record can be occupied
 * with nothing pointing at it — a leftover from a binding that was replaced.
 * Callers that care should sweep the keymap as well; this only refuses to hand
 * out a record whose bytes are not all zero.
 */
export function firstFreeRecord(blobs: AdvancedKeyBlobs, limit = ADVANCED_KEY_USABLE): number {
  for (let i = 0; i < Math.min(limit, ADVANCED_KEY_COUNT); i++) {
    if (isFreeRecord(blobs, i)) return i
  }
  return -1
}

/**
 * Hex for one record of one table, the way `keyPerf.recordHex` prints one.
 *
 * Takes the table rather than all three, because the caller that needs it is
 * comparing a table it just sent against the one it read back — two blobs of
 * the same block, neither of which is a whole `AdvancedKeyBlobs`.
 */
export function recordHex(blob: ArrayLike<number>, record: number, kind: AdvancedKind): string {
  const size = ADVANCED_KEY_BLOCKS[ADVANCED_BLOCK_OF[kind]].recordSize
  const at = record * size
  const out: string[] = []
  for (let i = 0; i < size; i++) out.push((blob[at + i] ?? 0).toString(16).padStart(2, '0'))
  return out.join(' ')
}
