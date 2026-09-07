/**
 * Checks the per-key colour read and write against a fake board. `npm run check`.
 *
 * This is the third block this project writes to a user's keyboard, and it is
 * the one with the worst history: lighting is where an early probe sweep landed
 * and left the LEDs stuck on a pattern only the stock driver could clear
 * (findings.md #4). Neither of its commands came from a capture — 0x0a and 0x0b
 * were read out of the firmware's block map, and the record layout out of the
 * LED path at 0x135f8 — so the sequence is pinned here rather than trusted:
 * seven 0x0b chunks at `i * 56`, six of 56 bytes and a last of 48, bracketed by
 * 0x01 and 0x02, with every byte the caller did not name copied from the read.
 *
 * The two properties worth more than the byte counts:
 *
 *   - **A write touches only the named keys.** The block is 128 slots wide for
 *     61 keys; a write built from the app's model rather than from the board's
 *     own bytes would zero the rest.
 *   - **A write that is ignored is reported.** The firmware acks the chunk
 *     either way, so the only thing that can tell the difference is the verify
 *     read — and `ignoreWrites` below makes a board that does exactly that.
 *
 * Run it after touching keyRgb.ts or the colour path in engine.ts.
 */
import type { HidLink } from '../../src/hid/link'
import { RAVEN61_KEYS } from '../../src/device/boards/raven61/layout'
import { BLOCK, MAGIC, OFFSET, checksum } from '../../src/protocol/frame'
import { KEYMAP } from '../../src/protocol/slotMap'
import {
  KEY_RGB,
  UNLIT,
  clampRgb,
  changedRgbSlots,
  decodeKeyRgb,
  encodeKeyRgb,
  hexOf,
  isUnlit,
  keyRgbBlobSize,
  luminanceOf,
  parseHex,
  rgbRecordHex,
  sameRgb,
  type Rgb,
} from '../../src/protocol/keyRgb'
import {
  readKeyColors,
  readLightFrame,
  watchLightFrame,
  writeKeyColors,
} from '../../src/protocol/raven61'

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

/** The factory keymap record for a key — what the slot map is built from. */
function factoryRecord(code: number): [number, number, number] {
  if (code >= 0xe0 && code <= 0xe7) return [KEYMAP.plainKey, 1 << (code - 0xe0), 0]
  if (code === KEYMAP.fnSelector) return [KEYMAP.layerKey, KEYMAP.fnSelector, 1]
  return [KEYMAP.plainKey, 0, code]
}

class FakeBoard {
  /** 0x07: the factory keymap, which is where the slot map comes from. */
  defaults = new Uint8Array(KEYMAP.blobSize)
  /** 0x0a / 0x0b: the stored colour layer. */
  rgb = new Uint8Array(keyRgbBlobSize(KEY_RGB))
  /** 0xde: what the LEDs are showing. Set by the test, never by a write. */
  frame = new Uint8Array(keyRgbBlobSize(KEY_RGB))
  sent: { command: number; offset: number; length: number }[] = []
  /** Set to drop writes on the floor while still acking them. */
  ignoreWrites = false
  /** Set to leave the slot map unresolvable, so a write must refuse. */
  breakKeymap = false
  /** Set to stop answering anything — a board that has gone away mid-watch. */
  silent = false

  constructor() {
    for (const key of RAVEN61_KEYS) {
      this.defaults.set(factoryRecord(key.code), slotFor(key.index) * KEYMAP.entrySize)
    }
  }

  handle(payload: Uint8Array): Uint8Array | null {
    if (this.silent) return null
    if (payload[OFFSET.magic] !== MAGIC) throw new Error('bad magic')
    if (payload[OFFSET.checksum] !== checksum(payload)) throw new Error('bad checksum')
    const command = payload[OFFSET.command]!
    const offset = ((payload[BLOCK.offsetHi] ?? 0) << 8) | (payload[BLOCK.offsetLo] ?? 0)
    const length = payload[BLOCK.length] ?? 0
    this.sent.push({ command, offset, length })
    const reply = payload.slice()
    reply[0] = 0xaa
    if (command === 0x01 || command === 0x02) return reply
    if (command === 0x07) {
      reply.fill(0, BLOCK.data)
      // A board that answers the keymap read with zeros resolves no slots, so
      // the map falls back to layout order — which is what a write must refuse.
      if (!this.breakKeymap) {
        reply.set(this.defaults.subarray(offset, offset + length), BLOCK.data)
      }
      return reply
    }
    if (command === 0x0a || command === 0xde) {
      const src = command === 0x0a ? this.rgb : this.frame
      reply.fill(0, BLOCK.data)
      reply.set(src.subarray(offset, offset + length), BLOCK.data)
      return reply
    }
    if (command === 0x0b) {
      if (!this.ignoreWrites) {
        this.rgb.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
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

const nulls = () => RAVEN61_KEYS.map(() => null) as (Rgb | null)[]
const A = RAVEN61_KEYS.find((k) => k.label === 'A')!
const W = RAVEN61_KEYS.find((k) => k.label === 'W')!
const RED: Rgb = { r: 255, g: 0, b: 0 }
const TEAL: Rgb = { r: 0, g: 128, b: 128 }
const record = (blob: Uint8Array, slot: number) =>
  Array.from(blob.subarray(slot * KEY_RGB.recordSize, slot * KEY_RGB.recordSize + 3))

// --- the codec, on its own ---
{
  eq('blob is 384 bytes', keyRgbBlobSize(KEY_RGB), 384)
  eq('one record is R, G, B in order', (() => {
    const blob = new Uint8Array(keyRgbBlobSize(KEY_RGB))
    encodeKeyRgb(blob, 5, { r: 0x12, g: 0x34, b: 0x56 })
    return record(blob, 5)
  })(), [0x12, 0x34, 0x56])
  eq('and reads back', (() => {
    const blob = new Uint8Array(keyRgbBlobSize(KEY_RGB))
    encodeKeyRgb(blob, 5, { r: 0x12, g: 0x34, b: 0x56 })
    return decodeKeyRgb(blob, 5)
  })(), { r: 0x12, g: 0x34, b: 0x56 })
  // A record is written at slot * 3 and nowhere else. Off-by-one here would put
  // one key's colour across two others.
  eq('a record does not spill', (() => {
    const blob = new Uint8Array(keyRgbBlobSize(KEY_RGB))
    encodeKeyRgb(blob, 5, { r: 1, g: 2, b: 3 })
    return [record(blob, 4), record(blob, 6)]
  })(), [[0, 0, 0], [0, 0, 0]])

  ok('three zero bytes are unlit', isUnlit(UNLIT) && isUnlit({ r: 0, g: 0, b: 0 }))
  ok('anything else is not', !isUnlit({ r: 0, g: 0, b: 1 }))
  eq('hex round trip', parseHex(hexOf(TEAL)), TEAL)
  eq('hex needs no hash', parseHex('ff8000'), { r: 255, g: 128, b: 0 })
  eq('a short hex is not a colour', parseHex('#fff'), null)
  eq('nor is a word', parseHex('red'), null)
  eq('out of range saturates', clampRgb({ r: -3, g: 300, b: 12.6 }), { r: 0, g: 255, b: 13 })
  eq('and NaN is not a channel', clampRgb({ r: NaN, g: 0, b: 0 }), { r: 0, g: 0, b: 0 })
  ok('same colours compare equal', sameRgb(RED, { r: 255, g: 0, b: 0 }))
  ok('different ones do not', !sameRgb(RED, TEAL))

  /*
   * Luma, not a mean. The legend colour on a painted cap is chosen from this,
   * and the two colours below are exactly the pair a mean of the channels gets
   * wrong: they have the same average and nothing like the same brightness.
   */
  ok('yellow reads as light', luminanceOf({ r: 255, g: 255, b: 0 }) > 0.55)
  ok('blue reads as dark', luminanceOf({ r: 0, g: 0, b: 255 }) < 0.55)

  eq('changed slots are found by record', (() => {
    const a = new Uint8Array(keyRgbBlobSize(KEY_RGB))
    const b = a.slice()
    encodeKeyRgb(b, 7, RED)
    b[9 * KEY_RGB.recordSize + 2] = 1
    return changedRgbSlots(a, b)
  })(), [7, 9])
  eq('record hex', (() => {
    const blob = new Uint8Array(keyRgbBlobSize(KEY_RGB))
    encodeKeyRgb(blob, 2, { r: 0, g: 0x80, b: 0x80 })
    return rgbRecordHex(blob, 2)
  })(), '00 80 80')
}

// --- reading the stored layer ---
{
  const board = new FakeBoard()
  encodeKeyRgb(board.rgb, slotFor(A.index), TEAL)

  const snapshot = await readKeyColors(fakeLink(board))
  eq('one entry per key', snapshot.entries.length, RAVEN61_KEYS.length)
  eq('A carries its slot', snapshot.entries[A.index]!.slot, slotFor(A.index))
  eq('and the colour in it', snapshot.entries[A.index]!.color, TEAL)
  ok('every other key is unlit', snapshot.entries.every((e, i) => i === A.index || isUnlit(e.color)))
  ok('the raw block is kept', snapshot.blob.length === 384)
  eq('the slot map came from the keymap', snapshot.slotMap.source, 'keymap')
  ok('it is the stored layer, not the frame', snapshot.live === false)

  // The read plan the firmware's handler takes: 56-byte chunks at ascending
  // offsets with a short last one, and nothing beyond the block.
  const reads = board.sent.filter((s) => s.command === 0x0a)
  eq('seven read chunks', reads.length, 7)
  eq(
    'at ascending offsets',
    reads.map((r) => r.offset),
    Array.from({ length: 7 }, (_, i) => i * 56),
  )
  eq('six of 56 and a last of 48', reads.map((r) => r.length), [56, 56, 56, 56, 56, 56, 48])
}

// --- the live frame is a different memory ---
{
  const board = new FakeBoard()
  encodeKeyRgb(board.rgb, slotFor(A.index), TEAL)
  // What the firmware is actually showing: the calibration overlay has painted
  // A red over the stored teal. The two blocks disagreeing is the normal case,
  // and a panel that used one for the other would report a failed write.
  encodeKeyRgb(board.frame, slotFor(A.index), RED)

  const frame = await readLightFrame(fakeLink(board))
  eq('the frame is what 0xde returned', frame.entries[A.index]!.color, RED)
  ok('and says it is live', frame.live === true)
  ok('read with 0xde', board.sent.some((s) => s.command === 0xde))
  ok('and never with 0x0a', !board.sent.some((s) => s.command === 0x0a))
  /*
   * No transaction brackets of its own: it reads a buffer the firmware keeps
   * for itself, and there is no stock-driver write for it to bracket. The one
   * pair on the wire belongs to the slot-map read it needs first, which is why
   * this counts them instead of asserting there are none.
   */
  eq('one transaction, and it is the slot map read', board.sent.filter((s) => s.command === 0x01).length, 1)
}

// --- the watch keeps reading it, and reads the slot map once ---
{
  const board = new FakeBoard()
  encodeKeyRgb(board.frame, slotFor(A.index), TEAL)

  const frames: Rgb[] = []
  const stop = await watchLightFrame(
    fakeLink(board),
    (snapshot) => {
      frames.push(snapshot.entries[A.index]!.color)
      // The board changes what it is showing between frames, the way a running
      // effect would. A watch that decoded the first frame forever would pass
      // every other check in this file.
      encodeKeyRgb(board.frame, slotFor(A.index), { r: frames.length, g: 0, b: 0 })
    },
    { intervalMs: 1 },
  )

  await new Promise((r) => setTimeout(r, 60))
  stop()
  const after = frames.length

  ok('it read more than one frame', after > 2, `${after} frames`)
  eq('the first is what the board was showing', frames[0], TEAL)
  eq('and later ones follow it', frames[1], { r: 1, g: 0, b: 0 })

  // The expensive half. The keymap block is 768 bytes to the frame's 384 and it
  // cannot move while the board stays plugged in, so a watch that re-read it per
  // frame would spend most of its traffic learning nothing.
  const mapChunks = board.sent.filter((s) => s.command === 0x07).length
  eq('the slot map was read once', mapChunks, 14)

  // Seven chunks a frame, and no more: a second read starting before the first
  // finished would interleave chunks at the wrong offsets.
  eq('seven chunks per frame', board.sent.filter((s) => s.command === 0xde).length, after * 7)

  await new Promise((r) => setTimeout(r, 30))
  eq('stop means stop', frames.length, after)
}

// --- a watch stops itself when the board stops answering ---
{
  const board = new FakeBoard()
  let frames = 0
  const errors: string[] = []
  const stop = await watchLightFrame(
    fakeLink(board),
    () => {
      frames++
      // Whatever the board was doing, it is not answering any more.
      board.silent = true
    },
    { intervalMs: 1, onError: (m) => errors.push(m) },
  )

  await new Promise((r) => setTimeout(r, 60))
  stop()

  eq('it delivered the frame it got', frames, 1)
  eq('and reported the failure once', errors.length, 1)
  // Not "it retried a few times": a board that has gone away must not be asked
  // ten times a second forever. The caller turns the watch back on.
  ok('then stayed stopped', board.sent.filter((s) => s.command === 0xde).length <= 8)
}

// --- a watch on an unreadable keymap runs, and says the map is a guess ---
{
  const board = new FakeBoard()
  board.breakKeymap = true

  let source: string | undefined
  const stop = await watchLightFrame(
    fakeLink(board),
    (snapshot) => {
      source = snapshot.slotMap.source
    },
    { intervalMs: 1 },
  )
  await new Promise((r) => setTimeout(r, 20))
  stop()

  /*
   * Unlike a write, which refuses. A read on the guessed map shows the right
   * colours on the wrong caps, which is recoverable by reading again and is
   * worth showing with a label; a write on it changes the wrong keys, which is
   * not. So the watch runs and hands the panel the fact it needs.
   */
  ok('the watch ran anyway', source !== undefined)
  eq('and said the map is a guess', source, 'fallback')
}

// --- writing one key ---
{
  const board = new FakeBoard()
  // Something already in the block that the write must not disturb: a colour on
  // another key, and a slot no key maps to at all.
  encodeKeyRgb(board.rgb, slotFor(W.index), TEAL)
  encodeKeyRgb(board.rgb, 120, { r: 9, g: 9, b: 9 })

  const colors = nulls()
  colors[A.index] = RED
  const r = await writeKeyColors(fakeLink(board), colors)

  eq('one slot changed', r.slots, [slotFor(A.index)])
  eq('the key is reported with its slot', r.keys, [
    { index: A.index, label: 'A', slot: slotFor(A.index) },
  ])
  eq('nothing unmapped', r.unmapped, [])
  eq('verified', r.mismatched, [])
  eq('A is red', record(board.rgb, slotFor(A.index)), [255, 0, 0])
  eq('W kept its colour', record(board.rgb, slotFor(W.index)), [0, 128, 128])
  eq('an unmapped slot was carried through', record(board.rgb, 120), [9, 9, 9])

  const writes = board.sent.filter((s) => s.command === 0x0b)
  eq('seven write chunks', writes.length, 7)
  eq(
    'at ascending offsets',
    writes.map((w) => w.offset),
    Array.from({ length: 7 }, (_, i) => i * 56),
  )
  eq('six of 56 and a last of 48', writes.map((w) => w.length), [56, 56, 56, 56, 56, 56, 48])
  ok('bracketed by 0x01', board.sent.some((s) => s.command === 0x01))
  ok('and closed with 0x02', board.sent.some((s) => s.command === 0x02))
}

// --- clearing a key ---
{
  const board = new FakeBoard()
  encodeKeyRgb(board.rgb, slotFor(A.index), RED)

  const colors = nulls()
  // Three zero bytes are a value, not "leave alone": the board reads them as
  // *no custom colour*, so clearing a key has to be expressible.
  colors[A.index] = UNLIT
  const r = await writeKeyColors(fakeLink(board), colors)

  eq('the slot changed', r.slots, [slotFor(A.index)])
  eq('A is unlit again', record(board.rgb, slotFor(A.index)), [0, 0, 0])
  eq('verified', r.mismatched, [])
}

// --- a write with nothing to change sends nothing ---
{
  const board = new FakeBoard()
  encodeKeyRgb(board.rgb, slotFor(A.index), RED)

  const colors = nulls()
  colors[A.index] = RED
  const r = await writeKeyColors(fakeLink(board), colors)

  eq('no slots changed', r.slots, [])
  ok('so no chunk went out', !board.sent.some((s) => s.command === 0x0b))
  // The keys are still reported: they were named, and the caller asked for
  // them. "Nothing to send" is the panel's message, not a silence.
  eq('the key is still reported', r.keys.length, 1)
  eq('verified', r.mismatched, [])
}

// --- a board that acks and ignores is caught ---
{
  const board = new FakeBoard()
  board.ignoreWrites = true

  const colors = nulls()
  colors[A.index] = RED
  const r = await writeKeyColors(fakeLink(board), colors)

  eq('one slot reported as unwritten', r.mismatched.length, 1)
  eq('with the bytes both ways', r.mismatched[0], {
    slot: slotFor(A.index),
    wanted: 'ff 00 00',
    got: '00 00 00',
  })
}

// --- a write refuses to run on a guessed slot map ---
{
  const board = new FakeBoard()
  board.breakKeymap = true

  const colors = nulls()
  colors[A.index] = RED
  let threw = false
  try {
    await writeKeyColors(fakeLink(board), colors)
  } catch {
    threw = true
  }
  // The fallback map is *known* wrong, so painting on it would colour the wrong
  // caps of the actual board. Same rule as the perf and keymap writes.
  ok('a fallback map refuses the write', threw)
  ok('and nothing was sent', !board.sent.some((s) => s.command === 0x0b))
}

if (fails.length > 0) {
  console.error(`rgb-write: ${pass} passed, ${fails.length} failed`)
  for (const f of fails) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`rgb-write: ${pass} passed, 0 failed`)
export {}
