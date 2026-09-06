/**
 * The device-spec layer: `defineDevice`, the JSON validator, and the codec the
 * engine builds from a spec.
 *
 * The point of these is the second board. Everything else in this directory
 * checks the Raven61's own bytes; this one checks that a *different* board —
 * different key table, different command numbers, a command it does not have
 * at all — comes out of the same engine addressing the right offsets, and that
 * a JSON file with a mistake in it is refused rather than half-loaded.
 *
 * Run with `npm run check`.
 */

import { defineDevice, mergeSpec, FAMILY_BASELINE } from '../../src/device/define'
import { forcedCodecFor, forcedSpecFor } from '../../src/device/forced'
import { DEFAULT_PROTOCOL, DEFAULT_PROTOCOL_ID } from '../../src/device/protocols/default'
import { RAVEN61_PROTOCOL } from '../../src/device/boards/raven61/protocol'
import { layoutOf } from '../../src/device/layout'
import { raven61Spec } from '../../src/device/boards/raven61/index'
import type { DeviceSpec, KeyDef } from '../../src/device/spec'
import { specById } from '../../src/device/registry'
import { validateSpec } from '../../src/device/validate'
import { RAVEN61_SWITCH_TYPES } from '../../src/device/boards/raven61/switches'
import { RAVEN61_LAYOUT } from '../../src/device/boards/raven61/layout'
import { supports } from '../../src/protocol/codec'
import { createCodec } from '../../src/protocol/engine'
import { BLOCK, OFFSET, checksum } from '../../src/protocol/frame'
import type { HidLink } from '../../src/hid/link'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, got: T, want: T): void {
  ok(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`)
}

/** A four-key board, enough to tell "uses the spec" from "uses the Raven61". */
const TINY_KEYS: KeyDef[] = [
  { index: 0, label: 'A', code: 0x04, x: 0, y: 0, w: 1, keyIndex: 0, lightIndex: 0 },
  { index: 1, label: 'B', code: 0x05, x: 1, y: 0, w: 1, keyIndex: 1, lightIndex: 1 },
  { index: 2, label: 'C', code: 0x06, x: 0, y: 1, w: 1, keyIndex: 2, lightIndex: 2 },
  { index: 3, label: 'D', code: 0x07, x: 1, y: 1, w: 1, keyIndex: 3, lightIndex: 3 },
]

const tinyLayout = { units: { width: 2, height: 2 }, travelMm: 3.5, keys: TINY_KEYS }

// ---------------------------------------------------------------- defineDevice

const sibling = defineDevice({
  id: 'tiny-v1',
  name: 'Tiny4',
  confidence: 'guess',
  basedOn: 'raven61-v1',
  usb: { vendorId: 0x1234, productIds: [0x5678] },
  layout: tinyLayout,
  commands: { readKeyPerf: 0xb0, writeKeyPerf: 0xb1, factoryReset: null },
  keyPerf: { slots: 8 },
  keymap: { slots: 8, layers: 1, layerBytes: 64, defaultsBlobSize: 64 },
  slotMap: { unusedSlots: [], resolveTolerance: 1 },
})

eq('inherits the family framing', sibling.frame.payloadLength, FAMILY_BASELINE.frame.payloadLength)
eq('takes its own read command', sibling.commands.readKeyPerf, 0xb0)
eq('inherits the commands it did not name', sibling.commands.begin, raven61Spec.commands.begin)
eq('drops a command it does not have', sibling.commands.factoryReset, null)
eq('merges one leaf of a section', sibling.keyPerf.slots, 8)
eq('keeps the rest of that section', sibling.keyPerf.recordSize, raven61Spec.keyPerf.recordSize)
eq('keeps the limits inside it', sibling.keyPerf.limits.rtMax, raven61Spec.keyPerf.limits.rtMax)
eq('takes its own key table', sibling.layout.keys.length, 4)
eq('takes its own travel', sibling.layout.travelMm, 3.5)
eq('records whose protocol it claims', sibling.basedOn, 'raven61-v1')
ok('leaves the baseline alone', raven61Spec.keyPerf.slots === 128, 'defineDevice mutated the base')

// -------------------------------------------------------------------- layout

const layout = layoutOf(sibling.layout)
eq('layout counts its keys', layout.count, 4)
eq('layout resolves a usage', layout.byUsage(0x06)?.label, 'C')
eq('layout resolves a firmware index', layout.byFirmwareIndex(3)?.label, 'D')
ok('layout is cached per spec', layoutOf(sibling.layout) === layout)

// --------------------------------------------------------------------- codec

const codec = createCodec(sibling)
eq('codec takes the spec name', codec.name, 'Tiny4')
ok('codec offers the commands it has', supports(codec, 'readKeyPerf'))
ok('codec hides the ones it does not', !supports(codec, 'factoryReset'))
ok('and keeps the ones it inherited', supports(codec, 'readKeymap'))

/** Records the requests a codec sends, and answers each one with an ack. */
function recordingLink(): { link: HidLink; sent: Uint8Array[] } {
  const sent: Uint8Array[] = []
  const link = {
    log: { note: () => {} },
    async request(payload: Uint8Array) {
      sent.push(payload.slice())
      const reply = new Uint8Array(payload.length)
      reply[0] = 0xaa
      reply[1] = payload[OFFSET.command] ?? 0
      reply[BLOCK.length] = payload[BLOCK.length] ?? 0
      reply[BLOCK.offsetLo] = payload[BLOCK.offsetLo] ?? 0
      reply[BLOCK.offsetHi] = payload[BLOCK.offsetHi] ?? 0
      return { data: reply }
    },
  } as unknown as HidLink
  return { link, sent }
}

const { link, sent } = recordingLink()
await codec.readKeyPerfBlob(link)
const reads = sent.filter((p) => p[OFFSET.command] === 0xb0)
eq('reads with the spec command', reads.length > 0, true)
eq(
  'reads exactly the spec blob size',
  reads.reduce((n, p) => n + (p[BLOCK.length] ?? 0), 0),
  sibling.keyPerf.slots * sibling.keyPerf.recordSize,
)
eq('wraps the read in the spec transaction', sent[0]?.[OFFSET.command], sibling.commands.begin)
eq('closes it', sent[sent.length - 1]?.[OFFSET.command], sibling.commands.end)
ok(
  'every packet carries a valid checksum',
  sent.every((p) => p[OFFSET.checksum] === checksum(p)),
)

// ------------------------------------------------------------------ validator

const goodJson = {
  id: 'json-board',
  name: 'JSON board',
  confidence: 'guess',
  basedOn: 'raven61-v1',
  usb: { vendorId: 0x1234, productIds: [0x9999] },
  layout: tinyLayout,
  commands: { factoryReset: null },
}

const good = validateSpec(goodJson, 'good.device.json')
ok('a well-formed spec validates', good.spec !== undefined, good.errors.join('; '))
eq('and inherits the baseline', good.spec?.frame.magic, raven61Spec.frame.magic)
eq('and is marked as the user\'s', good.spec?.origin, 'user-json')

function rejects(name: string, patch: Record<string, unknown>, expect: string): void {
  const result = validateSpec({ ...goodJson, ...patch }, 'bad.device.json')
  const hit = result.spec === undefined && result.errors.some((e) => e.includes(expect))
  ok(name, hit, result.spec ? 'accepted it' : `errors were: ${result.errors.join('; ')}`)
}

rejects('a missing name', { name: '' }, 'name')
// The separation this app depends on: one decoded protocol, and no board gets
// it by accident.
rejects('a spec that does not claim a protocol', { basedOn: undefined }, 'basedOn must be')
rejects('a spec claiming a protocol nobody has', { basedOn: 'someone-else-v1' }, 'basedOn must be')
rejects('a spec with no product id', { usb: { vendorId: 0x1234 } }, 'at least one product id')
rejects('a spec with an empty product list', { usb: { vendorId: 0x1234, productIds: [] } }, 'at least one product id')
rejects('the old whole-vendor escape hatch', { usb: { vendorId: 1, productIds: [2], matchAnyProduct: true } }, 'unknown field')
rejects('an unknown confidence', { confidence: 'probably' }, 'confidence')
rejects('a stray field', { lighting: {} }, 'unknown field')
rejects('a translation key', { labelKey: 'codec.raven61.label' }, 'built-in specs only')
rejects('a command byte over 255', { commands: { begin: 256 } }, 'byte')
rejects('a command that is text', { commands: { begin: '0x01' } }, 'number')
rejects('a required command set to null', { frame: { magic: null } }, 'may not be null')
rejects('an unknown field inside a section', { keymap: { layerSize: 512 } }, 'unknown field')
rejects('a layout that is not a list', { layout: { ...tinyLayout, keys: {} } }, 'layout.keys')
rejects(
  'a key table out of order',
  { layout: { ...tinyLayout, keys: [{ ...TINY_KEYS[1]! }, { ...TINY_KEYS[0]! }] } },
  'entry 0 of the list',
)
rejects(
  'more keys than the perf block holds',
  { keyPerf: { slots: 2 } },
  'the block cannot hold them',
)
rejects(
  'a global offset outside the block it reads',
  { global: { length: 8, offsets: { flags: 15 } } },
  'outside the block',
)
rejects(
  'a keymap layer too small for its slots',
  { keymap: { slots: 128, entrySize: 3, layerBytes: 64 } },
  'does not fit',
)

// The two descriptive switch columns. Absent is fine — a table lifted out of a
// driver binary has neither — but present and malformed is not, because both
// are shown to a user as if somebody had checked them.
const switchRow = { value: 0, name: 'Example', travelMm: 4.0, selectable: true }
const acceptsSwitches = (name: string, row: Record<string, unknown>) => {
  const result = validateSpec({ ...goodJson, switchTypes: [row] }, 'switches.device.json')
  ok(name, result.spec !== undefined, result.errors.join('; '))
}
acceptsSwitches('a switch with no magnet or colour on file', switchRow)
acceptsSwitches('a switch carrying both', { ...switchRow, magnetGauss: 350, color: '#f08a3c' })
acceptsSwitches('a three-digit colour', { ...switchRow, color: '#fa3' })
rejects(
  'a colour that is a name rather than hex',
  { switchTypes: [{ ...switchRow, color: 'orange' }] },
  'hex colour',
)
rejects(
  'a colour with no hash',
  { switchTypes: [{ ...switchRow, color: 'f08a3c' }] },
  'hex colour',
)
rejects(
  'a magnet strength that is text',
  { switchTypes: [{ ...switchRow, magnetGauss: '350G' }] },
  'magnetGauss',
)
rejects(
  'a magnet strength of zero',
  { switchTypes: [{ ...switchRow, magnetGauss: 0 }] },
  'magnetGauss',
)
rejects(
  'a misspelt field in a switch row',
  { switchTypes: [{ ...switchRow, colour: '#f08a3c' }] },
  'unknown field',
)
ok(
  'a note is allowed on a row',
  validateSpec(
    { ...goodJson, switchTypes: [{ '//': 'measured on 2026-01-02', ...switchRow }] },
    'noted.device.json',
  ).spec !== undefined,
)

/*
 * The shipped table, through the checks a stranger's JSON gets.
 *
 * `boards/raven61/switches.json` is loaded by an import, not by the validator,
 * so nothing on the app's own path would notice a bad hex colour or a travel
 * that came through as text. It is the same shape as a user's `switchTypes`,
 * so it can be held to the same standard here — which is the only place that
 * costs nothing.
 */
const shipped = validateSpec(
  { ...goodJson, switchTypes: RAVEN61_SWITCH_TYPES },
  'boards/raven61/switches.json',
)
ok('the shipped switch table validates', shipped.spec !== undefined, shipped.errors.join('; '))
eq('and is what the spec serves', raven61Spec.switchTypes.length, RAVEN61_SWITCH_TYPES.length)

/*
 * The values run 0, 1, 2 … with nothing missing in the middle.
 *
 * `switch_type` is an index into the driver's own selector, so a gap means a
 * row was lost — and a JSON list is exactly the kind of file a row falls off:
 * a comma, a bad merge, an editor. Everything above this line would still pass
 * with a row missing (the shape stays valid, and a length compared against
 * itself compares a thing to itself), and the cost of a lost row is a board
 * reporting a type this app then calls "not in the table".
 *
 * The *end* of the list is deliberately not pinned. The driver's table had
 * eight entries and the eighth, "Chocolate Dwarf", turned out to be a part
 * that does not exist — checked against hardware by the board's owner and
 * dropped — so how long this list is, is a question about switches, not a
 * constant.
 */
const values = RAVEN61_SWITCH_TYPES.map((s) => s.value)
ok(
  'switch values run from 0 with no gaps',
  values.join(',') === values.map((_, i) => i).join(','),
  values.join(','),
)
ok('every switch has a name', RAVEN61_SWITCH_TYPES.every((s) => s.name.trim() !== ''))
ok(
  'and a travel that could be a stroke',
  RAVEN61_SWITCH_TYPES.every((s) => s.travelMm > 0.5 && s.travelMm <= 5),
  RAVEN61_SWITCH_TYPES.map((s) => s.travelMm).join(','),
)

/*
 * And the shipped key table, for the same reason and one more.
 *
 * `layout.json` is written by `tools/layout/from-vendor-xml.mjs` out of a file
 * that is not in this repository, so nobody reviewing a regeneration can check
 * it against the source. What the validator can still say is that the table is
 * internally sound: `index` counting from zero in order (the slot map resolves
 * by it), no key claiming a usage another key already claims, and the key
 * count fitting the block that has to hold it.
 */
const shippedLayout = validateSpec(
  { ...goodJson, layout: RAVEN61_LAYOUT },
  'boards/raven61/layout.json',
)
ok(
  'the shipped key table validates',
  shippedLayout.spec !== undefined,
  shippedLayout.errors.join('; '),
)
eq('and is what the spec serves', raven61Spec.layout.keys.length, RAVEN61_LAYOUT.keys.length)
eq('61 keys', RAVEN61_LAYOUT.keys.length, 61)

const dupe = validateSpec(
  {
    ...goodJson,
    layout: { ...tinyLayout, keys: [...TINY_KEYS, { ...TINY_KEYS[0]!, index: 4, label: 'A2' }] },
  },
  'dupe.device.json',
)
ok('a repeated HID usage is a warning, not a refusal', dupe.spec !== undefined)
ok(
  'and it says which key wins',
  dupe.warnings.some((w) => w.includes('already used by "A"')),
  dupe.warnings.join('; '),
)

// A `//`-prefixed key is a note, not a field: a definition is edited by hand
// next to a byte table, and JSON has nowhere else to write down why a number is
// what it is.
const noted = validateSpec(
  { ...goodJson, '//why': 'because the capture said so', commands: { '//note': 'x', begin: 1 } },
  'noted.device.json',
)
ok('a // key is treated as a comment', noted.spec !== undefined, noted.errors.join('; '))
ok('and does not reach the spec', !('//why' in (noted.spec ?? {})))

// ------------------------------------------------------------------ matching

/** A codec only answers for a device it actually lists. */
async function probes(vendorId: number, productId: number): Promise<boolean> {
  const fake = { device: { vendorId, productId } } as unknown as HidLink
  return codec.probe(fake)
}

ok('probes the device it lists', await probes(0x1234, 0x5678))
ok('refuses another product of the same vendor', !(await probes(0x1234, 0x5679)))
ok('refuses the same product of another vendor', !(await probes(0x1235, 0x5678)))

const raven = createCodec(raven61Spec)
ok('Raven61 answers its own id', await raven.probe({ device: { vendorId: 0x19f5, productId: 0xfed0 } } as unknown as HidLink))
ok(
  'Raven61 does not answer its untested siblings',
  !(await raven.probe({ device: { vendorId: 0x19f5, productId: 0xfe20 } } as unknown as HidLink)) &&
    !(await raven.probe({ device: { vendorId: 0x19f5, productId: 0xfeb1 } } as unknown as HidLink)),
)
eq('and claims exactly one product id', raven61Spec.usb.productIds.length, 1)

// ------------------------------------------------------------- the default

// The default protocol is a copy of the Raven61's, not a reference to it: the
// values agree today, and correcting one must not silently rewrite the other.
eq('the default protocol carries the same magic', DEFAULT_PROTOCOL.frame.magic, RAVEN61_PROTOCOL.frame.magic)
eq('and the same read command', DEFAULT_PROTOCOL.commands.readKeyPerf, RAVEN61_PROTOCOL.commands.readKeyPerf)
ok('but is a separate object', DEFAULT_PROTOCOL.frame !== RAVEN61_PROTOCOL.frame)
ok('down to its nested sections', DEFAULT_PROTOCOL.global.offsets !== RAVEN61_PROTOCOL.global.offsets)
ok('and is frozen, so one board cannot edit another\'s baseline', Object.isFrozen(DEFAULT_PROTOCOL.commands))
eq('the id a definition must name', DEFAULT_PROTOCOL_ID, 'raven61-v1')

// -------------------------------------------------------- the forced protocol

const stranger = { vendorId: 0x2222, productId: 0x3333 } as HIDDevice
const forced = forcedSpecFor(stranger)
eq('a forced spec takes the default framing', forced.frame.magic, DEFAULT_PROTOCOL.frame.magic)
eq('and the default commands', forced.commands.readKeyPerf, DEFAULT_PROTOCOL.commands.readKeyPerf)
eq('and the attached device\'s vendor', forced.usb.vendorId, 0x2222)
eq('and its product', forced.usb.productIds[0], 0x3333)
eq('and claims nothing about the board', forced.confidence, 'none')
eq('and says where it came from', forced.origin, 'forced')
ok('and is stable per device, so the working set is not cleared on every probe', forcedSpecFor(stranger) === forced)

const forcedCodec = forcedCodecFor(stranger)
ok('the forced codec answers that device', await forcedCodec.probe({ device: stranger } as unknown as HidLink))
ok(
  'and only that device',
  !(await forcedCodec.probe({ device: { vendorId: 0x2222, productId: 0x3334 } } as unknown as HidLink)),
)
ok('and is cached with its spec', forcedCodecFor(stranger) === forcedCodec)
ok('a real board is never forced — nothing here touches the registry', specById('forced:8738:13107') === undefined)

// mergeSpec must not share structure with the baseline, or one board's edit
// would show up on another.
const merged = mergeSpec(raven61Spec, { keyPerf: { slots: 64 } } as Record<string, unknown>)
eq('a merge leaves the source untouched', raven61Spec.keyPerf.slots, 128)
eq('and applies to the copy', (merged as DeviceSpec).keyPerf.slots, 64)

// The template a user copies. It is documentation that gets pasted into a real
// board's definition, so it has to survive the same validator.
const sample = validateSpec(
  JSON.parse(readFileSync('src/device/user/example.device.json.sample', 'utf8')),
  'example.device.json.sample',
)
ok('the shipped example validates', sample.spec !== undefined, sample.errors.join('; '))
eq('and names no board it is not', sample.spec?.confidence, 'guess')
eq('and claims no factory reset', sample.spec?.commands.factoryReset, null)
ok('and warns about nothing', sample.warnings.length === 0, sample.warnings.join('; '))

console.log(`${passed} checks passed, ${failed} failed`)
if (failed > 0) process.exit(1)
