/**
 * Checks the per-key performance write against a fake board. `npm run check`.
 *
 * Why this exists rather than a hand test on hardware: the write is the one
 * operation in this project that changes the user's keyboard, and its packet
 * sequence came from static analysis of the stock driver — 0x01, then 19 chunks
 * of 0xa1 at 56-byte offsets with a 16-byte last one, then 0x02 (0x42c390, see
 * docs/protocol.md §4.5). A write that gets the sequence wrong can still look
 * completely fine in the UI, because the read path is separate code. So the
 * fake board here records what it was sent, and these checks pin the sequence
 * to what the binary does.
 *
 * The rest is about not sending bytes we did not read. A KeyConfig built from
 * factory defaults carries no switch_type and none of rec[0]'s three unknown
 * bits, and writing one would zero both on every key it touched.
 *
 * Run it after touching keyPerf.ts, slotMap.ts, or the write path in
 * raven61.ts.
 */
import type { HidLink } from '../../src/hid/link'
import { BLOCK, MAGIC, OFFSET, checksum } from '../../src/protocol/frame'
import {
  KEY_PERF,
  decodeKeyPerfRecord,
  encodeKeyPerfRecord,
  recordHex,
  toKeyConfig,
} from '../../src/protocol/keyPerf'
import { KEYMAP, slotMapFromKeymap } from '../../src/protocol/slotMap'
import { writeKeyPerfConfigs } from '../../src/protocol/raven61'
import { RAVEN61_KEYS } from '../../src/device/boards/raven61/layout'
import { raven61Spec } from '../../src/device/boards/raven61/index'
import { layoutOf } from '../../src/device/layout'
import { mmToCounts } from '../../src/protocol/encoding'
import type { KeyConfig } from '../../src/protocol/types'
import { defaultKeyConfig } from '../../src/state/config'

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

/** Slots with the three holes the real board has, so the mapping is exercised. */
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

const nulls = () => RAVEN61_KEYS.map(() => null) as (KeyConfig | null)[]
const boardConfig = (board: FakeBoard, index: number) =>
  toKeyConfig(decodeKeyPerfRecord(board.perf, slotFor(index)))

class FakeBoard {
  perf = new Uint8Array(KEY_PERF.blobSize)
  keymap = new Uint8Array(KEYMAP.blobSize)
  sent: { command: number; offset: number; length: number }[] = []
  /** Set to drop writes on the floor while still acking them. */
  ignoreWrites = false
  /** Set to alter one byte of a write, the way a clamping firmware might. */
  clampSlot = -1

  constructor() {
    for (const key of RAVEN61_KEYS) {
      const slot = slotFor(key.index)
      const at = slot * KEYMAP.entrySize
      // KeyDef calls the HID usage `code`; the modifiers go on the wire as a
      // bitmask with no usage byte, the way the board reports them.
      if (key.code >= 0xe0 && key.code <= 0xe7) {
        this.keymap[at] = KEYMAP.plainKey
        this.keymap[at + 1] = 1 << (key.code - 0xe0)
      } else if (key.code === KEYMAP.fnSelector) {
        this.keymap[at] = KEYMAP.layerKey
        this.keymap[at + 1] = KEYMAP.fnSelector
      } else {
        this.keymap[at] = KEYMAP.plainKey
        this.keymap[at + 2] = key.code
      }
      // switch_type 5 with the unknown 0xa0 flags set, rapid trigger on, 2.60 mm
      this.perf.set(
        encodeKeyPerfRecord({
          switchType: 5,
          switchFlags: 0xa0,
          keyMode: 1,
          actuationCounts: 130,
          rtPressCounts: 26,
          rtReleaseCounts: 31,
          pressDeadzoneCounts: 0,
          releaseDeadzoneCounts: 0,
          deadzoneState: false,
          rtUnset: false,
        }),
        slot * KEY_PERF.recordSize,
      )
    }
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
    if (command === 0xa0 || command === 0x07) {
      const src = command === 0xa0 ? this.perf : this.keymap
      reply.fill(0, BLOCK.data)
      reply.set(src.subarray(offset, offset + length), BLOCK.data)
      return reply
    }
    if (command === 0xa1) {
      if (!this.ignoreWrites) {
        this.perf.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
        if (this.clampSlot >= 0) {
          const at = this.clampSlot * KEY_PERF.recordSize
          if (at >= offset && at < offset + length) this.perf[at + 2] = 0xff
        }
      }
      return reply
    }
    return null
  }
}

/** Just enough of HidLink for the codec: request(), and a log that notes. */
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

// The fake board's keymap must resolve every key, or readSlotMap falls back to
// the layout-order guess and the tests below stop testing the mapping at all.
// That is not hypothetical: the first cut of this fake wrote the wrong field
// and every mapping assertion still passed, because the fallback happened to
// agree with it.
{
  const map = slotMapFromKeymap(new FakeBoard().keymap, layoutOf(raven61Spec.layout))
  eq('fake keymap resolves every key', map.slotByKey.size, RAVEN61_KEYS.length)
  eq('and places A where the test expects', map.slotByKey.get(A.index), slotFor(A.index))
  eq('no unknown usages', map.unknownUsages, [])
}

// --- one key's actuation, 2.60 -> 1.50 mm ---
{
  const board = new FakeBoard()
  const before = board.perf.slice()
  const configs = nulls()
  configs[A.index] = { ...boardConfig(board, A.index), actuationMm: 1.5 }

  const r = await writeKeyPerfConfigs(fakeLink(board), configs)

  eq('one slot changed', r.slots, [slotFor(A.index)])
  eq('key reported with its slot', r.keys, [
    { index: A.index, label: 'A', slot: slotFor(A.index) },
  ])
  eq('nothing unmapped', r.unmapped, [])
  eq('verified', r.mismatched, [])
  eq(
    'board actuation is now 75 counts',
    decodeKeyPerfRecord(board.perf, slotFor(A.index)).actuationCounts,
    75,
  )
  eq('switch type untouched', recordHex(board.perf, slotFor(A.index)), 'a5 01 4a 00 19 00 1e 00')
  eq('decoded config handed back', r.configs[A.index]!.actuationMm, 1.5)
  eq('other keys untouched', decodeKeyPerfRecord(board.perf, slotFor(0)).actuationCounts, 130)

  // The exact packet sequence, which is the thing static analysis pinned down.
  const writes = board.sent.filter((s) => s.command === 0xa1)
  eq('19 write chunks', writes.length, 19)
  eq(
    'write offsets',
    writes.map((w) => w.offset),
    Array.from({ length: 19 }, (_, i) => i * 56),
  )
  eq(
    'write lengths',
    writes.map((w) => w.length),
    [...Array(18).fill(56), 16],
  )
  const order = board.sent.map((s) => s.command)
  const firstWrite = order.indexOf(0xa1)
  eq('0x01 opens the write', order[firstWrite - 1], 0x01)
  eq('0x02 closes it', order[firstWrite + 19], 0x02)
  eq('read before the write', order.indexOf(0xa0) < firstWrite, true)
  eq('verify read after it', order.lastIndexOf(0xa0) > firstWrite, true)
  ok('before blob kept verbatim', r.before.every((b, i) => b === before[i]))
  eq(
    'after blob matches the board',
    recordHex(r.after, slotFor(A.index)),
    recordHex(board.perf, slotFor(A.index)),
  )
}

// --- a board that acks and ignores must not report success ---
{
  const board = new FakeBoard()
  board.ignoreWrites = true
  const configs = nulls()
  configs[A.index] = { ...boardConfig(board, A.index), actuationMm: 1.5 }
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('ignored write is caught', r.mismatched.length, 1)
  eq('mismatch names the slot', r.mismatched[0]!.slot, slotFor(A.index))
  eq(
    'mismatch shows both records',
    [r.mismatched[0]!.wanted, r.mismatched[0]!.got],
    ['a5 01 4a 00 19 00 1e 00', 'a5 01 81 00 19 00 1e 00'],
  )
}

// --- a firmware that alters one byte is reported, not swallowed ---
{
  const board = new FakeBoard()
  board.clampSlot = slotFor(A.index)
  const configs = nulls()
  configs[A.index] = { ...boardConfig(board, A.index), actuationMm: 1.5 }
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('clamped byte reported', r.mismatched.length, 1)
  eq('got shows the clamp', r.mismatched[0]!.got, 'a5 01 ff 00 19 00 1e 00')
}

// --- all 61 keys at once ---
{
  const board = new FakeBoard()
  const configs = RAVEN61_KEYS.map((k) => ({ ...boardConfig(board, k.index), actuationMm: 0.5 }))
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('61 slots changed', r.slots.length, 61)
  eq('all verified', r.mismatched, [])
  eq(
    'holes untouched',
    HOLES.map((s) => board.perf.subarray(s * 8, s * 8 + 8).every((b) => b === 0)),
    [true, true, true],
  )
  ok(
    'every key is 25 counts',
    RAVEN61_KEYS.every(
      (k) => decodeKeyPerfRecord(board.perf, slotFor(k.index)).actuationCounts === mmToCounts(0.5),
    ),
  )
  eq('still 19 chunks', board.sent.filter((s) => s.command === 0xa1).length, 19)
}

// --- nothing changed: no write is sent at all ---
{
  const board = new FakeBoard()
  const configs = RAVEN61_KEYS.map((k) => boardConfig(board, k.index))
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('no slots changed', r.slots, [])
  eq('no 0xa1 packets', board.sent.filter((s) => s.command === 0xa1).length, 0)
  ok('before === after', r.before === r.after)
}

// --- a key the keymap has no slot for is reported, not silently skipped ---
{
  const board = new FakeBoard()
  const at = slotFor(A.index) * KEYMAP.entrySize
  board.keymap.fill(0, at, at + KEYMAP.entrySize)
  const configs = nulls()
  configs[A.index] = { ...boardConfig(board, A.index), actuationMm: 1.5 }
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('A reported unmapped', r.unmapped, [{ index: A.index, label: 'A' }])
  eq('nothing written', r.slots, [])
}

// --- a board whose keymap cannot be read must not be written blind ---
{
  const board = new FakeBoard()
  // Blank the whole keymap: readSlotMap then falls back to the layout-order
  // guess, which is known wrong on real hardware.
  board.keymap.fill(0)
  const configs = nulls()
  configs[A.index] = { ...boardConfig(board, A.index), actuationMm: 1.5 }
  let threw = ''
  try {
    await writeKeyPerfConfigs(fakeLink(board), configs)
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  ok('fallback mapping refuses the write', threw.length > 0, threw)
  eq('and sends no 0xa1', board.sent.filter((s) => s.command === 0xa1).length, 0)
}

// --- a config with no switch type must not zero the board's ---
{
  const board = new FakeBoard()
  const configs = nulls()
  // A factory-default config: no switchType, no switchFlags. This is what an
  // app that wrote before reading would send.
  configs[A.index] = { ...defaultKeyConfig(), actuationMm: 1.5 }
  const r = await writeKeyPerfConfigs(fakeLink(board), configs)
  eq('write verified', r.mismatched, [])
  eq(
    'switch type 5 and flags 0xa0 survive',
    recordHex(board.perf, slotFor(A.index)),
    // rec[0] still a5: switch type 5, flags 0xa0. The rapid-trigger bytes are
    // the factory default of 5 counts, which goes on the wire as 4.
    'a5 00 4a 00 04 00 04 00',
  )
  eq('switch type still 5', decodeKeyPerfRecord(board.perf, slotFor(A.index)).switchType, 5)
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
