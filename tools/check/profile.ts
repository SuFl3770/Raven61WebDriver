/**
 * Checks the profile file formats. `npm run check`.
 *
 * Three things are worth pinning here, and they are the three that would go
 * wrong quietly:
 *
 *   - **The two key spaces.** A stock macro body is in Windows virtual keys and
 *     the rest of the file is in HID usages. Get that backwards and the macro
 *     types different letters — no error anywhere, just the wrong keystrokes.
 *     The letter pairs asserted below are read straight out of the two sample
 *     exports (`Q` is 81, not usage 0x14).
 *   - **The loss report.** The save dialog's whole job is to say what leaving
 *     in stock format costs, and it says it from these counts. A count that
 *     silently stops counting is worse than no dialog.
 *   - **The integrity check.** It is what stands between a file and a write to
 *     flash, so each rule is asserted to fire *and* to stay quiet on a good
 *     document — a check that rejects everything passes neither test.
 *
 * ## What is not here
 *
 * `parseStockProfile` needs `DOMParser`, which node does not have. The reader
 * is therefore exercised in the browser rather than here; what this file can
 * do, and does, is check the *writer* it has to agree with, plus the XOR and
 * the VK table that both sides share.
 */
import { raven61Spec } from '../../src/device/boards/raven61/index'
import { checkProfile } from '../../src/profile/check'
import { encodeJsonProfile, parseJsonProfile, ProfileParseError } from '../../src/profile/json'
import { fromBase64, toBase64, PROFILE_VERSION, type ProfileDocument } from '../../src/profile/model'
import { encodeStockProfile, isStockProfile, lossless, stockBytes, stockText } from '../../src/profile/stock'
import { usageForVk, vkForUsage } from '../../src/profile/vk'
import { MODIFIER_BASE_USAGE } from '../../src/protocol/keymap'
import { emptyMacro } from '../../src/protocol/macros'
import { countsToMm } from '../../src/protocol/encoding'
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

const spec = raven61Spec
const KEYS = spec.layout.keys.length

// --- the obfuscation -----------------------------------------------------

{
  const text = '<?xml version="1.0" encoding="UTF-8"?>\r\n<profile>\r\n</profile>\r\n'
  const bytes = stockBytes(text)
  ok('stock: first two bytes are the export magic', bytes[0] === 0x47 && bytes[1] === 0x44)
  ok('stock: recognised as a stock profile', isStockProfile(bytes))
  eq('stock: XOR round trips', stockText(bytes), text)
  // A file someone has already unmasked has to open too, or a decoded sample
  // needs a second code path to be usable as an input.
  eq('stock: plaintext passes through', stockText(new TextEncoder().encode(text)), text)
}

// --- the two key spaces --------------------------------------------------

{
  // Straight out of `new macro.xml`: the recorded QWER/ASDF bodies.
  const FROM_SAMPLES: [number, number][] = [
    [81, 0x14], // Q
    [87, 0x1a], // W
    [69, 0x08], // E
    [82, 0x15], // R
    [65, 0x04], // A
    [83, 0x16], // S
    [68, 0x07], // D
    [70, 0x09], // F
    [90, 0x1d], // Z
    [88, 0x1b], // X
    [67, 0x06], // C
    [86, 0x19], // V
  ]
  for (const [vk, usage] of FROM_SAMPLES) {
    eq(`vk: ${vk} is usage 0x${usage.toString(16)}`, usageForVk(vk), usage)
    eq(`vk: usage 0x${usage.toString(16)} is ${vk}`, vkForUsage(usage), vk)
  }
  // The two rows that wrap, and are therefore the two easiest to get wrong.
  eq('vk: VK_0 is usage 0x27', usageForVk(0x30), 0x27)
  eq('vk: VK_NUMPAD0 is usage 0x62', usageForVk(0x60), 0x62)
  eq('vk: VK_NUMPAD1 is usage 0x59', usageForVk(0x61), 0x59)
  eq('vk: VK_F1 is usage 0x3a', usageForVk(0x70), 0x3a)
  eq('vk: VK_F13 is usage 0x68', usageForVk(0x7c), 0x68)
  eq('vk: VK_LSHIFT is usage 0xe1', usageForVk(0xa0), 0xe1)
  // The generic modifiers resolve to the left-hand side, and the reverse
  // direction still names the side rather than the generic key.
  eq('vk: VK_SHIFT resolves left', usageForVk(0x10), 0xe1)
  eq('vk: usage 0xe1 maps back to VK_LSHIFT', vkForUsage(0xe1), 0xa0)
  eq('vk: a key the driver cannot capture is undefined', usageForVk(0xff), undefined)
}

// --- base64 --------------------------------------------------------------

{
  for (const length of [0, 1, 2, 3, 255, 1024]) {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff
    const back = fromBase64(toBase64(bytes))
    eq(`base64: ${length} bytes round trip`, back ? [...back] : null, [...bytes])
  }
  eq('base64: refuses what is not base64', fromBase64('not base64!'), null)
}

// --- a document to check against -----------------------------------------

function key(overrides: Partial<KeyConfig> = {}): KeyConfig {
  return {
    actuationMm: countsToMm(75),
    mode: 'normal',
    rapidTrigger: { enabled: false, pressMm: countsToMm(5), releaseMm: countsToMm(5), continuous: false },
    deadZone: { enabled: false, topMm: 0, bottomMm: countsToMm(10) },
    switchType: 3,
    ...overrides,
  }
}

function doc(): ProfileDocument {
  return {
    version: PROFILE_VERSION,
    savedAt: '2026-09-13T00:00:00.000Z',
    app: 'check',
    device: {
      specId: spec.id,
      name: spec.name,
      vendorId: spec.usb.vendorId,
      productId: spec.usb.productIds[0]!,
      keyCount: KEYS,
    },
    blocks: {
      keyPerf: Array.from({ length: KEYS }, () => key()),
      keymap: Array.from({ length: spec.keymap.layers }, (_, layer) => ({
        layer,
        entries: spec.layout.keys.map((k) => ({ kind: 'key' as const, usage: k.code, modifiers: 0 })),
      })),
      macros: Array.from({ length: spec.macros.slots }, (_, slot) => emptyMacro(slot)),
      advancedKeys: {
        dks: toBase64(new Uint8Array(spec.advancedKeys.dksBlobSize)),
        pair: toBase64(new Uint8Array(spec.advancedKeys.pairBlobSize)),
        toggle: toBase64(new Uint8Array(spec.advancedKeys.toggleBlobSize)),
      },
      keyRgb: Array.from({ length: KEYS }, () => ({ r: 0, g: 0, b: 0 })),
      global: { reportRate: 4, debounceLevel: 0, bottomOutTrigger: false },
    },
  }
}

// --- the JSON format -----------------------------------------------------

{
  const original = doc()
  const back = parseJsonProfile(encodeJsonProfile(original))
  eq('json: round trips unchanged', back, original)

  const refuses = (name: string, text: string) => {
    try {
      parseJsonProfile(text)
      fails.push(`json: ${name} was accepted`)
    } catch (e) {
      ok(`json: refuses ${name}`, e instanceof ProfileParseError)
    }
  }
  refuses('a non-object', '[]')
  refuses('a missing version', '{"device":{},"blocks":{}}')
  refuses('a missing device', '{"version":1,"blocks":{}}')
  refuses('a non-numeric keyCount', '{"version":1,"device":{"specId":"x","name":"x","vendorId":1,"productId":1,"keyCount":"61"},"blocks":{}}')
  refuses(
    'a keyPerf that is not a list',
    '{"version":1,"device":{"specId":"x","name":"x","vendorId":1,"productId":1,"keyCount":61},"blocks":{"keyPerf":{}}}',
  )
}

// --- the integrity check -------------------------------------------------

{
  const report = checkProfile(doc(), spec)
  eq('check: a clean document is fatal-free', report.fatal, null)
  eq('check: a clean document warns about no board', report.deviceWarnings, [])
  for (const row of report.blocks) {
    ok(`check: ${row.block} is applicable`, row.applicable, row.errors.join(' / '))
  }

  const newer = doc()
  newer.version = PROFILE_VERSION + 1
  ok('check: a newer version is fatal', checkProfile(newer, spec).fatal !== null)

  const short = doc()
  short.blocks.keyPerf = short.blocks.keyPerf!.slice(0, 10)
  const shortRow = checkProfile(short, spec).blocks.find((b) => b.block === 'keyPerf')!
  ok('check: a short keyPerf is refused', !shortRow.applicable && shortRow.errors.length === 1)

  const otherBoard = doc()
  otherBoard.device.specId = 'somebody-else'
  ok('check: another board warns', checkProfile(otherBoard, spec).deviceWarnings.length > 0)

  const badLayer = doc()
  badLayer.blocks.keymap = [{ layer: 99, entries: [] }]
  const layerRow = checkProfile(badLayer, spec).blocks.find((b) => b.block === 'keymap')!
  ok('check: an out-of-range layer is refused', !layerRow.applicable)

  const badBlob = doc()
  badBlob.blocks.advancedKeys = { ...badBlob.blocks.advancedKeys!, dks: toBase64(new Uint8Array(7)) }
  const blobRow = checkProfile(badBlob, spec).blocks.find((b) => b.block === 'advancedKeys')!
  ok('check: a wrong-sized table is refused', !blobRow.applicable)

  const badRate = doc()
  badRate.blocks.global = { reportRate: 99 }
  const rateRow = checkProfile(badRate, spec).blocks.find((b) => b.block === 'global')!
  ok('check: a rate this board does not list is refused', !rateRow.applicable)

  // Out of range is a *warning*: the encoder saturates, so the write is well
  // formed. A block that refused it would be refusing something writable.
  const deep = doc()
  deep.blocks.keyPerf = deep.blocks.keyPerf!.map(() => key({ actuationMm: 99 }))
  const deepRow = checkProfile(deep, spec).blocks.find((b) => b.block === 'keyPerf')!
  ok('check: a value past the limit warns rather than refuses', deepRow.applicable)
  ok('check: and says so', deepRow.warnings.length > 0)

  const missing = doc()
  delete missing.blocks.macros
  const macroRow = checkProfile(missing, spec).blocks.find((b) => b.block === 'macros')!
  ok('check: an absent block is not present', !macroRow.present && !macroRow.applicable)
}

// --- the stock writer ----------------------------------------------------

{
  const { bytes, loss } = encodeStockProfile(doc(), spec)
  const text = stockText(bytes)

  ok('stock: written file starts with the XML declaration', text.startsWith('<?xml version="1.0"'))
  ok('stock: uses CRLF like both samples', text.includes('\r\n') && !/[^\r]\n/.test(text))
  ok('stock: carries the board name the driver writes', text.includes('pro_name="Raven61 HE"'))

  const count = (tag: string) => text.split(`<${tag} `).length - 1
  eq('stock: a row per key per section', count('item'), countExpectedItems())
  eq('stock: ten macro slots', count('macro_item'), spec.stockProfile!.macroSlots)
  // The file's layers are the board's, not the four the stock export writes:
  // two of those land on blobs that are not keymaps. See the spec's note.
  eq('stock: writes only the layers the board stores', spec.stockProfile!.layers.length, spec.keymap.layers)
  ok('stock: no advanced-key section', !text.includes('<adv_keys>'))

  function countExpectedItems(): number {
    // key_info (one row per key per stored layer), perf_info and key_light.
    // No light_mode row: this document's `global` carries no lighting.
    return KEYS * spec.stockProfile!.layers.length + KEYS + KEYS
  }

  // The board-wide loss is unconditional — the file has no element for it.
  ok('stock: names the board-wide fields it drops', loss.globalFields.length > 0)
  ok('stock: a document with advanced keys is not lossless', loss.advancedKeys)
  ok('stock: and is therefore reported as lossy', !lossless(loss))

  // A document with nothing the format cannot hold.
  const plain = doc()
  delete plain.blocks.advancedKeys
  delete plain.blocks.global
  const clean = encodeStockProfile(plain, spec).loss
  ok('stock: an expressible document loses nothing', lossless(clean), JSON.stringify(clean))

  // Each loss counter, fired one at a time.
  const multi = doc()
  delete multi.blocks.advancedKeys
  delete multi.blocks.global
  multi.blocks.keymap = [
    {
      layer: 0,
      entries: spec.layout.keys.map((_, i) =>
        i === 0
          ? { kind: 'key' as const, usage: 4, modifiers: 0b0000_0011 }
          : { kind: 'key' as const, usage: 4, modifiers: 0 },
      ),
    },
  ]
  eq('stock: counts a two-bit modifier mask', encodeStockProfile(multi, spec).loss.multiModifier, 1)

  const unknown = doc()
  delete unknown.blocks.advancedKeys
  delete unknown.blocks.global
  unknown.blocks.keymap = [
    {
      layer: 0,
      entries: spec.layout.keys.map((_, i) =>
        i === 0
          ? { kind: 'unknown' as const, bytes: [0x55, 0x01, 0x02] as const }
          : { kind: 'key' as const, usage: 4, modifiers: 0 },
      ),
    },
  ]
  eq('stock: counts a record it cannot express', encodeStockProfile(unknown, spec).loss.bindings, 1)

  const past = doc()
  delete past.blocks.advancedKeys
  delete past.blocks.global
  past.blocks.macros = past.blocks.macros!.map((m) =>
    m.slot === 20 ? { ...m, events: [{ action: { kind: 'key', usage: 4 }, press: true, delayMs: 0 }] } : m,
  )
  eq('stock: counts a macro slot past the tenth', encodeStockProfile(past, spec).loss.macroSlots, 1)

  const twoMods = doc()
  delete twoMods.blocks.advancedKeys
  delete twoMods.blocks.global
  twoMods.blocks.macros = twoMods.blocks.macros!.map((m) =>
    m.slot === 0
      ? {
          ...m,
          events: [
            // One bit: expressible. Two bits: one record here, two in the file,
            // and splitting it would move the delay — so it is dropped.
            { action: { kind: 'modifiers' as const, mask: 0b0000_0001 }, press: true, delayMs: 1 },
            { action: { kind: 'modifiers' as const, mask: 0b0000_0011 }, press: true, delayMs: 1 },
          ],
        }
      : m,
  )
  eq('stock: counts a macro event it cannot express', encodeStockProfile(twoMods, spec).loss.macroEvents, 1)

  const roundTrip = doc()
  delete roundTrip.blocks.advancedKeys
  delete roundTrip.blocks.global
  roundTrip.blocks.keyPerf = roundTrip.blocks.keyPerf!.map((c, i) =>
    i === 0 ? { ...c, switchFlags: 0xa0 } : c,
  )
  eq('stock: counts a value kept for an exact round trip', encodeStockProfile(roundTrip, spec).loss.roundTrip, 1)

  // A modifier does reach the file, as the usage the driver stores rather than
  // as a mask — the one conversion `key_info` needs.
  const oneMod = doc()
  oneMod.blocks.keymap = [
    {
      layer: 0,
      entries: spec.layout.keys.map(() => ({ kind: 'key' as const, usage: 4, modifiers: 1 })),
    },
  ]
  const modText = stockText(encodeStockProfile(oneMod, spec).bytes)
  ok(
    'stock: a modifier is written as its usage, not its bit',
    modText.includes(`macro_value2="${MODIFIER_BASE_USAGE}"`),
  )
}

// --- the board does not hand its file format to its siblings -------------

{
  ok('spec: the Raven61 claims the stock format', spec.stockProfile !== undefined)
  eq('spec: and claims the name both exports carry', spec.stockProfile?.proName, 'Raven61 HE')
}

if (fails.length > 0) {
  console.error(`FAIL (${pass} passed, ${fails.length} failed)`)
  for (const f of fails) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`ok (${pass} checks)`)
