/**
 * Checks the advanced-key codec and write path against a fake board.
 * `npm run check`.
 *
 * This block is written entirely from the firmware — no capture, no driver
 * database, and no hardware confirmation yet — so the checks here are the only
 * thing standing between a refactor and a keyboard that types the wrong key at
 * the wrong depth. Three things are pinned.
 *
 * **The DKS stage mask.** Ten bits, and the encoder is not the authority on
 * them: the firmware is. `simulate()` below reimplements the handler's four
 * arms straight from the disassembly — a press bit per stage at 0, 3, 6, 9, and
 * a release at each boundary when the first bit of its pair is set and the
 * second is not, `(1,2)` at 0x8b3c, `(4,5)` at 0x8ba4, `(7,8)` at 0x8c0e — and
 * every span the encoder can produce is run through it. If a mask does not make
 * the firmware press and release where the span says, this fails.
 *
 * **The three tables are three commands.** A record's kind decides which table
 * it lives in, and sending it to the wrong one would be acknowledged, verified
 * against the wrong bytes, and silently wrong. So the write path is checked for
 * which command it sends and which table it touches.
 *
 * **Round trips.** A record this app did not author has to survive read →
 * decode → encode → write unchanged, including the bytes a kind does not use —
 * OKS's duration byte sits where MT keeps a type byte, and a codec that decoded
 * both as a pair of key records would rewrite one as the other.
 *
 * Run it after touching advancedKeys.ts or the advanced-key path in engine.ts.
 */
import { raven61Spec } from '../../src/device/boards/raven61/index'
import { RAVEN61_KEYS } from '../../src/device/boards/raven61/layout'
import type { HidLink } from '../../src/hid/link'
import {
  ADVANCED_BLOCK_OF,
  ADVANCED_KEY_BLOCKS,
  ADVANCED_KEY_COUNT,
  ADVANCED_KINDS,
  ADVANCED_TYPE,
  DKS_STAGES,
  decodeAdvancedRecord,
  decodeDksSpan,
  dksStepsToMm,
  emptyAdvancedRecord,
  encodeAdvancedRecord,
  encodeDksSpan,
  firstFreeRecord,
  kindOfType,
  mtBindings,
  oksBindings,
  pairUsages,
  withMtBindings,
  withOksBindings,
  withPairUsages,
  type AdvancedKeyBlobs,
  type AdvancedRecord,
  type DksRecord,
  type PairRecord,
} from '../../src/protocol/advancedKeys'
import { BLOCK, MAGIC, OFFSET, checksum } from '../../src/protocol/frame'
import { decodeRecord, RECORD_TYPE } from '../../src/protocol/keymap'
import { readAdvancedKeys, writeAdvancedKey } from '../../src/protocol/raven61'
import { KEYMAP } from '../../src/protocol/slotMap'

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

// --- the firmware's own reading of a stage mask -----------------------------

/** Press bit per stage, from the four arms of the handler at 0x8af2. */
const PRESS_BIT = [0, 3, 6, 9]
/** The bit pair each boundary tests: release when the first is set, second not. */
const BOUNDARY_PAIR: [number, number][] = [
  [1, 2],
  [4, 5],
  [7, 8],
]

/**
 * What the firmware would do with this mask, stage by stage.
 *
 * Deliberately written from the disassembly rather than from `DKS_DOWN_BITS`,
 * so the two are independent — a check that reused the encoder's own table
 * would agree with any table at all.
 */
function simulate(mask: number): { pressAt: number | null; releaseAt: number | null } {
  const bit = (n: number) => ((mask >> n) & 1) === 1
  let pressAt: number | null = null
  let releaseAt: number | null = null
  let down = false
  for (let stage = 0; stage < DKS_STAGES; stage++) {
    // The boundary check runs before this stage's own press, as the handler
    // orders it.
    if (stage > 0) {
      const pair = BOUNDARY_PAIR[stage - 1]!
      if (down && bit(pair[0]) && !bit(pair[1])) {
        down = false
        releaseAt = stage
      }
    }
    if (bit(PRESS_BIT[stage]!)) {
      pressAt = stage
      down = true
      // Stage 3's arm presses and releases in the same pass; the earlier ones
      // release straight away unless their hold bit says otherwise.
      if (stage === DKS_STAGES - 1) {
        down = false
        releaseAt = stage
      } else if (!bit(PRESS_BIT[stage]! + 1)) {
        down = false
        releaseAt = stage
      }
    }
  }
  if (down) releaseAt = DKS_STAGES - 1
  return { pressAt, releaseAt }
}

{
  let agreed = 0
  const wrong: string[] = []
  for (let pressAt = 0; pressAt < DKS_STAGES; pressAt++) {
    for (let releaseAt = pressAt; releaseAt < DKS_STAGES; releaseAt++) {
      const mask = encodeDksSpan(pressAt, releaseAt)
      const seen = simulate(mask)
      const round = decodeDksSpan(mask)
      if (
        seen.pressAt === pressAt &&
        seen.releaseAt === releaseAt &&
        round.pressAt === pressAt &&
        round.releaseAt === releaseAt
      ) {
        agreed++
      } else {
        wrong.push(
          `${pressAt}->${releaseAt} mask 0x${mask.toString(16)}` +
            ` firmware ${seen.pressAt}/${seen.releaseAt}` +
            ` decode ${round.pressAt}/${round.releaseAt}`,
        )
      }
    }
  }
  ok('every DKS span reads back as the firmware would run it', wrong.length === 0, wrong.join('; '))
  eq('and there are ten of them', agreed + wrong.length, 10)
  // The plain key: down at the first point, up at the last. Spelled out so a
  // change to the bit table has to face a number rather than only a simulation.
  eq('press 0 release 3 is 0x0b7', encodeDksSpan(0, 3), 0xb7)
  eq('a tap at point 1 is bit 0 alone', encodeDksSpan(0, 0), 0x001)
  eq('a tap at point 4 is bit 9 alone', encodeDksSpan(3, 3), 0x200)
  // Out of order is clamped rather than encoded as a span running backwards.
  eq('a release before the press is a tap', encodeDksSpan(2, 1), encodeDksSpan(2, 2))
}

// --- geometry ---------------------------------------------------------------

{
  eq('the three tables hold the same number of records', ADVANCED_KEY_COUNT, 42)
  const dks = ADVANCED_KEY_BLOCKS.dks
  ok('DKS records fit its table', dks.recordSize * ADVANCED_KEY_COUNT <= dks.blobSize)
  // 42 x 24 = 1008, and the next table starts there. That adjacency is the
  // reason the three were read as unrelated blocks, so it is worth pinning.
  eq(
    'the pair table starts where the DKS table ends',
    dks.base + dks.recordSize * ADVANCED_KEY_COUNT,
    ADVANCED_KEY_BLOCKS.pair.base,
  )
  for (const block of ['pair', 'toggle'] as const) {
    const b = ADVANCED_KEY_BLOCKS[block]
    ok(`${block} records fit its table`, b.recordSize * ADVANCED_KEY_COUNT <= b.blobSize)
  }
  for (const kind of ADVANCED_KINDS) {
    eq(`${kind} round-trips through its type byte`, kindOfType(ADVANCED_TYPE[kind]), kind)
  }
  eq('the DKS threshold unit is a tenth of a millimetre', dksStepsToMm(10), 1)
}

// --- record round trips -----------------------------------------------------

function blobs(): AdvancedKeyBlobs {
  return {
    dks: new Uint8Array(ADVANCED_KEY_BLOCKS.dks.blobSize),
    pair: new Uint8Array(ADVANCED_KEY_BLOCKS.pair.blobSize),
    toggle: new Uint8Array(ADVANCED_KEY_BLOCKS.toggle.blobSize),
  }
}

{
  // Bytes no kind of this app authored — an OKS record with a duration where MT
  // keeps a type byte, and a modifier byte RS and SOCD never read.
  const b = blobs()
  const foreign = [0x10, 0x02, 0x1a, 0x37, 0x00, 0x1b]
  b.pair.set(foreign, 3 * ADVANCED_KEY_BLOCKS.pair.recordSize)
  const rec = decodeAdvancedRecord(b, 3, 'oks') as PairRecord
  eq('a pair record survives decode and encode', Array.from(encodeAdvancedRecord(rec)), foreign)
  const oks = oksBindings(rec)
  eq('OKS reads its own usage from byte 2', oks.own, 0x1a)
  eq('OKS reads its duration from byte 3', oks.holdTicks, 0x37)
  eq('OKS reads the release usage from byte 5', oks.onRelease, 0x1b)
  // The same six bytes, read as MT: two whole keymap records rather than three
  // loose fields. Both readings are legal, which is why the record is bytes.
  const asMt = mtBindings({ ...rec, kind: 'mt' })
  eq('MT reads the same bytes as two records', asMt.tap, decodeRecord(foreign, 0))
  eq('and the second one too', asMt.hold, decodeRecord(foreign, 3))

  const edited = withOksBindings(rec, 0x04, 0x05, 0x14)
  eq(
    'editing OKS leaves the bytes it does not own',
    Array.from(encodeAdvancedRecord(edited)),
    [0x10, 0x02, 0x04, 0x14, 0x00, 0x05],
  )
  const paired = withPairUsages({ ...rec, kind: 'rs' }, 0x1a, 0x1b)
  eq('RS writes both halves as key records', pairUsages(paired), { own: 0x1a, partner: 0x1b })
  const mt = withMtBindings(
    { ...rec, kind: 'mt' },
    { kind: 'key', usage: 0x04, modifiers: 0 },
    { kind: 'key', usage: 0, modifiers: 0x01 },
  )
  eq(
    'MT writes two whole records',
    Array.from(encodeAdvancedRecord(mt)),
    [RECORD_TYPE.key, 0, 0x04, RECORD_TYPE.key, 0x01, 0],
  )
}

{
  const rec = emptyAdvancedRecord('dks') as DksRecord
  rec.thresholds = [12, 20, 16, 6]
  rec.spans[0] = {
    binding: { kind: 'key', usage: 0x04, modifiers: 0 },
    pressAt: 0,
    releaseAt: 3,
    mask: encodeDksSpan(0, 3),
  }
  rec.spans[1] = {
    binding: { kind: 'key', usage: 0x05, modifiers: 0 },
    pressAt: 1,
    releaseAt: 1,
    mask: encodeDksSpan(1, 1),
  }
  const b = blobs()
  b.dks.set(encodeAdvancedRecord(rec), 7 * ADVANCED_KEY_BLOCKS.dks.recordSize)
  const back = decodeAdvancedRecord(b, 7, 'dks') as DksRecord
  eq('DKS thresholds survive', back.thresholds, [12, 20, 16, 6])
  eq('the held binding survives', back.spans[0]!.binding, rec.spans[0]!.binding)
  eq('and its span', [back.spans[0]!.pressAt, back.spans[0]!.releaseAt], [0, 3])
  eq('the tap survives', [back.spans[1]!.pressAt, back.spans[1]!.releaseAt], [1, 1])
  // An unbound binding must not leave a stage that fires it.
  eq('an unbound binding has a zero mask', back.spans[2]!.mask, 0)
  eq('a record with bytes in it is not free', firstFreeRecord(b), 0)
}

// --- the write path ---------------------------------------------------------

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

class FakeBoard {
  keymap = new Uint8Array(KEYMAP.blobSize)
  live = new Uint8Array(raven61Spec.keymap.layerBytes * raven61Spec.keymap.layers)
  advanced = blobs()
  sent: { command: number; offset: number; length: number }[] = []

  constructor() {
    for (const key of RAVEN61_KEYS) {
      const at = slotFor(key.index) * KEYMAP.entrySize
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
    }
    this.live.set(this.keymap.subarray(0, raven61Spec.keymap.layerBytes))
  }

  private table(command: number): Uint8Array | null {
    if (command === 0xa2 || command === 0xa3) return this.advanced.dks
    if (command === 0xa4 || command === 0xa5) return this.advanced.pair
    if (command === 0xa6 || command === 0xa7) return this.advanced.toggle
    return null
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

    const table = this.table(command)
    const readable = command === 0x07 ? this.keymap : command === 0x08 ? this.live : table
    const READS = [0x07, 0x08, 0xa2, 0xa4, 0xa6]
    if (READS.includes(command)) {
      reply.fill(0, BLOCK.data)
      reply.set(readable!.subarray(offset, offset + length), BLOCK.data)
      return reply
    }
    if (command === 0x09) {
      this.live.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
      return reply
    }
    if (table) {
      table.set(payload.subarray(BLOCK.data, BLOCK.data + length), offset)
      return reply
    }
    return null
  }
}

function fakeLink(board: FakeBoard): HidLink {
  return {
    device: null,
    async request(payload: Uint8Array) {
      const reply = board.handle(payload)
      if (!reply) {
        throw new Error(`fake board has no command 0x${payload[OFFSET.command]!.toString(16)}`)
      }
      return { data: reply }
    },
    async send() {},
    on: () => () => {},
    log: { note: () => {} },
  } as unknown as HidLink
}

{
  const board = new FakeBoard()
  const rec = emptyAdvancedRecord('tgl')
  const result = await writeAdvancedKey(fakeLink(board), 5, rec as AdvancedRecord)
  eq('a toggle goes to the toggle table', result.block, ADVANCED_BLOCK_OF.tgl)
  // Empty is empty: nothing to send, and the codec says so rather than
  // acknowledging a write it did not make.
  eq('an unchanged record is not sent', result.sent, false)
  eq('and no 0xa7 went out', board.sent.filter((s) => s.command === 0xa7).length, 0)
}

{
  const board = new FakeBoard()
  const rec: AdvancedRecord = {
    kind: 'tgl',
    binding: { kind: 'key', usage: 0x39, modifiers: 0 },
  }
  const result = await writeAdvancedKey(fakeLink(board), 5, rec)
  eq('the write is verified', result.mismatch, null)
  eq('it was sent', result.sent, true)
  // Only the toggle table's write goes out. The reads that bracket it are all
  // three, because a snapshot is all three — it is the *write* that must not
  // spill into a table the record does not live in.
  const writes = board.sent.filter((s) => [0xa3, 0xa5, 0xa7].includes(s.command))
  eq('over 0xa7 and nothing else', [...new Set(writes.map((s) => s.command))], [0xa7])
  eq(
    'and it landed on record 5 of the toggle table',
    Array.from(board.advanced.toggle.subarray(15, 18)),
    [RECORD_TYPE.key, 0, 0x39],
  )
  eq('the other tables are untouched', board.advanced.dks.every((b) => b === 0), true)
}

{
  const board = new FakeBoard()
  const rec = emptyAdvancedRecord('dks') as DksRecord
  rec.thresholds = [10, 20, 15, 5]
  rec.spans[0] = {
    binding: { kind: 'key', usage: 0x04, modifiers: 0 },
    pressAt: 0,
    releaseAt: 3,
    mask: 0,
  }
  const result = await writeAdvancedKey(fakeLink(board), 0, rec)
  eq('a DKS record goes over 0xa3', result.block, 'dks')
  eq('verified', result.mismatch, null)
  eq(
    'the mask is rebuilt from the span, not copied from the draft',
    Array.from(board.advanced.dks.subarray(4, 9)),
    [RECORD_TYPE.key, 0, 0x04, 0xb7, 0x00],
  )
}

{
  // A key bound to a record, and the sweep that has to find it. The read is
  // what turns 42 rows of bytes into "this cap runs that record".
  const board = new FakeBoard()
  const q = RAVEN61_KEYS.find((k) => k.label === 'Q')!
  const slot = slotFor(q.index)
  board.live[slot * KEYMAP.entrySize] = ADVANCED_TYPE.mt
  board.live[slot * KEYMAP.entrySize + 1] = 9
  board.live[slot * KEYMAP.entrySize + 2] = 20
  board.advanced.pair.set([RECORD_TYPE.key, 0, 0x04, RECORD_TYPE.key, 0x01, 0], 9 * 6)

  const snap = await readAdvancedKeys(fakeLink(board))
  eq('the sweep finds one use', snap.uses.length, 1)
  const use = snap.uses[0]!
  eq('on the right key', use.label, 'Q')
  eq('with the right kind', use.kind, 'mt')
  eq('and record', use.record, 9)
  eq('and the hold time from the keymap', use.param, 20)
  eq('nothing is orphaned', snap.orphans, [])

  const decoded = decodeAdvancedRecord(snap.blobs, use.record, use.kind) as PairRecord
  eq('the record decodes as a mod tap', mtBindings(decoded).tap, {
    kind: 'key',
    usage: 0x04,
    modifiers: 0,
  })
}

{
  // Bytes in a record no layer points at. Reported, not cleaned up.
  const board = new FakeBoard()
  board.advanced.toggle.set([RECORD_TYPE.key, 0, 0x39], 11 * 3)
  const snap = await readAdvancedKeys(fakeLink(board))
  eq('an unreferenced record is reported', snap.orphans, [11])
  eq('and nothing is bound', snap.uses, [])
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
