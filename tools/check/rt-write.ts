/**
 * Checks the rapid-trigger write and the global settings patch. `npm run check`.
 *
 * Rapid trigger is two UI controls over two wire fields plus a mode byte —
 * `key_mode` folds "enabled" and "continuous" into one value — so the
 * interesting failures are collapses: a state the UI can show that the encoder
 * turns into a different one.
 *
 * The other half is saturation. Both sensitivity fields are 9 bits and both
 * dead zones are 5, and the first version of the encoder *masked* instead of
 * clamping: a 1.00 mm dead zone is 50 counts, `50 & 0x1f` is 18, and the board
 * would have quietly got 0.36 mm.
 */
import type { HidLink } from '../../src/hid/link'
import { BLOCK, MAGIC, OFFSET, PAYLOAD_LENGTH, checksum } from '../../src/protocol/frame'
import {
  KEY_MODE_WIRE,
  KEY_PERF_LIMITS,
  decodeKeyPerfRecord,
  encodeKeyPerfRecord,
  fromKeyConfig,
  recordHex,
  toKeyConfig,
} from '../../src/protocol/keyPerf'
import {
  GLOBAL,
  GLOBAL_FLAGS,
  decodeGlobalSettings,
  globalWriteRequest,
  patchGlobalFlags,
  patchGlobalRate,
} from '../../src/protocol/global'
import { writeGlobalSettings } from '../../src/protocol/raven61'
import { countsToMm, mmToCounts } from '../../src/protocol/encoding'
import type { KeyConfig } from '../../src/protocol/types'

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

/** A key as the board reports it: switch 5, RT on, 2.60 mm, 0.52 / 0.62 mm. */
const BOARD = Uint8Array.from([0xa5, 0x01, 0x81, 0x00, 0x19, 0x00, 0x1e, 0x00])
const boardRec = decodeKeyPerfRecord(BOARD, 0)
const boardCfg = toKeyConfig(boardRec)
const wire = (c: KeyConfig) => recordHex(encodeKeyPerfRecord(fromKeyConfig(c, boardRec)), 0)

// --- key_mode: three UI states, one byte ---
{
  eq('board decodes as RT on, not continuous', [boardCfg.rapidTrigger.enabled, boardCfg.rapidTrigger.continuous], [true, false])
  eq('rt off -> key_mode 0', wire({ ...boardCfg, rapidTrigger: { ...boardCfg.rapidTrigger, enabled: false } }).slice(3, 5), '00')
  eq('rt on -> key_mode 1', wire(boardCfg).slice(3, 5), '01')
  eq(
    'rt on + continuous -> key_mode 2',
    wire({ ...boardCfg, rapidTrigger: { ...boardCfg.rapidTrigger, continuous: true } }).slice(3, 5),
    '02',
  )
  // continuous with rapid trigger off is not a state the board has: key_mode 0
  // means off, and 2 already implies on.
  eq(
    'continuous alone cannot turn rt on',
    wire({
      ...boardCfg,
      rapidTrigger: { ...boardCfg.rapidTrigger, enabled: false, continuous: true },
    }).slice(3, 5),
    '00',
  )
  eq('KEY_MODE_WIRE matches', [KEY_MODE_WIRE.off, KEY_MODE_WIRE.rapidTrigger, KEY_MODE_WIRE.fullStroke], [0, 1, 2])
}

// --- the two sensitivities are two fields, and stay two ---
{
  // There used to be a "separate" checkbox here, inferred from the two values
  // being equal, and with it off the encoder sent press to both fields. Both
  // are gone: what the panel shows is what goes out, so the check is that
  // neither value can be overwritten by the other on the way to the wire.
  eq('both values reach the wire', wire(boardCfg), 'a5 01 81 00 19 00 1e 00')
  const equal = {
    ...boardCfg,
    rapidTrigger: { ...boardCfg.rapidTrigger, releaseMm: boardCfg.rapidTrigger.pressMm },
  }
  eq('equal values stay equal', wire(equal), 'a5 01 81 00 19 00 19 00')
  const back = toKeyConfig(
    decodeKeyPerfRecord(encodeKeyPerfRecord(fromKeyConfig(boardCfg, boardRec)), 0),
  ).rapidTrigger
  eq(
    'and the round trip keeps them apart',
    [back.pressMm, back.releaseMm],
    [boardCfg.rapidTrigger.pressMm, boardCfg.rapidTrigger.releaseMm],
  )
}

// --- the never-set marker, and the hair trigger it decodes to ---
{
  const unset = Uint8Array.from([0x03, 0x00, 0x81, 0x00, 0xff, 0xff, 0xff, 0xff])
  const rec = decodeKeyPerfRecord(unset, 0)
  const cfg = toKeyConfig(rec)
  eq('unset sensitivities decode to zero', [cfg.rapidTrigger.pressMm, cfg.rapidTrigger.releaseMm], [0, 0])
  // This is the trap the UI has to avoid: enabling rapid trigger without
  // seeding a value writes the smallest the field can hold, 0.02 mm.
  const naive = { ...cfg, rapidTrigger: { ...cfg.rapidTrigger, enabled: true }, rtUnset: false }
  eq('the model carries the zero through', fromKeyConfig(naive, rec).rtPressCounts, 0)
  // The encoder is where the clamp lives, so what reaches the board is 1 count
  // — 0.02 mm, a hair trigger made of sensor noise.
  eq(
    'and the encoder turns it into a 1-count hair trigger',
    decodeKeyPerfRecord(encodeKeyPerfRecord(fromKeyConfig(naive, rec)), 0).rtPressCounts,
    KEY_PERF_LIMITS.rtMin,
  )
  eq('which is 0.02 mm', countsToMm(KEY_PERF_LIMITS.rtMin), 0.02)
  // What the panel does instead: seed the factory default.
  const seeded = { ...cfg, rapidTrigger: { ...cfg.rapidTrigger, enabled: true, pressMm: 0.1, releaseMm: 0.1 }, rtUnset: false }
  eq('seeded gives 5 counts', fromKeyConfig(seeded, rec).rtPressCounts, 5)
  eq('seeded on the wire', recordHex(encodeKeyPerfRecord(fromKeyConfig(seeded, rec)), 0), '03 01 81 00 04 00 04 00')
  eq('marker not put back once values exist', fromKeyConfig(seeded, rec).rtUnset, false)
}

// --- saturation, not wrapping ---
{
  const dzMaxMm = countsToMm(KEY_PERF_LIMITS.deadZoneMax)
  eq('dead zone field is 5 bits', [KEY_PERF_LIMITS.deadZoneMax, dzMaxMm], [31, 0.62])
  const over = {
    ...boardCfg,
    deadZone: { enabled: true, topMm: 1.0, bottomMm: 1.0 },
  }
  const rec = fromKeyConfig(over, boardRec)
  eq('1.00 mm is 50 counts', mmToCounts(1.0), 50)
  const bytes = encodeKeyPerfRecord(rec)
  const back = decodeKeyPerfRecord(bytes, 0)
  eq('saturates at 31, does not wrap to 18', [back.pressDeadzoneCounts, back.releaseDeadzoneCounts], [31, 31])
  ok('and 18 is what masking would have given', (50 & 0x1f) === 18)

  const wide = { ...boardRec, rtPressCounts: 9999, rtReleaseCounts: 9999 }
  eq('sensitivity saturates at 512', decodeKeyPerfRecord(encodeKeyPerfRecord(wide), 0).rtPressCounts, KEY_PERF_LIMITS.rtMax)
  const tiny = { ...boardRec, rtPressCounts: 0, rtReleaseCounts: -5 }
  eq('and clamps up to 1', decodeKeyPerfRecord(encodeKeyPerfRecord(tiny), 0).rtPressCounts, KEY_PERF_LIMITS.rtMin)
  const deep = { ...boardRec, actuationCounts: 9999 }
  eq('actuation saturates at 512', decodeKeyPerfRecord(encodeKeyPerfRecord(deep), 0).actuationCounts, KEY_PERF_LIMITS.actuationMax)
}

// --- dead zone state is derived, so turning it off must clear the fields ---
{
  const on = { ...boardCfg, deadZone: { enabled: true, topMm: 0.2, bottomMm: 0.3 } }
  const onBytes = encodeKeyPerfRecord(fromKeyConfig(on, boardRec))
  eq('dead zones land in bits 1-5', [decodeKeyPerfRecord(onBytes, 0).pressDeadzoneCounts, decodeKeyPerfRecord(onBytes, 0).releaseDeadzoneCounts], [10, 15])
  eq('sensitivities survive alongside them', decodeKeyPerfRecord(onBytes, 0).rtPressCounts, 26)
  const off = { ...boardCfg, deadZone: { enabled: false, topMm: 0.2, bottomMm: 0.3 } }
  const offBytes = encodeKeyPerfRecord(fromKeyConfig(off, boardRec))
  eq('disabled writes no dead-zone bits', [decodeKeyPerfRecord(offBytes, 0).pressDeadzoneCounts, decodeKeyPerfRecord(offBytes, 0).releaseDeadzoneCounts], [0, 0])
  eq('and deadzoneState follows', decodeKeyPerfRecord(offBytes, 0).deadzoneState, false)
}

// ============ the global block ============

/** payload[15] with bottom-out off, actuation_check on, debounce 1. */
const FLAGS = GLOBAL_FLAGS.actuationCheck | (1 << GLOBAL_FLAGS.debounceShift)

// --- patchGlobalFlags touches only what it names ---
{
  eq('bottom-out on', patchGlobalFlags(FLAGS, { bottomOutTrigger: true }), FLAGS | GLOBAL_FLAGS.bottomOutTrigger)
  eq('bottom-out off is a no-op here', patchGlobalFlags(FLAGS, { bottomOutTrigger: false }), FLAGS)
  eq(
    'and off clears it when set',
    patchGlobalFlags(FLAGS | GLOBAL_FLAGS.bottomOutTrigger, { bottomOutTrigger: false }),
    FLAGS,
  )
  eq('empty patch changes nothing', patchGlobalFlags(FLAGS, {}), FLAGS)
  eq('debounce replaces its two bits', patchGlobalFlags(FLAGS, { debounceLevel: 3 }), FLAGS | (3 << 5))
  eq('debounce 0 clears them', patchGlobalFlags(FLAGS, { debounceLevel: 0 }), GLOBAL_FLAGS.actuationCheck)
  ok(
    'other bits are never disturbed',
    [0x00, 0x0f, 0xff, 0x6d].every((f) => {
      const keep = ~(GLOBAL_FLAGS.bottomOutTrigger) & 0xff
      return (patchGlobalFlags(f, { bottomOutTrigger: true }) & keep) === (f & keep)
    }),
  )
}

// --- the request is the reply, edited ---
{
  const reply = new Uint8Array(PAYLOAD_LENGTH)
  reply[0] = 0xaa
  reply[1] = 0x05
  reply[BLOCK.length] = GLOBAL.length
  reply[GLOBAL.rate] = 0x21
  reply[GLOBAL.deadZone] = 7
  reply[GLOBAL.gameLock] = 0x03
  reply[GLOBAL.flags] = FLAGS
  reply[GLOBAL.lightMode] = 0xff
  const req = globalWriteRequest(reply, { bottomOutTrigger: true })
  eq('magic and command replaced', [req[OFFSET.magic], req[OFFSET.command]], [MAGIC, 0x06])
  eq('checksum recomputed', req[OFFSET.checksum], checksum(req))
  eq('flag set', req[GLOBAL.flags], FLAGS | GLOBAL_FLAGS.bottomOutTrigger)
  // The whole point: the fields belonging to other screens come back untouched
  // — including the lighting effect, which shares this block.
  eq(
    'other fields preserved',
    [req[GLOBAL.rate], req[GLOBAL.deadZone], req[GLOBAL.gameLock], req[GLOBAL.lightMode]],
    [0x21, 7, 0x03, 0xff],
  )
  eq('length field preserved', req[BLOCK.length], GLOBAL.length)
}

// --- end to end against a fake board ---
class FakeGlobal {
  block = new Uint8Array(PAYLOAD_LENGTH)
  sent: number[] = []
  ignoreWrites = false

  constructor(flags = FLAGS) {
    this.block[BLOCK.length] = GLOBAL.length
    this.block[GLOBAL.rate] = 0x21
    this.block[GLOBAL.deadZone] = 7
    this.block[GLOBAL.gameLock] = 0x03
    this.block[GLOBAL.flags] = flags
    this.block[GLOBAL.lightMode] = 0xff
  }

  handle(payload: Uint8Array): Uint8Array {
    if (payload[OFFSET.checksum] !== checksum(payload)) throw new Error('bad checksum')
    const command = payload[OFFSET.command]!
    this.sent.push(command)
    const reply = new Uint8Array(PAYLOAD_LENGTH)
    if (command === 0x05) {
      reply.set(this.block)
      reply[0] = 0xaa
      reply[1] = 0x05
      return reply
    }
    if (command === 0x06 && !this.ignoreWrites) {
      // A firmware takes the data area; the header is the transport's.
      this.block.set(payload.subarray(OFFSET.data), OFFSET.data)
    }
    const echo = payload.slice()
    echo[0] = 0xaa
    return echo
  }
}

function fakeLink(board: FakeGlobal): HidLink {
  return {
    log: { note: () => {} },
    async request(data: Uint8Array) {
      return { reportId: 0, data: board.handle(data) }
    },
  } as unknown as HidLink
}

{
  const board = new FakeGlobal()
  const r = await writeGlobalSettings(fakeLink(board), { bottomOutTrigger: true })
  eq('before had it off', r.before.bottomOutTrigger, false)
  eq('after has it on', r.after.bottomOutTrigger, true)
  eq('verified', r.mismatched, [])
  eq('something was sent', r.unchanged, false)
  // 0x01, 0x05 read, 0x06 write, 0x05 verify, 0x02 — the stock driver's order.
  eq('command order', board.sent, [0x01, 0x05, 0x06, 0x05, 0x02])
  eq(
    'nothing else moved',
    [board.block[GLOBAL.rate], board.block[GLOBAL.deadZone], board.block[GLOBAL.gameLock], board.block[GLOBAL.lightMode]],
    [0x21, 7, 0x03, 0xff],
  )
  eq('and the read-back agrees', decodeGlobalSettings(board.block).deadZone, 7)
}

// --- patchGlobalRate leaves tick_rate alone ---
{
  // 0x21 is the byte the fake board reports: reporte_rate 1, tick_rate 2.
  eq('rate replaces its nibble', patchGlobalRate(0x21, { reportRate: 4 }), 0x24)
  eq('tick_rate survives', patchGlobalRate(0x21, { reportRate: 4 }) >> 4, 2)
  eq('empty patch changes nothing', patchGlobalRate(0x21, {}), 0x21)
  eq('a flags-only patch leaves it alone', patchGlobalRate(0x21, { debounceLevel: 3 }), 0x21)
  // The field is four bits. A caller passing more must not spill into tick_rate.
  eq('an oversized value is masked, not carried', patchGlobalRate(0x21, { reportRate: 0x1f }), 0x2f)
  const block = new Uint8Array(PAYLOAD_LENGTH)
  block[GLOBAL.rate] = patchGlobalRate(0x21, { reportRate: 4 })
  eq('decodes back to what was asked for', decodeGlobalSettings(block).reportRate, 4)
  eq('and tick_rate with it', decodeGlobalSettings(block).tickRate, 2)
}

{
  // A rate change writes payload[12] and nothing else.
  const board = new FakeGlobal()
  const r = await writeGlobalSettings(fakeLink(board), { reportRate: 4 })
  eq('rate went in', r.after.reportRate, 4)
  eq('tick_rate came through', r.after.tickRate, 2)
  eq('flags untouched', r.after.raw[GLOBAL.flags], FLAGS)
  eq('verified', r.mismatched, [])
}

{
  // Both fields at once — one read-modify-write, not two.
  const board = new FakeGlobal()
  const r = await writeGlobalSettings(fakeLink(board), { reportRate: 2, debounceLevel: 1 })
  eq('rate went in', r.after.reportRate, 2)
  eq('debounce went in', r.after.debounceLevel, 1)
  eq('one write only', board.sent, [0x01, 0x05, 0x06, 0x05, 0x02])
}

{
  // Already at that rate: no write at all.
  const board = new FakeGlobal()
  const r = await writeGlobalSettings(fakeLink(board), { reportRate: 1 })
  eq('reported as unchanged', r.unchanged, true)
  eq('no 0x06 sent', board.sent.includes(0x06), false)
}

{
  // A rate write the board acknowledges and ignores is caught the same way a
  // flags write is — the offset in the report is what tells them apart.
  const board = new FakeGlobal()
  board.ignoreWrites = true
  const r = await writeGlobalSettings(fakeLink(board), { reportRate: 4 })
  eq('ignored rate write is caught', r.mismatched.length, 1)
  eq('names payload[12]', r.mismatched[0], { offset: GLOBAL.rate, wanted: 0x24, got: 0x21 })
}

{
  // Already on: no write at all.
  const board = new FakeGlobal(FLAGS | GLOBAL_FLAGS.bottomOutTrigger)
  const r = await writeGlobalSettings(fakeLink(board), { bottomOutTrigger: true })
  eq('reported as unchanged', r.unchanged, true)
  eq('no 0x06 sent', board.sent.includes(0x06), false)
}

{
  // Acked and ignored.
  const board = new FakeGlobal()
  board.ignoreWrites = true
  const r = await writeGlobalSettings(fakeLink(board), { bottomOutTrigger: true })
  eq('ignored write is caught', r.mismatched.length, 1)
  eq('names the byte and both values', r.mismatched[0], {
    offset: GLOBAL.flags,
    wanted: FLAGS | GLOBAL_FLAGS.bottomOutTrigger,
    got: FLAGS,
  })
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
