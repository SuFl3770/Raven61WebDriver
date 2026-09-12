/**
 * Macros — the 4 KB store at flash 0x21100, read by 0x0c and written by 0x0d.
 *
 * Decoded from the **firmware**, and only from the firmware. The stock driver's
 * database gave the schema of its own host-side model —
 * `t_macro_data(play_times, delay_type, delay_time, name)` and
 * `t_macrorecord(type, record_index, value, delay_time)` — and both captures
 * ship with `t_macrorecord` empty, so not one recorded macro exists to compare
 * bytes against. Everything below is the player, read instruction by
 * instruction.
 *
 * ### The store
 *
 *     0x21100  [0..63]     32 slots of u16 LE — a byte offset into this region
 *     0x21100  [64..4095]  bodies: runs of 4-byte event records
 *
 * `macroStart` at 0x94e8 takes the keymap record's `param` as the slot and
 * `code` as a repeat count, rejects a slot above 31, and sets the play cursor
 * to `0x21100 + u16(table[slot])`. The offset is relative to the region base,
 * not absolute — 0x21100 is added to it.
 *
 * ### One event record
 *
 *     [0..1]  u16 LE  milliseconds to wait *after* this event
 *     [2]     control
 *     [3]     value
 *
 * and the control byte:
 *
 *     bit 7       stop. The player releases every key and goes idle
 *     bit 6       1 = the key goes down, 0 = it comes up
 *     bits 3..0   what `value` is: 1 = modifier mask, 2 = HID usage
 *
 * The step function is 0x957e, called from the main loop at 0xa940. It returns
 * early while the delay is counting, so a record's delay is the pause that
 * *follows* it; a delay of 0 makes the player fall straight through to the next
 * record in the same pass, which is how two keys go down together.
 *
 * ### The delay is milliseconds
 *
 * The counter at `gp-0x780` is decremented by one in the TIM3 interrupt
 * (0x7cd4). That timer is set up at 0x7c32 with prescaler 143 and its period
 * comes from the one caller, 0x7878, as 1000 — so on a 144 MHz APB1 the timer
 * counts microseconds and interrupts every 1000 of them. One count is one
 * millisecond, and a u16 reaches 65535 of them.
 *
 * The stock driver agrees: its encoder writes the recorded delay straight into
 * the two bytes with no scaling, only a `max(delay, 1)` clamp (0x4285fa). This
 * app allows 0, which the player handles — that is how it presses two keys at
 * once.
 *
 * ### The stock driver's encoder says the same thing
 *
 * Everything above was read off the player, because the stock DB ships with
 * `t_macrorecord` empty. A profile export settled it from the other side:
 * `Raven Driver/asdf.xml` (obfuscated with a single-byte XOR of 0x7b) carries a
 * real 631-record recording, and the code that turns a record list into store
 * bytes is 0x428440 in the driver. It stages 3584 bytes, starts its write
 * cursor at **0x40** — the 64-byte offset table, so 32 slots, not the 10 its UI
 * shows — writes each record as delay lo, delay hi, control, value, advances by
 * 4, and picks the kind nibble by testing `0xe0 <= value <= 0xe7` exactly the
 * way `eventForUsage` does, converting through a jump table that is
 * `1 << (value - 0xe0)` (0x45d990). Every field of this format now has a
 * witness at both ends.
 *
 * Two things only the driver could tell us:
 *
 * **A stock store has no terminator records.** It sets bit 7 on the *last real
 * record* of each body instead (0x4286d6), and the player applies that record's
 * action before it goes idle — 0x95f8 releases everything and then falls
 * through to the press bit and the nibble at 0x9616. `decodeMacro` keeps that
 * event for exactly this reason. This app still appends a bare terminator when
 * it writes, which costs four bytes a slot and is safer: a body whose last
 * record is a *press* leaves that key held down, and a recording cut off
 * mid-keystroke ends in a press — the one in `asdf.xml` does.
 *
 * **The stock recorder stops at 650 records for the whole store**, shared
 * across its ten slots: `remaining = 2 * (325 - used)` at 0x436aa4, warning
 * under 20 and refusing under 10. That is the driver's own budget, not the
 * firmware's — `MACRO_STOCK` below carries it so the UI can say when a store
 * has grown past what the stock driver would take back.
 *
 * ### Only keys and modifiers
 *
 * The kind nibble has exactly two arms (0x962c). Both call the keyboard
 * emitter 0x8f6c, and which argument they fill is the whole difference:
 *
 *     nibble 1 -> 0x8f6c(value, 0)   value is OR'd into the report's
 *                                    modifier byte at gp-0x7ac
 *     nibble 2 -> 0x8f6c(0, value)   value is placed in the report's usage
 *                                    array, or the NKRO bitmap if that is full
 *
 * Every other nibble falls through to the default arm and does nothing. So a
 * macro on this board can press keys and modifiers and nothing else — no mouse
 * buttons, no consumer keys, no other macros, even though a *keymap* record can
 * name all three. `MacroAction`'s `unknown` arm exists so a body this app did
 * not author survives a round trip rather than being rewritten as a no-op.
 *
 * ### The repeat count is dead
 *
 * `macroStart` stores its second argument at `gp-0x781` and **nothing in the
 * image ever reads that byte**. The keymap record's third byte is therefore
 * inert: a macro plays once. The stock driver writes 1 there and so does this
 * app. A macro that should repeat has to say so in its body, which is what
 * `repeatEvents` below does.
 *
 * The stock driver's `t_macro_data.play_times` does not survive into the store
 * either: 0x428440 walks each record list exactly once and emits no repeat, so
 * the bytes on the board carry no repeat count anywhere. Whether the driver
 * expands the list before saving is not visible here — the profile that settled
 * the rest of this format has `times="1"` on all ten macros.
 *
 * ### ⚠ An unwritten store makes the board type garbage
 *
 * The player has **no bound on the cursor**. It stops when it reads a control
 * byte with bit 7 set, and nothing else stops it. A factory reset fills this
 * region with zeros (docs §3.8), and a zero control byte is neither a stop nor
 * a key — so a macro key bound while the store is still zeroed sends the cursor
 * walking forward four bytes at a time, out of the macro region, through the
 * advanced-key tables and into whatever follows, emitting a keystroke for every
 * record it passes whose nibble happens to be 1 or 2.
 *
 * That is why this module has no concept of editing one slot in place. Every
 * write lays out all 32 slots from the offset table up, each body terminated
 * (`encodeMacros`), so a store this app has written is a store the player
 * cannot run off the end of. `isCanonical` is the read-side half: it says
 * whether the store on the board is already safe to bind a key to.
 *
 * The stock driver does not fix this either. Its encoder fills offset-table
 * entries only for the ten slots it knows about, leaving 10..31 at zero — so a
 * store the stock driver has just written is still one where slot 10 walks the
 * flash. Its own UI cannot bind those slots, which is how it gets away with it.
 * This app writes all 32, which is also what makes the upper 22 usable at all.
 *
 * ### Reading a store this app did not write
 *
 * A stock store says nothing directly about which slots are empty, because the
 * cursor only advances after a body is written. An empty slot gets the cursor
 * as it stands, which is **the next body's offset** — or, for the empty slots
 * that trail the last real body, an offset into space the write never covered.
 *
 * A profile with M1, M3, M5, M7, M9 and M10 recorded lays out like this:
 *
 *     slot   0    1    2    3    4    5    6    7    8    9
 *     offset 64   96   96   128  128  160  160  192  192  224
 *            M1   M2   M3   M4   M5   M6   M7   M8   M9   M10
 *
 * so a repeated offset is the tell: of the slots sharing one, the **last** is
 * the one whose body was actually written there and the earlier ones were
 * empty. `decodeMacro` reports those as empty with `aliasOf` naming the owner.
 * That is a reading of the stock *layout*, not of the firmware — the player
 * has no notion of ownership and would happily play the shared body — which is
 * why an alias still counts as unsafe until this app has written the store.
 *
 * The trailing case needs a different tell, because there is no next body: the
 * offset lands in bytes the write did not carry, which read back as whatever
 * the flash held. `decodeMacro` stops at an **all-zero record** — no delay, no
 * action, no stop, so nothing any encoder emits — rather than walking it as
 * events. Without that, an unwritten slot decodes as several hundred padding
 * records, which is exactly as useless as it sounds.
 */
import type { MacroSpec } from '../device/spec'
import { MODIFIERS } from './keymap'

/** The store, with the flash address the evidence is quoted against. */
export const MACRO_BLOCK = {
  base: 0x21100,
  /**
   * Slots the store holds.
   *
   * `macroStart` rejects a slot above 31 (0x9500) and indexes the table at
   * `0x21100 + slot * 2` (0x9530), so the table is 32 entries wide — and the
   * stock encoder agrees from the other side by starting its write cursor at
   * 0x40.
   *
   * The stock driver manages ten of them (`MACRO_STOCK.slots`), which for a
   * while looked like the board's number too. It is not: the driver keeps its
   * macros in its own database and **never reads this block back** — there is
   * no 0x0c builder anywhere in its image — so the other 22 are the firmware's
   * to give and nothing on the board contradicts them.
   */
  slots: 32,
  eventBytes: 4,
  /**
   * What 0x0c reads, and what the write handler at 0x6bd6 caps `offset + length`
   * against.
   */
  blobBytes: 4096,
  /**
   * What the stock driver writes — 3584 of the 4096 the firmware would accept.
   *
   * Kept as the limit this app writes to, for the same reason the advanced-key
   * table stops at 40 of 42 records: a store written here stays one the stock
   * driver can read back and rewrite without truncating a body it did not
   * expect. The other 512 bytes are reachable and are left alone.
   */
  hostBytes: 3584,
} as const

/** Bytes the offset table occupies, ahead of the first body. */
export const MACRO_TABLE_BYTES = MACRO_BLOCK.slots * 2

/** Bits of an event record's control byte. */
export const MACRO_CONTROL = {
  /** Stop, and release everything. Tested as a signed byte at 0x95f8. */
  stop: 0x80,
  /** Set on the way down, clear on the way up (0x9616). */
  press: 0x40,
  /** What `value` means (0x9630). */
  kindMask: 0x0f,
} as const

/** The two kind nibbles the player acts on. */
export const MACRO_KIND = {
  /** `value` is a modifier bitmask — `0x8f6c(value, 0)`. */
  modifiers: 1,
  /** `value` is a HID usage — `0x8f6c(0, value)`. */
  key: 2,
} as const

/** One record's delay field is a u16. */
export const MACRO_MAX_DELAY_MS = 0xffff

/**
 * The record that ends a body: no delay, no key, stop bit set.
 *
 * The stock driver does not write one — it raises bit 7 on the body's last real
 * record instead. This app spends the four bytes because the player applies a
 * stop record's action *after* releasing everything, so a body ending in a
 * press would otherwise leave that key held down.
 */
export const MACRO_STOP_RECORD: readonly number[] = [0, 0, MACRO_CONTROL.stop, 0]

/**
 * What the stock driver does with the same store, where it differs.
 *
 * Neither number is a firmware limit; both are the stock driver's own. They are
 * here so this app can say when a store leaves behind what the stock driver
 * would make of it — the courtesy the advanced-key table pays by stopping at 40
 * of 42.
 */
export const MACRO_STOCK = {
  /**
   * Slots its UI exposes, of the 32 the store holds.
   *
   * A profile export has exactly ten `macro_item` entries, and its encoder
   * writes exactly ten offsets. This app offers the same ten by default and
   * the full 32 in debug mode — see `macroSlotsExposed`.
   */
  slots: 10,
  /** Records its recorder allows across the whole store — `2 * 325`, 0x436aa4. */
  events: 650,
} as const

/**
 * Slots to put in front of someone.
 *
 * Ten unless debug mode is on, and the reason is not the board. Writing a body
 * into slot 12 works — the player takes it — but the stock driver cannot see
 * it, and the next time that driver writes this block it writes ten macros
 * from its own database and the other 22 go with it. So the wider set is
 * behind the same gate as the rest of the protocol lab.
 */
export function macroSlotsExposed(
  debug: boolean,
  spec: MacroSpec = DEFAULT_MACROS,
): number {
  return debug ? spec.slots : Math.min(MACRO_STOCK.slots, spec.slots)
}

/**
 * The geometry a caller gets when it names no spec.
 *
 * Assembled from the constants above rather than restating them, so the
 * evidence stays with the numbers — the arrangement `DEFAULT_KEYMAP` and
 * `DEFAULT_ADVANCED_KEYS` use.
 */
export const DEFAULT_MACROS: MacroSpec = {
  slots: MACRO_BLOCK.slots,
  eventBytes: MACRO_BLOCK.eventBytes,
  blobBytes: MACRO_BLOCK.blobBytes,
  hostBytes: MACRO_BLOCK.hostBytes,
}

/** What one event does when the player reaches it. */
export type MacroAction =
  /** A key goes down or comes up. `usage` is HID page 0x07. */
  | { kind: 'key'; usage: number }
  /** Modifiers go down or come up together. `mask` is the report's byte 0. */
  | { kind: 'modifiers'; mask: number }
  /**
   * A nibble this firmware's player ignores.
   *
   * Not an error and not dropped: the record is kept exactly as it was read so
   * that editing slot 3 cannot rewrite a body in slot 7 that this app does not
   * understand. `nibble` 0 is the common case — a padding record.
   */
  | { kind: 'unknown'; nibble: number; value: number }

/** One record of a body, decoded. */
export interface MacroEvent {
  action: MacroAction
  /** True on the way down. Meaningless for `unknown`, and preserved anyway. */
  press: boolean
  /** Milliseconds the player waits *after* this event, 0 to 65535. */
  delayMs: number
}

/** One slot's body, as the store holds it. */
export interface Macro {
  slot: number
  events: MacroEvent[]
  /**
   * Set when a later slot names this slot's offset, which in the stock layout
   * means this slot is empty and that one owns the body.
   *
   * The player does not know that: bind a key to an aliased slot and the board
   * plays the owner's body. Writing the store from this app is what makes the
   * slot really empty.
   */
  aliasOf?: number
  /**
   * False when the slot's offset does not name a body at all — it points into
   * the offset table, or past the end of the region.
   *
   * The all-zero store a factory reset leaves behind is this for all 32 slots,
   * and it is the state that makes a bound macro key dangerous. It is not the
   * same as a body of no events, which is a real body that stops immediately.
   */
  programmed: boolean
  /** False when the body ran out of region without a stop record. */
  terminated: boolean
  /** The offset the table held, for the diagnostic line. */
  offset: number
}

/** A slot with nothing in it — one that will encode as a bare stop record. */
export function emptyMacro(slot: number): Macro {
  return { slot, events: [], programmed: true, terminated: true, offset: 0 }
}

/** True for a macro that would play nothing. */
export function isMacroEmpty(macro: Macro): boolean {
  return macro.events.length === 0
}

/** Bytes in the store — what a read transfers. */
export function macroBlobSize(spec: MacroSpec = DEFAULT_MACROS): number {
  return spec.blobBytes
}

/** Event records the bodies can hold in total, once the table is paid for. */
export function macroEventCapacity(spec: MacroSpec = DEFAULT_MACROS): number {
  return Math.floor((spec.hostBytes - spec.slots * 2) / spec.eventBytes)
}

/**
 * Events a reader can actually put in the store, which is 32 fewer than the
 * records it holds.
 *
 * Every slot is written a stop record whether or not anything is in it — see
 * `encodeMacros`, and the header for why an empty slot gets its own rather
 * than sharing its neighbour's. Those 32 records are the store's and never the
 * reader's, so a panel that counts them is a panel whose number disagrees with
 * the list it is shown beside: 850 events in one slot occupies 882 records,
 * and "882 of 880" is a true sentence about bytes and a wrong one about
 * anything a reader can act on.
 *
 * So the pair a screen counts in is this one and `macroEventsStored`, and the
 * pair the encoder checks in is `macroEventCapacity` and `macroEventsUsed`.
 * Both say the same thing — the difference is `spec.slots` on either side —
 * and each says it in the units of whoever is reading.
 */
export function macroEventBudget(spec: MacroSpec = DEFAULT_MACROS): number {
  return macroEventCapacity(spec) - spec.slots
}

/**
 * True once a store holds more than the stock driver's recorder would.
 *
 * Not a limit — the block holds 880 records at this app's write ceiling, and the
 * firmware would take 1008. It is the point past which the stock driver, which
 * budgets 650 for the whole store, is being handed more than it counts on.
 *
 * Counted in events and not in records, because that is what the number on the
 * other side of the comparison counts: a stock store carries no stop records
 * at all — the driver raises bit 7 on each body's last real record instead
 * (see the header) — so its 650 is 650 of the reader's own.
 */
export function overStockBudget(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): boolean {
  return macroEventsStored(macros, spec) > MACRO_STOCK.events
}

/** Records `macros` would occupy, the stop record every slot gets included. */
export function macroEventsUsed(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): number {
  return macroEventsStored(macros, spec) + spec.slots
}

/** Events `macros` holds — the stop records the encoder adds are not among them. */
export function macroEventsStored(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): number {
  let stored = 0
  for (let slot = 0; slot < spec.slots; slot++) {
    stored += macros[slot]?.events.length ?? 0
  }
  return stored
}

/** Records still free, given what `macros` holds. */
export function macroEventsFree(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): number {
  return macroEventCapacity(spec) - macroEventsUsed(macros, spec)
}

// --- decoding ------------------------------------------------------------

/** Reads one 4-byte record. */
export function decodeMacroEvent(blob: ArrayLike<number>, at: number): MacroEvent {
  const lo = blob[at] ?? 0
  const hi = blob[at + 1] ?? 0
  const control = blob[at + 2] ?? 0
  const value = blob[at + 3] ?? 0
  const nibble = control & MACRO_CONTROL.kindMask
  const press = (control & MACRO_CONTROL.press) !== 0
  const delayMs = lo | (hi << 8)
  if (nibble === MACRO_KIND.key) return { action: { kind: 'key', usage: value }, press, delayMs }
  if (nibble === MACRO_KIND.modifiers) {
    return { action: { kind: 'modifiers', mask: value }, press, delayMs }
  }
  return { action: { kind: 'unknown', nibble, value }, press, delayMs }
}

/** True when this record would stop the player. */
export function isStopRecord(blob: ArrayLike<number>, at: number): boolean {
  return ((blob[at + 2] ?? 0) & MACRO_CONTROL.stop) !== 0
}

/** The offset a slot's table entry names. */
export function macroOffset(
  blob: ArrayLike<number>,
  slot: number,
): number {
  const at = slot * 2
  return (blob[at] ?? 0) | ((blob[at + 1] ?? 0) << 8)
}

/** True for a record that does nothing and takes no time — unwritten space. */
export function isBlankRecord(blob: ArrayLike<number>, at: number): boolean {
  return (
    (blob[at] ?? 0) === 0 &&
    (blob[at + 1] ?? 0) === 0 &&
    (blob[at + 2] ?? 0) === 0 &&
    (blob[at + 3] ?? 0) === 0
  )
}

/**
 * The last slot naming `offset`, which in the stock layout owns the body there.
 *
 * See the module header: the write cursor does not advance for an empty slot,
 * so every slot before the owner that shares the offset was empty.
 */
function ownerOfOffset(
  blob: ArrayLike<number>,
  offset: number,
  spec: MacroSpec,
): number {
  let owner = 0
  // The slot asking is always among them, so a unique offset resolves to the
  // asker and owns its own body.
  for (let slot = 0; slot < spec.slots; slot++) {
    if (macroOffset(blob, slot) === offset) owner = slot
  }
  return owner
}

/**
 * One slot's body, walked the way the player walks it.
 *
 * Stops where the player stops — a control byte with bit 7 set — and, unlike
 * the player, also stops at an all-zero record, at the end of the region and
 * at the capacity of the store. Those are what `terminated: false` reports: a
 * body the firmware would run off the end of.
 */
export function decodeMacro(
  blob: ArrayLike<number>,
  slot: number,
  spec: MacroSpec = DEFAULT_MACROS,
): Macro {
  const tableBytes = spec.slots * 2
  const offset = macroOffset(blob, slot)
  // An offset inside the table is not a body. It is what a zeroed store says,
  // and reading the table as records would turn other slots' offsets into
  // keystrokes.
  if (offset < tableBytes || offset >= spec.blobBytes) {
    return { slot, events: [], programmed: false, terminated: false, offset }
  }
  // A slot a later slot shares an offset with was empty when the store was
  // written. Report it as empty, but carry the owner's `terminated` — until the
  // store is rewritten the player would run the owner's body from here, so the
  // safety question is the owner's.
  const owner = ownerOfOffset(blob, offset, spec)
  if (owner !== slot) {
    const body = decodeMacro(blob, owner, spec)
    return {
      slot,
      events: [],
      aliasOf: owner,
      programmed: body.programmed,
      terminated: body.terminated,
      offset,
    }
  }
  const events: MacroEvent[] = []
  const limit = macroEventCapacity(spec)
  let cursor = offset
  while (cursor + spec.eventBytes <= spec.blobBytes) {
    if (isStopRecord(blob, cursor)) {
      // A stop record still acts before the player goes idle: 0x95f8 releases
      // everything and falls through to the press bit and the kind nibble at
      // 0x9616. That matters for stores this app did not write — the stock
      // driver raises bit 7 on the last real record instead of appending a
      // terminator, so returning here would drop the last event of every macro
      // it ever recorded. A nibble the player ignores carries no event, which
      // is what a bare terminator is.
      const last = decodeMacroEvent(blob, cursor)
      if (last.action.kind !== 'unknown') events.push(last)
      return { slot, events, programmed: true, terminated: true, offset }
    }
    // Space the write never covered. The player would walk straight through it
    // (that is the hazard in this module's header); this app stops and says the
    // body does not terminate, rather than inventing hundreds of padding
    // records out of bytes nobody wrote.
    if (isBlankRecord(blob, cursor)) break
    if (events.length >= limit) break
    events.push(decodeMacroEvent(blob, cursor))
    cursor += spec.eventBytes
  }
  return { slot, events, programmed: true, terminated: false, offset }
}

/** Every slot of the store. The UI shows as many as it exposes. */
export function decodeMacros(
  blob: ArrayLike<number>,
  spec: MacroSpec = DEFAULT_MACROS,
): Macro[] {
  const out: Macro[] = []
  for (let slot = 0; slot < spec.slots; slot++) out.push(decodeMacro(blob, slot, spec))
  return out
}

/**
 * Whether the store on the board is safe for a macro key to be bound to.
 *
 * Every slot has to name a body and every body has to stop, because the keymap
 * record does not say which slot a key will reach — the user does, later, with
 * the layer they are on. A store where slot 9 is unterminated is one where
 * binding slot 3 is still a loaded gun.
 *
 * All 32, not the ten the UI shows by default: the player takes any slot up to
 * 31 (0x9500), so an entry nobody has offered is the same hazard as one that
 * has been — and a stock store leaves 22 of them at zero.
 */
export function isCanonical(blob: ArrayLike<number>, spec: MacroSpec = DEFAULT_MACROS): boolean {
  return decodeMacros(blob, spec).every((m) => m.programmed && m.terminated)
}

/** Slots whose body this app could not walk to a stop. */
export function malformedSlots(macros: readonly Macro[]): number[] {
  return macros.filter((m) => !m.programmed || !m.terminated).map((m) => m.slot)
}

// --- encoding ------------------------------------------------------------

/** One event as its four bytes. `stop` sets bit 7 on top of the rest. */
export function encodeMacroEvent(event: MacroEvent, stop = false): [number, number, number, number] {
  const delay = Math.max(0, Math.min(MACRO_MAX_DELAY_MS, Math.round(event.delayMs) || 0))
  let control = stop ? MACRO_CONTROL.stop : 0
  if (event.press) control |= MACRO_CONTROL.press
  let value = 0
  switch (event.action.kind) {
    case 'key':
      control |= MACRO_KIND.key
      value = event.action.usage & 0xff
      break
    case 'modifiers':
      control |= MACRO_KIND.modifiers
      value = event.action.mask & 0xff
      break
    case 'unknown':
      control |= event.action.nibble & MACRO_CONTROL.kindMask
      value = event.action.value & 0xff
      break
  }
  return [delay & 0xff, (delay >> 8) & 0xff, control & 0xff, value]
}

/** Thrown when the bodies do not fit, with the numbers a message needs. */
export class MacroCapacityError extends Error {
  constructor(
    readonly needed: number,
    readonly capacity: number,
  ) {
    super(`macro store needs ${needed} records but holds ${capacity}`)
    this.name = 'MacroCapacityError'
  }
}

/**
 * The whole store, laid out from scratch.
 *
 * Not an in-place edit, and that is the point — see the warning in this
 * module's header. The offset table is rebuilt, the bodies are packed after it
 * in slot order, and **every** body gets a stop record whether or not it has
 * any events. A store this returns is one the player cannot walk off the end
 * of, from any slot, in any order.
 *
 * "Any slot" includes the 22 the stock driver leaves at zero, pointing into
 * the offset table. Every slot here gets its own offset and its own stop
 * record, so slot 12 plays nothing instead of reading the flash aloud.
 *
 * An empty slot gets its own stop record rather than sharing the next body's
 * offset the way the stock driver leaves it. Four bytes, and it is the
 * difference between an empty slot being empty and an empty slot quietly
 * playing its neighbour.
 *
 * The tail past the last body is zeroed rather than left as it was. There is
 * nothing there to preserve — the offset table is the only index into this
 * region, so a body no slot points at is unreachable — and zeroing it means two
 * stores with the same macros are the same bytes, which is what makes the
 * read-back comparison after a write mean something.
 */
export function encodeMacros(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): Uint8Array {
  const needed = macroEventsUsed(macros, spec)
  const capacity = macroEventCapacity(spec)
  if (needed > capacity) throw new MacroCapacityError(needed, capacity)

  const blob = new Uint8Array(spec.blobBytes)
  let cursor = spec.slots * 2
  for (let slot = 0; slot < spec.slots; slot++) {
    blob[slot * 2] = cursor & 0xff
    blob[slot * 2 + 1] = (cursor >> 8) & 0xff
    for (const event of macros[slot]?.events ?? []) {
      blob.set(encodeMacroEvent(event), cursor)
      cursor += spec.eventBytes
    }
    blob.set(MACRO_STOP_RECORD, cursor)
    cursor += spec.eventBytes
  }
  return blob
}

/**
 * How many bytes of the store a write has to carry.
 *
 * The bodies end well short of `hostBytes` in every realistic store, and the
 * chunked write costs a packet per 56 bytes — so a store with three short
 * macros in it is 12 packets rather than 64. What is sent is always a whole
 * number of records from offset 0, so the offset table always goes with it.
 */
export function macroWriteBytes(
  macros: readonly Macro[],
  spec: MacroSpec = DEFAULT_MACROS,
): number {
  return spec.slots * 2 + macroEventsUsed(macros, spec) * spec.eventBytes
}

// --- editing -------------------------------------------------------------

/** `macros` with one slot replaced. */
export function withMacro(macros: readonly Macro[], macro: Macro): Macro[] {
  return macros.map((m) => (m.slot === macro.slot ? macro : m))
}

/**
 * The event list played `times` times over.
 *
 * The board's own repeat count is dead (see the header), so this is what a
 * repeat has to be: more records. The last event's delay becomes the gap
 * between passes, which is why a recorded macro that ends on a key release
 * with no trailing delay repeats as fast as the player can walk it — the panel
 * offers a gap for that reason.
 */
export function repeatEvents(
  events: readonly MacroEvent[],
  times: number,
  gapMs = 0,
): MacroEvent[] {
  const passes = Math.max(1, Math.floor(times) || 1)
  if (passes === 1 || events.length === 0) return events.slice()
  const out: MacroEvent[] = []
  for (let i = 0; i < passes; i++) {
    for (const [j, event] of events.entries()) {
      const last = j === events.length - 1
      // The gap is added to the last event of every pass but the last, so the
      // macro does not end on a pause the user did not ask for.
      const extra = last && i < passes - 1 ? gapMs : 0
      out.push(extra ? { ...event, delayMs: Math.min(MACRO_MAX_DELAY_MS, event.delayMs + extra) } : event)
    }
  }
  return out
}

/**
 * A key tapped: down, then up.
 *
 * `holdMs` is the delay carried by the press record, which is how long the key
 * stays down; `gapMs` is carried by the release, which is the pause before
 * whatever follows.
 */
export function tapEvents(usage: number, holdMs: number, gapMs: number): MacroEvent[] {
  return [
    { action: { kind: 'key', usage }, press: true, delayMs: holdMs },
    { action: { kind: 'key', usage }, press: false, delayMs: gapMs },
  ]
}

/** The same for a modifier mask. */
export function modifierTapEvents(mask: number, holdMs: number, gapMs: number): MacroEvent[] {
  return [
    { action: { kind: 'modifiers', mask }, press: true, delayMs: holdMs },
    { action: { kind: 'modifiers', mask }, press: false, delayMs: gapMs },
  ]
}

/**
 * An event for a usage the host reported, choosing the right kind for it.
 *
 * The eight modifier usages 0xe0-0xe7 have to go out as a mask, not as a usage:
 * the player's nibble 2 arm puts the value in the report's *usage array*, and a
 * modifier that arrives there is a key the host does not see as Shift. The
 * emitter is the same function either way, which is what makes the split
 * invisible unless it is got wrong.
 */
export function eventForUsage(usage: number, press: boolean, delayMs: number): MacroEvent {
  if (usage >= 0xe0 && usage <= 0xe7) {
    return { action: { kind: 'modifiers', mask: 1 << (usage - 0xe0) }, press, delayMs }
  }
  return { action: { kind: 'key', usage }, press, delayMs }
}

// --- comparing and showing -----------------------------------------------

export function sameMacroEvent(a: MacroEvent, b: MacroEvent): boolean {
  const ab = encodeMacroEvent(a)
  const bb = encodeMacroEvent(b)
  return ab.every((byte, i) => byte === bb[i])
}

export function sameMacro(a: Macro, b: Macro): boolean {
  if (a.events.length !== b.events.length) return false
  return a.events.every((event, i) => sameMacroEvent(event, b.events[i]!))
}

/** One record as hex bytes — what a mismatch report shows. */
export function macroEventHex(event: MacroEvent): string {
  return encodeMacroEvent(event)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

/** The bytes of one slot's body, for the diagnostic line. */
export function macroBodyHex(macro: Macro): string {
  const parts = macro.events.map((e) => macroEventHex(e))
  parts.push(MACRO_STOP_RECORD.map((b) => b.toString(16).padStart(2, '0')).join(' '))
  return parts.join(' | ')
}

/** The modifier names in a mask, `Ctrl+Shift` style. Empty for no bits. */
export function modifierMaskLabel(mask: number): string {
  return MODIFIERS.filter((m) => (mask & m.bit) !== 0)
    .map((m) => m.label)
    .join('+')
}
