/**
 * Checks the keymap read and write against a fake board. `npm run check`.
 *
 * The keymap write is the second operation in this project that changes the
 * user's keyboard, and neither of its commands came from a capture: both were
 * read out of the firmware (0x694c for the live read) and the driver's job 7 at
 * 0x427ac0 (for the write). The board has since confirmed both, which is the
 * reason to pin them here rather than to stop: the sequence is now the known
 * good one — ten 0x09 chunks at `layer * 512 + i * 56`, nine of 56 bytes and a
 * last of 8, bracketed by 0x01 and 0x02 — and a change that breaks it should
 * fail here rather than on someone's keyboard.
 *
 * The other half is the record codec. Every entry the picker offers has to
 * survive encode → decode unchanged, or a key would show one binding and send
 * another.
 *
 * Run it after touching keymap.ts or the keymap path in raven61.ts.
 */
import type { HidLink } from '../../src/hid/link'
import { RAVEN61_KEYS } from '../../src/device/boards/raven61/layout'
import { raven61Spec } from '../../src/device/boards/raven61/index'
import { layoutOf } from '../../src/device/layout'
import { BLOCK, MAGIC, OFFSET, checksum } from '../../src/protocol/frame'
import {
  BINDING_GROUPS,
  KEYMAP_BLOCK,
  decodeRecord,
  encodeRecord,
  sameBinding,
  type KeyBinding,
} from '../../src/protocol/keymap'
import { readKeymapLayer, writeKeymapLayer } from '../../src/protocol/raven61'
import { KEYMAP, slotMapFromKeymap } from '../../src/protocol/slotMap'
import type { KeymapEntry } from '../../src/protocol/types'

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

/** The factory record for a key, in the encoding slotMap.ts documents. */
function factoryRecord(code: number): [number, number, number] {
  if (code >= 0xe0 && code <= 0xe7) return [KEYMAP.plainKey, 1 << (code - 0xe0), 0]
  if (code === KEYMAP.fnSelector) return [KEYMAP.layerKey, KEYMAP.fnSelector, 1]
  return [KEYMAP.plainKey, 0, code]
}

class FakeBoard {
  /** 0x07: the factory table, 768 bytes, which is what the slot map comes from. */
  defaults = new Uint8Array(KEYMAP.blobSize)
  /** 0x08 / 0x09: the live keymap, two layers of 512. */
  live = new Uint8Array(KEYMAP_BLOCK.layerBytes * KEYMAP_BLOCK.layers)
  sent: { command: number; offset: number; length: number }[] = []
  /** Set to drop writes on the floor while still acking them. */
  ignoreWrites = false

  constructor() {
    for (const key of RAVEN61_KEYS) {
      const at = slotFor(key.index) * KEYMAP.entrySize
      const record = factoryRecord(key.code)
      this.defaults.set(record, at)
      this.live.set(record, at)
      // Layer 1 starts out as the stock database has it: mostly unassigned,
      // with the Fn key itself still the layer switch.
      this.live.set(
        key.code === KEYMAP.fnSelector ? record : [KEYMAP.plainKey, 0, 0],
        KEYMAP_BLOCK.layerBytes + at,
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
    if (command === 0x07 || command === 0x08) {
      const src = command === 0x07 ? this.defaults : this.live
      reply.fill(0, BLOCK.data)
      reply.set(src.subarray(offset, offset + length), BLOCK.data)
      return reply
    }
    if (command === 0x09) {
      if (!this.ignoreWrites) {
        this.live.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
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

const nulls = () => RAVEN61_KEYS.map(() => null) as (KeymapEntry | null)[]
const A = RAVEN61_KEYS.find((k) => k.label === 'A')!
const CAPS = RAVEN61_KEYS.find((k) => k.label === 'Caps')!
const record = (blob: Uint8Array, layer: number, slot: number) =>
  Array.from(
    blob.subarray(
      layer * KEYMAP_BLOCK.layerBytes + slot * KEYMAP_BLOCK.entrySize,
      layer * KEYMAP_BLOCK.layerBytes + slot * KEYMAP_BLOCK.entrySize + 3,
    ),
  )

// --- the record codec round-trips everything the picker can produce ---
{
  for (const group of BINDING_GROUPS) {
    for (const choice of group.choices) {
      const bytes = encodeRecord(choice.binding)
      const back = decodeRecord(bytes)
      ok(
        `round trip ${choice.label}`,
        sameBinding(back, choice.binding),
        `${bytes.map((b) => b.toString(16)).join(' ')} decoded as ${JSON.stringify(back)}`,
      )
    }
  }
  // The two shapes the factory keymap uses, which the decoder has to read the
  // same way slotMap.ts does.
  eq('modifier record', decodeRecord([0x10, 0x02, 0x00]), {
    kind: 'key',
    usage: 0,
    modifiers: 0x02,
  })
  eq('Fn record', decodeRecord([0xf0, 0xff, 0x01]), { kind: 'action', code: 0xff, arg: 1 })
  eq('empty slot', decodeRecord([0xff, 0xff, 0xff]), { kind: 'none', raw: 0xff })
  eq('driver "unassigned"', decodeRecord([0x10, 0x00, 0x00]), { kind: 'none', raw: 0x10 })
  eq('wheel down is signed', decodeRecord([0x21, 0x00, 0xff]), { kind: 'mouseWheel', delta: -1 })
  eq('consumer usage is little-endian', decodeRecord([0x30, 0x83, 0x01]), {
    kind: 'consumer',
    usage: 0x183,
  })
}

// --- reading a layer ---
{
  const board = new FakeBoard()
  const entries = await readKeymapLayer(fakeLink(board), 0)
  eq('one entry per key', entries.length, RAVEN61_KEYS.length)
  eq('A is bound to its own usage', entries[A.index]!.binding, {
    kind: 'key',
    usage: A.code,
    modifiers: 0,
  })
  eq('A came from its slot', entries[A.index]!.slot, slotFor(A.index))
  const fn = RAVEN61_KEYS.find((k) => k.label === 'Fn')!
  eq('Fn is a momentary layer key', entries[fn.index]!.binding, {
    kind: 'action',
    code: 0xff,
    arg: 1,
  })

  const layer1 = await readKeymapLayer(fakeLink(board), 1)
  eq('layer 1 A is unbound', layer1[A.index]!.binding, { kind: 'none', raw: 0x10 })
  // Reading layer 1 must ask for the second half of the block, or it would
  // return layer 0 twice and look perfectly plausible doing it.
  const reads = board.sent.filter((s) => s.command === 0x08).slice(-10)
  eq(
    'layer 1 read offsets',
    reads.map((r) => r.offset),
    Array.from({ length: 10 }, (_, i) => 512 + i * 56),
  )
}

// --- writing one key ---
{
  const board = new FakeBoard()
  const before = board.live.slice()
  const entries = nulls()
  entries[CAPS.index] = { binding: { kind: 'key', usage: 0xe0, modifiers: 0 } }

  const r = await writeKeymapLayer(fakeLink(board), 0, entries)

  eq('one slot changed', r.slots, [slotFor(CAPS.index)])
  eq('key reported with its slot', r.keys, [
    { index: CAPS.index, label: 'Caps', slot: slotFor(CAPS.index) },
  ])
  eq('nothing unmapped', r.unmapped, [])
  eq('verified', r.mismatched, [])
  eq('Caps now sends LCtrl', record(board.live, 0, slotFor(CAPS.index)), [0x10, 0x00, 0xe0])
  eq('A untouched', record(board.live, 0, slotFor(A.index)), [0x10, 0x00, A.code])
  eq(
    'layer 1 untouched',
    Array.from(board.live.subarray(KEYMAP_BLOCK.layerBytes)),
    Array.from(before.subarray(KEYMAP_BLOCK.layerBytes)),
  )

  // The packet sequence the stock driver's job 7 uses.
  const writes = board.sent.filter((s) => s.command === 0x09)
  eq('10 write chunks', writes.length, 10)
  eq(
    'write offsets',
    writes.map((w) => w.offset),
    Array.from({ length: 10 }, (_, i) => i * 56),
  )
  eq(
    'write lengths',
    writes.map((w) => w.length),
    [...Array(9).fill(56), 8],
  )
  const order = board.sent.map((s) => s.command)
  ok('the write is bracketed', order.includes(0x01) && order[order.length - 1] === 0x02)
}

// --- writing into layer 1 goes to the second half of the block ---
{
  const board = new FakeBoard()
  const entries = nulls()
  entries[A.index] = { binding: { kind: 'consumer', usage: 0x0e9 } }

  await writeKeymapLayer(fakeLink(board), 1, entries)

  eq('layer 1 A is now Vol+', record(board.live, 1, slotFor(A.index)), [0x30, 0xe9, 0x00])
  eq('layer 0 A untouched', record(board.live, 0, slotFor(A.index)), [0x10, 0x00, A.code])
  const writes = board.sent.filter((s) => s.command === 0x09)
  eq(
    'offsets are layer-based',
    writes.map((w) => w.offset),
    Array.from({ length: 10 }, (_, i) => 512 + i * 56),
  )
}

// --- a write the board ignores is reported, not assumed ---
{
  const board = new FakeBoard()
  board.ignoreWrites = true
  const entries = nulls()
  entries[A.index] = { binding: { kind: 'key', usage: 0x05, modifiers: 0 } }

  const r = await writeKeymapLayer(fakeLink(board), 0, entries)

  eq('the ignored slot is reported', r.mismatched.length, 1)
  eq('with both records', r.mismatched[0]!.wanted, '10 00 05')
  eq('and what the board kept', r.mismatched[0]!.got, `10 00 ${A.code.toString(16).padStart(2, '0')}`)
}

// --- an edit that matches the board sends nothing ---
{
  const board = new FakeBoard()
  const entries = nulls()
  entries[A.index] = { binding: { kind: 'key', usage: A.code, modifiers: 0 } }

  const r = await writeKeymapLayer(fakeLink(board), 0, entries)

  eq('no slots changed', r.slots, [])
  eq('and no write went out', board.sent.filter((s) => s.command === 0x09).length, 0)
}

// --- the two layer latches never reach flash ---
{
  const board = new FakeBoard()
  const entries = nulls()
  entries[A.index] = { binding: { kind: 'action', code: 0x05, arg: 0 } as KeyBinding }

  let threw = false
  try {
    await writeKeymapLayer(fakeLink(board), 0, entries)
  } catch {
    threw = true
  }
  ok('binding action 0x05 is refused', threw)
  eq('nothing was sent', board.sent.filter((s) => s.command === 0x09).length, 0)
}

// --- a guessed slot map is refused, not shown ---
{
  const board = new FakeBoard()
  // An empty factory table resolves no key, so readSlotMap falls back to the
  // layout-order guess. Reading the keymap against it would put every cap's
  // binding on some other key.
  board.defaults.fill(0)
  let threw = false
  try {
    await readKeymapLayer(fakeLink(board), 0)
  } catch {
    threw = true
  }
  ok('a guessed slot map stops the read', threw)
}

// --- a layer this board has no storage for is refused ---
{
  const board = new FakeBoard()
  let threw = false
  try {
    await readKeymapLayer(fakeLink(board), 2)
  } catch {
    threw = true
  }
  ok('layer 2 is refused', threw)
}

// The fake board's factory table must resolve every key, or the slot map falls
// back to the layout-order guess and the write path refuses outright — which
// would make every assertion above vacuous.
{
  const map = slotMapFromKeymap(new FakeBoard().defaults, layoutOf(raven61Spec.layout))
  eq('fake keymap resolves every key', map.slotByKey.size, RAVEN61_KEYS.length)
  eq('and places A where the test expects', map.slotByKey.get(A.index), slotFor(A.index))
}

console.log(`keymap-write: ${pass} passed, ${fails.length} failed`)
for (const f of fails) console.error(`  ✗ ${f}`)
if (fails.length > 0) process.exitCode = 1
