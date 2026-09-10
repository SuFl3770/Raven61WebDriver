/**
 * Checks the macro codec and write path against a fake board. `npm run check`.
 *
 * The layout came out of the firmware first, because the stock driver's
 * `t_macrorecord` has no rows in either DB capture. A profile export
 * (`Raven Driver/asdf.xml`) later supplied a real 631-record recording, and the
 * driver's own encoder at 0x428440 confirmed every field — so the last section
 * here replays bytes the stock driver would really have written. The rest of
 * the checks are still the only thing between a refactor and a keyboard that
 * types by itself. Five things are pinned.
 *
 * **The record layout.** `[delay lo][delay hi][control][value]`, with the
 * control byte's bit 7 stopping the player, bit 6 saying press or release, and
 * the low nibble choosing what `value` is. `play()` below reimplements the step
 * function 0x957e straight from the disassembly — including the arm that makes
 * nibble 1 a *modifier mask* and nibble 2 a *usage*, which is the pair easiest
 * to get backwards and impossible to notice without hardware.
 *
 * **Every body stops, from every slot.** The player has no bound on its cursor
 * (see `protocol/macros.ts`), so a store where one slot is unterminated is a
 * store where every macro key is unsafe. `play()` is given a hard step limit
 * and a whole flash image to walk, so a body that does not stop shows up as the
 * cursor leaving the region rather than as a quiet pass.
 *
 * **Round trips.** A body this app did not author has to survive read → decode
 * → encode → write unchanged, unknown kind nibbles included: editing slot 3
 * must not rewrite slot 7 as a no-op.
 *
 * **The write is a prefix, and the keymap is a separate write.** The offset
 * table can never go out without the bodies it points at, and `writeMacros`
 * must never touch 0x09.
 *
 * **A store the stock driver wrote reads back whole.** It puts the stop bit on
 * the last *real* record rather than appending a terminator, and the player
 * runs that record's action before going idle — so a decoder that treats bit 7
 * as pure punctuation silently drops the last event of every stock recording.
 *
 * Run it after touching macros.ts or the macro path in engine.ts.
 */
import { raven61Spec } from '../../src/device/boards/raven61/index'
import { RAVEN61_KEYS } from '../../src/device/boards/raven61/layout'
import type { HidLink } from '../../src/hid/link'
import { BLOCK, MAGIC, OFFSET, checksum } from '../../src/protocol/frame'
import { KEYMAP } from '../../src/protocol/slotMap'
import { decodeRecord, RECORD_TYPE } from '../../src/protocol/keymap'
import {
  MACRO_CONTROL,
  MACRO_KIND,
  MACRO_MAX_DELAY_MS,
  MACRO_STOCK,
  MACRO_STOP_RECORD,
  MACRO_TABLE_BYTES,
  decodeMacro,
  decodeMacroEvent,
  decodeMacros,
  emptyMacro,
  encodeMacroEvent,
  encodeMacros,
  eventForUsage,
  isCanonical,
  macroBlobSize,
  macroEventCapacity,
  macroEventHex,
  macroEventsFree,
  macroEventsUsed,
  macroWriteBytes,
  malformedSlots,
  modifierMaskLabel,
  overStockBudget,
  repeatEvents,
  sameMacro,
  tapEvents,
  withMacro,
  MacroCapacityError,
  type Macro,
  type MacroEvent,
} from '../../src/protocol/macros'
import { readMacros, writeMacros } from '../../src/protocol/raven61'

let pass = 0
const fails: string[] = []
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else fails.push(`${name} — ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++
  else fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

const SPEC = raven61Spec.macros

/** The three channels the real board leaves unused inside 0..63. */
const HOLES = [12, 20, 53]
function slotFor(i: number): number {
  let slot = 0
  for (let n = 0; n < i; ) {
    slot++
    if (!HOLES.includes(slot)) n++
  }
  while (HOLES.includes(slot)) slot++
  return slot
}

// --- the player, from the disassembly ------------------------------------

interface Played {
  /** What the report held after each event: modifier mask and pressed usages. */
  steps: { mods: number; keys: number[]; waitedMs: number }[]
  /** True when a stop record ended it. False means the cursor ran away. */
  stopped: boolean
  /** Where the cursor was when it stopped, as an offset into the image. */
  cursor: number
  /** Total milliseconds the delays add up to. */
  totalMs: number
}

/**
 * `macroStart` (0x94e8) and the step function (0x957e), reimplemented.
 *
 * `image` is the macro region followed by whatever the firmware would walk into
 * next, so a body that never stops is *visible* rather than silently ending at
 * the array bound. The player's own arithmetic is copied exactly: the cursor is
 * `regionBase + u16(table[slot])`, a record is four bytes, and the delay is
 * read before the action is taken.
 */
function play(image: Uint8Array, slot: number, steps = 4096): Played {
  const out: Played = { steps: [], stopped: false, cursor: 0, totalMs: 0 }
  if (slot > 0x1f) return out
  let cursor = (image[slot * 2] ?? 0) | ((image[slot * 2 + 1] ?? 0) << 8)
  let mods = 0
  const keys: number[] = []
  for (let n = 0; n < steps; n++) {
    out.cursor = cursor
    if (cursor + 4 > image.length) return out
    const delay = (image[cursor] ?? 0) | ((image[cursor + 1] ?? 0) << 8)
    const control = image[cursor + 2] ?? 0
    const value = image[cursor + 3] ?? 0
    cursor += 4

    const stop = (control & MACRO_CONTROL.stop) !== 0
    if (stop) {
      // 0x95f8: the player releases everything and goes idle — and still runs
      // the record's own action arm, which for a canonical stop is a no-op.
      mods = 0
      keys.length = 0
    }
    const press = (control & MACRO_CONTROL.press) !== 0
    const nibble = control & MACRO_CONTROL.kindMask
    if (nibble === MACRO_KIND.modifiers) {
      // 0x8f6c's first argument: OR'd into the report's modifier byte, or
      // cleared from it.
      mods = press ? mods | value : mods & ~value & 0xff
    } else if (nibble === MACRO_KIND.key) {
      // 0x8f6c's second argument: a usage in the report's array. Usages 0..3
      // are skipped there (0x901c).
      if (value > 3) {
        if (press) {
          if (!keys.includes(value)) keys.push(value)
        } else {
          const at = keys.indexOf(value)
          if (at >= 0) keys.splice(at, 1)
        }
      }
    }
    out.steps.push({ mods, keys: [...keys], waitedMs: delay })
    out.totalMs += delay
    if (stop) {
      out.stopped = true
      return out
    }
  }
  return out
}

/** A 4 KB store followed by 4 KB of the zeroed tables that really follow it. */
function imageOf(blob: Uint8Array): Uint8Array {
  const image = new Uint8Array(blob.length + 4096)
  image.set(blob)
  return image
}

// --- the record layout ---------------------------------------------------
{
  eq('the store is 4 KB', macroBlobSize(SPEC), 4096)
  eq('32 slots of u16 ahead of the bodies', MACRO_TABLE_BYTES, 64)
  eq('a record is four bytes', SPEC.eventBytes, 4)
  eq('the stock driver writes 3584 of them', SPEC.hostBytes, 3584)
  eq(
    'capacity is what is left after the table',
    macroEventCapacity(SPEC),
    (3584 - 64) / 4,
  )

  eq('a key press is nibble 2 with the press bit', encodeMacroEvent({
    action: { kind: 'key', usage: 0x04 },
    press: true,
    delayMs: 0,
  }), [0, 0, MACRO_CONTROL.press | MACRO_KIND.key, 0x04])

  eq('a modifier is nibble 1', encodeMacroEvent({
    action: { kind: 'modifiers', mask: 0x02 },
    press: true,
    delayMs: 0,
  }), [0, 0, MACRO_CONTROL.press | MACRO_KIND.modifiers, 0x02])

  eq('a release clears the press bit', encodeMacroEvent({
    action: { kind: 'key', usage: 0x04 },
    press: false,
    delayMs: 0,
  }), [0, 0, MACRO_KIND.key, 0x04])

  eq('the delay is u16 little-endian', encodeMacroEvent({
    action: { kind: 'key', usage: 0x04 },
    press: true,
    delayMs: 0x0134,
  }), [0x34, 0x01, MACRO_CONTROL.press | MACRO_KIND.key, 0x04])

  eq('and saturates rather than wrapping', encodeMacroEvent({
    action: { kind: 'key', usage: 4 },
    press: true,
    delayMs: 70000,
  })[0] | (encodeMacroEvent({
    action: { kind: 'key', usage: 4 },
    press: true,
    delayMs: 70000,
  })[1] << 8), MACRO_MAX_DELAY_MS)

  eq('the stop record is what the player looks for', MACRO_STOP_RECORD, [0, 0, 0x80, 0])

  /*
   * The one pairing with no second source. 0x9640 calls 0x8f6c(value, 0) for
   * nibble 1 and 0x9656 calls 0x8f6c(0, value) for nibble 2, and 0x8f6c ORs
   * its *first* argument into the report's modifier byte at gp-0x7ac. Getting
   * this backwards makes a macro's Shift arrive as an unnamed usage and its
   * letters arrive as modifier bits — on hardware, and nowhere else.
   */
  eq('a modifier usage becomes a mask, not a usage', eventForUsage(0xe1, true, 0), {
    action: { kind: 'modifiers', mask: 0x02 },
    press: true,
    delayMs: 0,
  })
  eq('and a plain usage stays a usage', eventForUsage(0x04, true, 0), {
    action: { kind: 'key', usage: 0x04 },
    press: true,
    delayMs: 0,
  })
  eq('every modifier usage maps to its own bit', Array.from({ length: 8 }, (_, i) => {
    const event = eventForUsage(0xe0 + i, true, 0)
    return event.action.kind === 'modifiers' ? event.action.mask : -1
  }), [1, 2, 4, 8, 16, 32, 64, 128])

  eq('a nibble the player ignores decodes as unknown', decodeMacroEvent([0, 0, 0x43, 0x77], 0), {
    action: { kind: 'unknown', nibble: 3, value: 0x77 },
    press: true,
    delayMs: 0,
  })
  eq('and re-encodes to the same bytes', encodeMacroEvent(
    decodeMacroEvent([0, 0, 0x43, 0x77], 0),
  ), [0, 0, 0x43, 0x77])
  eq('hex is the four bytes', macroEventHex({
    action: { kind: 'key', usage: 0x1e },
    press: true,
    delayMs: 20,
  }), '14 00 42 1e')
  eq('a mask reads as its names', modifierMaskLabel(0x05), 'LCtrl+LAlt')
  eq('and no bits as nothing', modifierMaskLabel(0), '')
}

// --- laying out the store ------------------------------------------------
{
  const macros = Array.from({ length: 32 }, (_, i) => emptyMacro(i))
  macros[3] = { ...emptyMacro(3), events: tapEvents(0x04, 20, 40) }
  const blob = encodeMacros(macros, SPEC)

  eq('slot 0 starts right after the table', blob[0]! | (blob[1]! << 8), 64)
  // Each empty slot before 3 costs one stop record; slot 3's own body is two
  // events plus its stop.
  eq('slot 3 follows three stop records', blob[6]! | (blob[7]! << 8), 64 + 3 * 4)
  eq('slot 4 follows slot 3 body and stop', blob[8]! | (blob[9]! << 8), 64 + 3 * 4 + 3 * 4)

  ok('every slot is programmed and stops', isCanonical(blob, SPEC))
  eq('nothing is malformed', malformedSlots(decodeMacros(blob, SPEC)), [])

  eq('the write is table plus bodies', macroWriteBytes(macros, SPEC), 64 + (32 + 2) * 4)
  eq('records used counts the stop records', macroEventsUsed(macros, SPEC), 32 + 2)
  eq('and free is the rest', macroEventsFree(macros, SPEC), macroEventCapacity(SPEC) - 34)

  // The tail is zeroed rather than left as found, so two stores with the same
  // macros are the same bytes — which is what makes the read-back compare mean
  // something.
  ok('the tail past the last body is zero', blob.subarray(macroWriteBytes(macros, SPEC)).every((b) => b === 0))

  const played = play(imageOf(blob), 3)
  ok('slot 3 stops', played.stopped)
  eq('and types A, down then up', played.steps.slice(0, 2).map((s) => s.keys), [[0x04], []])
  eq('holding it for the press delay', played.steps[0]!.waitedMs, 20)
  eq('and pausing after the release', played.steps[1]!.waitedMs, 40)

  // Every other slot has to stop too, from its own offset. This is the
  // property that keeps a bound macro key safe no matter which slot it names.
  const image = imageOf(blob)
  ok(
    'and so does every other slot',
    Array.from({ length: 32 }, (_, i) => play(image, i)).every((p) => p.stopped),
  )
}

// --- a store the app did not write ---------------------------------------
{
  /*
   * The factory state: 4 KB of zeros. Every offset is 0, which points into the
   * offset table rather than at a body, and a zero control byte is neither a
   * stop nor a key — so the real player walks forward until it finds a byte
   * with bit 7 set. That is the hazard the panel refuses to bind through, and
   * this is where it is pinned.
   */
  const zeroed = new Uint8Array(4096)
  ok('a zeroed store is not canonical', !isCanonical(zeroed, SPEC))
  eq('and every slot is malformed', malformedSlots(decodeMacros(zeroed, SPEC)).length, 32)
  ok('no slot decodes as programmed', decodeMacros(zeroed, SPEC).every((m) => !m.programmed))
  ok('and the decoder invents no events', decodeMacros(zeroed, SPEC).every((m) => m.events.length === 0))
  // What the firmware would actually do with it, for the record: walk out of
  // the region without ever stopping.
  const ran = play(imageOf(zeroed), 0)
  ok('the real player would run off the end', !ran.stopped)
  ok('leaving the macro region as it went', ran.cursor >= 4096)

  /* An offset past the end of the region is the other malformed shape. */
  const wild = new Uint8Array(4096)
  wild[0] = 0xf0
  wild[1] = 0xff
  eq('an offset past the region is not a body', decodeMacro(wild, 0, SPEC).programmed, false)

  /* A body with no stop record before the region ends. */
  const unterminated = new Uint8Array(4096)
  unterminated[0] = 64
  for (let at = 64; at + 4 <= 4096; at += 4) unterminated[at + 2] = MACRO_CONTROL.press | MACRO_KIND.key
  const walked = decodeMacro(unterminated, 0, SPEC)
  ok('a body with no stop is reported', walked.programmed && !walked.terminated)
}

// --- round trips ---------------------------------------------------------
{
  /*
   * A store written by something else, with a nibble this player ignores in the
   * middle of it. Decoding and re-encoding must return the same bytes, or
   * editing one slot silently rewrites another.
   */
  const macros = Array.from({ length: 32 }, (_, i) => emptyMacro(i))
  macros[7] = {
    ...emptyMacro(7),
    events: [
      { action: { kind: 'modifiers', mask: 0x02 }, press: true, delayMs: 5 },
      { action: { kind: 'key', usage: 0x0b }, press: true, delayMs: 15 },
      { action: { kind: 'key', usage: 0x0b }, press: false, delayMs: 5 },
      { action: { kind: 'unknown', nibble: 6, value: 0x2a }, press: false, delayMs: 0 },
      { action: { kind: 'modifiers', mask: 0x02 }, press: false, delayMs: 0 },
    ],
  }
  const blob = encodeMacros(macros, SPEC)
  const back = decodeMacros(blob, SPEC)
  ok('the body survives a round trip', sameMacro(macros[7]!, back[7]!))
  eq('byte for byte', Array.from(encodeMacros(back, SPEC)), Array.from(blob))
  eq('the unknown nibble is kept', back[7]!.events[3]!.action, {
    kind: 'unknown',
    nibble: 6,
    value: 0x2a,
  })

  const played = play(imageOf(blob), 7)
  ok('it stops', played.stopped)
  eq('Shift goes down first', played.steps[0]!.mods, 0x02)
  eq('then H with Shift still held', [played.steps[1]!.mods, played.steps[1]!.keys], [0x02, [0x0b]])
  eq('the ignored record changes nothing', [played.steps[3]!.mods, played.steps[3]!.keys], [0x02, []])
  eq('and Shift comes up last', played.steps[4]!.mods, 0)
  eq('the whole thing takes 25 ms', played.totalMs, 25)
}

// --- editing helpers -----------------------------------------------------
{
  const one = tapEvents(0x04, 10, 20)
  eq('a tap is a press and a release', one.map((e) => e.press), [true, false])

  const twice = repeatEvents(one, 2, 100)
  eq('repeating doubles the records', twice.length, 4)
  eq('with the gap on the end of the first pass', twice[1]!.delayMs, 120)
  eq('and the last pass left alone', twice[3]!.delayMs, 20)
  eq('once is a copy', repeatEvents(one, 1, 100).length, 2)
  eq('and repeating nothing is nothing', repeatEvents([], 4, 100).length, 0)

  const macros = Array.from({ length: 32 }, (_, i) => emptyMacro(i))
  const edited = withMacro(macros, { ...emptyMacro(9), events: one })
  eq('only the named slot changes', edited.filter((m) => m.events.length > 0).map((m) => m.slot), [9])

  /* Past capacity is refused with the numbers, not silently truncated. */
  const huge: MacroEvent[] = Array.from({ length: macroEventCapacity(SPEC) }, () =>
    eventForUsage(0x04, true, 0),
  )
  let caught: unknown = null
  try {
    encodeMacros(withMacro(macros, { ...emptyMacro(0), events: huge }), SPEC)
  } catch (e) {
    caught = e
  }
  ok('an over-capacity store is refused', caught instanceof MacroCapacityError)
  ok('and says by how much', (caught as MacroCapacityError).needed > macroEventCapacity(SPEC))
}

// --- the write path, against a fake board --------------------------------

class FakeBoard {
  /** 0x07: the factory keymap, which is where the slot map comes from. */
  defaults = new Uint8Array(KEYMAP.blobSize)
  /** 0x08 / 0x09: the live keymap, both layers. */
  live = new Uint8Array(raven61Spec.keymap.layerBytes * raven61Spec.keymap.layers)
  /** 0x0c / 0x0d: the macro store. Zeroed, the way a reset leaves it. */
  macros = new Uint8Array(4096)
  sent: { command: number; offset: number; length: number }[] = []
  /** Set to drop writes on the floor while still acking them. */
  ignoreWrites = false

  constructor() {
    for (const key of RAVEN61_KEYS) {
      const at = slotFor(key.index) * KEYMAP.entrySize
      if (key.code >= 0xe0 && key.code <= 0xe7) {
        this.defaults[at] = KEYMAP.plainKey
        this.defaults[at + 1] = 1 << (key.code - 0xe0)
      } else if (key.code === KEYMAP.fnSelector) {
        this.defaults[at] = KEYMAP.layerKey
        this.defaults[at + 1] = KEYMAP.fnSelector
      } else {
        this.defaults[at] = KEYMAP.plainKey
        this.defaults[at + 2] = key.code
      }
    }
    this.live.set(this.defaults.subarray(0, raven61Spec.keymap.layerBytes))
  }

  handle(payload: Uint8Array): Uint8Array | null {
    if (payload[OFFSET.magic] !== MAGIC) throw new Error('bad magic')
    if (payload[OFFSET.checksum] !== checksum(payload)) throw new Error('bad checksum')
    const command = payload[OFFSET.command]!
    const offset = ((payload[BLOCK.offsetHi] ?? 0) << 8) | (payload[BLOCK.offsetLo] ?? 0)
    const length = payload[BLOCK.length] ?? 0
    this.sent.push({ command, offset, length })
    const reply = payload.slice()
    reply[0] = 0xaa
    if (command === 0x01 || command === 0x02) return reply
    if (command === 0x07 || command === 0x08 || command === 0x0c) {
      const src = command === 0x07 ? this.defaults : command === 0x08 ? this.live : this.macros
      reply.fill(0, BLOCK.data)
      reply.set(src.subarray(offset, offset + length), BLOCK.data)
      return reply
    }
    if (command === 0x09) {
      this.live.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
      return reply
    }
    if (command === 0x0d) {
      // The firmware's own bound: offset + length must stay inside the block.
      if (offset + length > 4096) throw new Error('write past the macro block')
      if (!this.ignoreWrites) {
        this.macros.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
      }
      return reply
    }
    return null
  }
}

function fakeLink(board: FakeBoard): HidLink {
  return {
    log: { note: () => {} },
    async request(data: Uint8Array) {
      const reply = board.handle(data)
      if (!reply) throw new Error('no reply')
      return { reportId: 0, data: reply }
    },
  } as unknown as HidLink
}

const A = RAVEN61_KEYS.find((k) => k.label === 'A')!

// --- reading a zeroed board ---
{
  const board = new FakeBoard()
  const snap = await readMacros(fakeLink(board))
  eq('32 slots come back', snap.macros.length, 32)
  ok('a factory board is not canonical', !snap.canonical)
  eq('and names every slot', snap.malformed.length, 32)
  eq('nothing is bound', snap.uses.length, 0)
  eq('the slot map came from the keymap', snap.slotMap.source, 'keymap')

  const reads = board.sent.filter((s) => s.command === 0x0c)
  eq('the whole store is read', reads.reduce((n, r) => n + r.length, 0), 4096)
  eq('from offset 0 upward', reads[0]!.offset, 0)
}

// --- writing the store ---
{
  const board = new FakeBoard()
  const snap = await readMacros(fakeLink(board))
  const macros: Macro[] = withMacro(snap.macros, {
    ...emptyMacro(2),
    events: tapEvents(0x04, 20, 40),
  })
  board.sent.length = 0
  const result = await writeMacros(fakeLink(board), macros)

  ok('the write went out', result.sent)
  eq('no slot read back wrong', result.mismatch, [])
  // Every slot changes, because every one of them was unprogrammed before —
  // the offsets and stop records are the point of the write.
  eq('all 32 slots are reported changed', result.changed.length, 32)
  eq('the bytes sent are the table plus the bodies', result.bytes, macroWriteBytes(macros, SPEC))

  const writes = board.sent.filter((s) => s.command === 0x0d)
  eq('sent as chunks from offset 0', writes[0]!.offset, 0)
  eq('covering exactly those bytes', writes.reduce((n, w) => n + w.length, 0), result.bytes)
  ok('and never past the block', writes.every((w) => w.offset + w.length <= 4096))
  eq('the keymap was not touched', board.sent.filter((s) => s.command === 0x09).length, 0)

  ok('the board is canonical afterwards', isCanonical(board.macros, SPEC))
  const played = play(imageOf(board.macros), 2)
  ok('slot 2 plays and stops', played.stopped)
  eq('typing A', played.steps.map((s) => s.keys), [[0x04], [], []])

  /* Applying the same store again sends nothing. */
  board.sent.length = 0
  const again = await writeMacros(fakeLink(board), decodeMacros(board.macros, SPEC))
  ok('an unchanged store is not written', !again.sent)
  eq('and nothing went out', board.sent.filter((s) => s.command === 0x0d).length, 0)
}

// --- a board that acks and ignores ---
{
  const board = new FakeBoard()
  const snap = await readMacros(fakeLink(board))
  board.ignoreWrites = true
  const result = await writeMacros(
    fakeLink(board),
    withMacro(snap.macros, { ...emptyMacro(1), events: tapEvents(0x05, 10, 10) }),
  )
  ok('an ignored write is reported', result.mismatch.length > 0)
  ok('and names a slot', result.mismatch[0]!.slot >= 0)
}

// --- the keymap entry that starts a macro ---
{
  const board = new FakeBoard()
  const at = slotFor(A.index) * KEYMAP.entrySize
  board.live[at] = RECORD_TYPE.macro
  board.live[at + 1] = 6
  board.live[at + 2] = 3

  const snap = await readMacros(fakeLink(board))
  eq('the bound key is found', snap.uses.length, 1)
  eq('on the base layer', snap.uses[0]!.layer, 0)
  eq('naming its key', snap.uses[0]!.label, 'A')
  eq('and its macro slot', snap.uses[0]!.macro, 6)
  // Reported, never acted on: the firmware stores this byte at gp-0x781 and
  // never reads it back.
  eq('with the repeat byte as found', snap.uses[0]!.repeat, 3)

  eq('and the record decodes the same way', decodeRecord(board.live, at), {
    kind: 'macro',
    slot: 6,
    repeat: 3,
  })
}

// --- a store the stock driver wrote --------------------------------------
{
  // The head of macro "M 1" in Raven Driver/asdf.xml, encoded the way 0x428440
  // encodes it: delay lo, delay hi, control, value, with the recording's VK
  // codes already through the driver's usage table (VK_S 0x53 -> usage 0x16).
  // Record 2 is the recording's one type-0 glitch, which the driver's encoder
  // has no arm for: it writes the delay and leaves control and value zero, so
  // the board just waits.
  const STOCK: number[][] = [
    [0x14, 0, 0x42, 0x16], // S down, 20 ms
    [0x03, 0, 0x42, 0x07], // D down, 3 ms
    [0x04, 0, 0x00, 0x00], // the glitch: a 4 ms pause and nothing else
    [0x07, 0, 0x42, 0x0e], // K down
    [0x15, 0, 0x42, 0x0d], // J down
    [0x0e, 0, 0x42, 0x09], // F down
    [0x05, 0, 0x02, 0x04], // A up
    [0x09, 0, 0x02, 0x0e], // K up
    [0x04, 0, 0x02, 0x16], // S up
    [0x01, 0, 0x82, 0x07], // D up — and bit 7, because it is the last record
  ]
  const stock = new Uint8Array(SPEC.blobBytes)
  stock[0] = MACRO_TABLE_BYTES
  STOCK.forEach((rec, i) => stock.set(rec, MACRO_TABLE_BYTES + i * 4))

  const read = decodeMacro(stock, 0, SPEC)
  ok('a stock body stops', read.terminated)
  eq('and keeps every record, the stop-bit one included', read.events.length, STOCK.length)
  eq('so the last event is the release it really is', read.events.at(-1), {
    action: { kind: 'key', usage: 0x07 },
    press: false,
    delayMs: 1,
  })
  eq('the glitch record survives as an unknown nibble', read.events[2], {
    action: { kind: 'unknown', nibble: 0, value: 0 },
    press: false,
    delayMs: 4,
  })
  eq('and re-encodes to the bytes it came from', encodeMacroEvent(read.events[2]!),
    [0x04, 0, 0x00, 0x00])

  const played = play(imageOf(stock), 0)
  ok('the player stops on the last record', played.stopped)
  eq('having released everything', played.steps.at(-1), { mods: 0, keys: [], waitedMs: 1 })
  eq('having pressed five keys along the way',
    played.steps.filter((st, i) => st.keys.length > (played.steps[i - 1]?.keys.length ?? 0)).length, 5)
  eq('and left none of them held', played.steps.at(-1)!.keys, [])

  // The stock driver writes a prefix too, and its empty macros are the reason
  // this app terminates all 32 slots: theirs point at the first byte it did not
  // send, where whatever the flash already held decides what the board types.
  eq('the stock store is table plus records', MACRO_TABLE_BYTES + 631 * 4, 2588)
  const stray = new Uint8Array(SPEC.blobBytes)
  stray[0] = MACRO_TABLE_BYTES
  stray[2] = 0x1c
  stray[3] = 0x0a // slot 1 -> 2588, past everything written
  STOCK.forEach((rec, i) => stray.set(rec, MACRO_TABLE_BYTES + i * 4))
  ok('a stock store is not canonical', !isCanonical(stray, SPEC))
  ok('slot 1 among the malformed', malformedSlots(decodeMacros(stray, SPEC)).includes(1))
  ok('and its body never stops', !play(imageOf(stray), 1).stopped)

  // Its recorder's budget, which is not the firmware's and not this app's.
  eq('the stock recorder allows 650 records', MACRO_STOCK.events, 650)
  eq('and exposes ten of the 32 slots', MACRO_STOCK.slots, 10)
  ok('this block holds more than that', macroEventCapacity(SPEC) > MACRO_STOCK.events)
  const oneSlot = (events: MacroEvent[]): Macro[] =>
    [{ slot: 0, events, programmed: true, terminated: true, offset: 0 }]
  // 330 taps is 660 records, and the 32 stop records put it further over.
  ok('so 660 records is over the stock budget',
    overStockBudget(oneSlot(repeatEvents(tapEvents(0x04, 40, 30), 330)), SPEC))
  ok('while 200 is not', !overStockBudget(oneSlot(repeatEvents(tapEvents(0x04, 40, 30), 100)), SPEC))
}

if (fails.length > 0) {
  console.error(`macros: ${pass} passed, ${fails.length} failed`)
  for (const f of fails) console.error('  ' + f)
  process.exit(1)
}
console.log(`macros: ${pass} passed, 0 failed`)
