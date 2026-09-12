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
import { KEYBOARD_ROWS, KEYCODES, keycodeLabel } from '../../src/keyboard/keycodes'
import {
  BINDING_GROUPS,
  EXTRA_KEYS,
  groupChoices,
  KEYMAP_BLOCK,
  SHIFTED_KEYS,
  bindingLabel,
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

/** `[lo, hi]` inclusive, for spelling a run of usages out once. */
const seq = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

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
    for (const choice of groupChoices(group)) {
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

// --- the picker covers every plain key the stock driver can produce ---
{
  /*
   * The stock remap tab has no list of ordinary keys: it captures a keypress
   * and converts it, so what it can produce is its VK-to-usage table at
   * 0x45d240 rather than any of the six catalog lists. That is the set below,
   * and it is the one this app's picker has to cover — the numeric keypad went
   * missing from it once, because a 61-key layout has no cap to suggest it and
   * no catalog list to name it. See docs/protocol.md §7.3.
   *
   * `0xf8`, the last item of the driver's "Special" list, is deliberately not
   * here: it is not a HID usage. See EXTRA_KEYS.
   */
  const fromDriver: number[] = [
    ...seq(0x04, 0x27), // A-Z, 1-0
    ...seq(0x28, 0x39), // Enter .. Caps
    ...seq(0x3a, 0x45), // F1-F12
    ...seq(0x46, 0x52), // editing and arrows
    ...seq(0x53, 0x63), // the numeric keypad
    0x64, // NUBS
    0x65, // App
    ...seq(0x68, 0x73), // F13-F24
    ...seq(0xe0, 0xe7), // modifiers
  ]
  /*
   * What the *picker* offers, not what the name table knows. The two came apart
   * once already — the numeric keypad was nameable and unpickable — and the
   * name table is the wrong side of that to measure.
   */
  const offered = new Set<number>()
  for (const row of KEYBOARD_ROWS) {
    for (const slot of row) if (!('gap' in slot)) offered.add(slot.code)
  }
  for (const group of BINDING_GROUPS) {
    for (const choice of groupChoices(group)) {
      // Modifiers make it a different record: `!` is Shift+1, not usage 0x1e.
      if (choice.binding.kind === 'key' && choice.binding.modifiers === 0) {
        offered.add(choice.binding.usage)
      }
    }
  }
  const missing = fromDriver.filter((u) => !offered.has(u))
  ok(
    'picker offers every usage the stock driver can produce',
    missing.length === 0,
    missing.map((u) => '0x' + u.toString(16)).join(' '),
  )
  // A usage with no name shows as its own hex, which is honest but useless on a
  // cap — an entry added without a legend fails here. It is `bindingLabel` and
  // not `keycodeLabel` because the catalog names some of these (F13-F24 and the
  // international keys live in EXTRA_KEYS, not in the keycode table).
  const unnamed = fromDriver.filter((u) =>
    /^0x[0-9a-f]{2}$/.test(bindingLabel({ kind: 'key', usage: u, modifiers: 0 }, keycodeLabel)),
  )
  ok('and names all of them', unnamed.length === 0, unnamed.map((u) => u.toString(16)).join(' '))
}

// --- a macro key is a slot and the stock repeat byte ---
{
  /*
   * The remap tab's macro category is the one list whose entries are not in a
   * catalog — they are slots of the store — so the record it builds is pinned
   * here instead. `70 <slot> 01`: the repeat byte is 1 because that is what the
   * stock encoder writes and the firmware never reads it back (see
   * protocol/macros.ts), and a slot has to survive the round trip or a key
   * would start the wrong body.
   */
  for (const slot of [0, 1, 9, 31]) {
    const binding: KeyBinding = { kind: 'macro', slot, repeat: 1 }
    eq(`macro #${slot} encodes`, encodeRecord(binding), [0x70, slot, 1])
    ok(`macro #${slot} round trips`, sameBinding(decodeRecord(encodeRecord(binding)), binding))
  }
  // The store holds 32 and the player rejects 32 and up (0x9500), so a slot
  // byte that has wrapped is a different macro rather than an error.
  eq('and the slot is one byte', encodeRecord({ kind: 'macro', slot: 0x100, repeat: 1 }), [
    0x70, 0, 1,
  ])
}

// --- the picker's keyboard is a keyboard ---
{
  /*
   * Every row is the same width or the rows do not line up, and a row that is
   * short by a quarter unit is the kind of thing that looks like a rendering
   * bug rather than a table typo. 22.5u is a full-size ANSI board: 15u of main
   * block, 3u of navigation and 4u of keypad, with a quarter between.
   */
  for (const [i, row] of KEYBOARD_ROWS.entries()) {
    const width = row.reduce((sum, slot) => sum + ('gap' in slot ? slot.gap : (slot.u ?? 1)), 0)
    eq(`row ${i} is 22.5u wide`, width, 22.5)
  }
  // A key drawn twice is a key whose two caps disagree about being selected.
  const codes = KEYBOARD_ROWS.flat()
    .filter((slot): slot is Extract<typeof slot, { code: number }> => !('gap' in slot))
    .map((slot) => slot.code)
  eq('and draws each key once', codes.length, new Set(codes).size)
  eq('and is a 104-key board', codes.length, 104)
  // Every cap has something written on it, whether its own name or a short one.
  const blank = KEYBOARD_ROWS.flat().filter(
    (slot) => !('gap' in slot) && (slot.cap ?? keycodeLabel(slot.code)) === '',
  )
  ok('and every cap has a legend', blank.length === 0)
}

// --- KC_NO is the driver's "unassigned", not the factory's empty marker ---
{
  /*
   * The two are not interchangeable. `0xff` is what the factory keymap leaves in
   * a slot, and the boot check at 0xa7ae reads slot 0's type byte to decide
   * whether the live keymap is worth keeping — writing the factory marker back
   * as an edit is how a keymap gets rewritten from the factory tables under
   * someone. `10 00 00` is a key record with no usage, which is what the stock
   * encoder emits for macro_type 1.
   */
  const kcNo = EXTRA_KEYS.find((c) => c.label === 'KC_NO')
  ok('KC_NO is in the Special list', kcNo !== undefined)
  eq('and writes the driver "unassigned" record', encodeRecord(kcNo!.binding), [0x10, 0, 0])
  ok(
    'and reads back as the same binding',
    sameBinding(decodeRecord([0x10, 0, 0]), kcNo!.binding),
  )
  /*
   * The name has to survive the round trip, or the setting is invisible: the
   * board answers with the three bytes, and if those decode to something the
   * label renders as a bare dash then a key that was deliberately switched off
   * looks exactly like a slot nobody ever wrote.
   */
  eq('and is named on the way back', bindingLabel(decodeRecord([0x10, 0, 0]), keycodeLabel), 'KC_NO')
  eq('and the same before it is written', bindingLabel(kcNo!.binding, keycodeLabel), 'KC_NO')
  // The factory's own empty marker is the case with no name to give.
  eq('factory empty stays a dash', bindingLabel(decodeRecord([0xff, 0xff, 0xff]), keycodeLabel), '—')
  eq('and so does a zeroed slot', bindingLabel(decodeRecord([0, 0, 0]), keycodeLabel), '—')
  /*
   * And the two are not the same binding. They encode alike — this app never
   * writes 0xff back — so a bytes-only comparison called them equal, and the
   * remap tab dropped `KC_NO` on a factory-empty slot as an edit back to what
   * the board already held. Most of the Fn layer is factory-empty.
   */
  ok(
    'KC_NO differs from the factory empty marker',
    !sameBinding(kcNo!.binding, decodeRecord([0xff, 0xff, 0xff])),
  )
  ok(
    'and from a zeroed slot',
    !sameBinding(kcNo!.binding, decodeRecord([0, 0, 0])),
  )
}

// --- the shifted symbols are the Shift bit and an ordinary usage ---
{
  /*
   * "!" is not a HID usage and never was. Each of these has to come out as a
   * plain key record carrying the Shift bit and the *unshifted* key's usage, or
   * the board would send a keycode nothing types. The unshifted key also has to
   * be one the picker already offers, since that is where the usage comes from.
   */
  const offered = new Set<number>()
  for (const def of KEYCODES) offered.add(def.code)
  for (const choice of SHIFTED_KEYS) {
    const [type, mods, usage] = encodeRecord(choice.binding)
    ok(
      `${choice.label} is Shift + a plain key`,
      type === 0x10 && mods === 0x02 && offered.has(usage!),
      [type, mods, usage].map((b) => b!.toString(16)).join(' '),
    )
  }
  eq('and the label follows the record', bindingLabel(SHIFTED_KEYS[1]!.binding, keycodeLabel), '!')
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
