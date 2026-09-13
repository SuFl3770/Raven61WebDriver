/**
 * The stock driver's exported profile, read and written.
 *
 * The file is plaintext XML with **every byte XOR'd by 0x7b** — `<?` shows up
 * as `47 44`, which is how it is recognised. Inside is the same content as the
 * driver's SQLite database, and the format was recovered from two exports plus
 * the driver's own encoder; `docs/protocol.md` §5.5 is the write-up and
 * `src/device/spec.ts`'s `StockProfileSpec` is what lets a board claim it.
 *
 * ## Two key spaces in one file
 *
 * `perf_info`, `key_info` and `key_light` all index keys by **HID usage** — the
 * same number `layout.json` calls `code`, and on the Raven61 a bijection with
 * the 61 keys. `macro_info` does not: its `item@value` is a **Windows virtual
 * key**, because the stock recorder captures through the message loop and
 * converts on the way to the board. `vk.ts` is that conversion, and a macro
 * read without it types the wrong letters.
 *
 * ## This format is narrower than this app's model
 *
 * It is a subset, and the gaps are structural rather than fixable here:
 *
 *   - **No board-wide settings.** Polling rate, debounce, the Win/Alt locks,
 *     bottom-out trigger — the file has no element for any of them. Only the
 *     lighting half of that block survives, as `light_mode`.
 *   - **One modifier per key.** `macro_value2` holds a modifier *usage*, not a
 *     mask, so `Ctrl+Shift+A` cannot be written.
 *   - **Ten macro slots**, where the board has 32.
 *   - **No `unknown` records**, in the keymap or in a macro body — there is no
 *     element that means "three bytes nobody decoded".
 *   - **Advanced keys are read but not written.** See `LOSS` below.
 *
 * Everything that would be dropped is *counted* on the way out and handed back
 * as `StockLoss`, so the save dialog can say what leaving in this format costs
 * before it is chosen. Nothing is dropped silently.
 */

import type { DeviceSpec, StockProfileSpec } from '../device/spec'
import { MODIFIER_BASE_USAGE, RECORD_TYPE } from '../protocol/keymap'
import type { KeyBinding } from '../protocol/keymap'
import { countsToMm, mmToCounts } from '../protocol/encoding'
import { emptyMacro, type Macro, type MacroEvent } from '../protocol/macros'
import { LIGHT_MODE_OFF, type LightingPatch } from '../protocol/lighting'
import type { Rgb } from '../protocol/keyRgb'
import type { KeyConfig } from '../protocol/types'
import { versionLine } from '../version'
import { PROFILE_VERSION, type ProfileDocument, type ProfileLayer } from './model'
import { usageForVk, vkForUsage } from './vk'

/** The file extension and MIME type a save writes. */
export const STOCK_PROFILE = { extension: '.xml', mime: 'application/xml' } as const

/** Every byte of the stock file is XOR'd with this. */
const XOR_KEY = 0x7b

/** `<?` after the XOR — how an obfuscated file is told from a plain one. */
const OBFUSCATED_MAGIC = [0x3c ^ XOR_KEY, 0x3f ^ XOR_KEY]

/** Stock record types, the way `macro_info` marks a press and a release. */
const RECORD_PRESS = 2
const RECORD_RELEASE = 3

/**
 * `t_key_macro_data.macro_type` → the keymap record type it encodes to.
 *
 * Straight from the stock encoder (docs §, "순정 DB 의 `macro_type` 과의 대응이
 * 인코더 그대로입니다"). 5 is absent because it is two record types — a mouse
 * button and a wheel step — told apart by the catalogue index in `macro_value`
 * rather than by the type, so `MOUSE_CATALOG` resolves it instead.

 * The reverse direction is not a derived map: `stockKeyAttrs` switches on the
 * binding's own kind, because three of the cases also have to rearrange the
 * values and one of them (`advanced`) is deliberately not written at all.
 */
const MACRO_TYPE_TO_RECORD: Readonly<Record<number, number>> = {
  1: RECORD_TYPE.key, // unassigned: `10 00 00`
  2: RECORD_TYPE.key,
  3: RECORD_TYPE.macro,
  6: RECORD_TYPE.consumer,
  12: RECORD_TYPE.action,
  14: RECORD_TYPE.dks,
  15: RECORD_TYPE.mt,
  16: RECORD_TYPE.tgl,
  17: RECORD_TYPE.rs,
  18: RECORD_TYPE.socd,
  19: RECORD_TYPE.oks,
}

/**
 * The driver's Mouse category, in its own order. `macro_type` 5 carries an
 * index into this and the encoder turns it into a button mask or a wheel step.
 */
const MOUSE_CATALOG: readonly KeyBinding[] = [
  { kind: 'mouseButton', buttons: 1, doubleClick: false }, // 1 Left
  { kind: 'mouseButton', buttons: 4, doubleClick: false }, // 2 Middle
  { kind: 'mouseButton', buttons: 2, doubleClick: false }, // 3 Right
  { kind: 'mouseButton', buttons: 1, doubleClick: true }, // 4 Double-click
  { kind: 'mouseWheel', delta: 1 }, // 5 Scroll Up
  { kind: 'mouseWheel', delta: -1 }, // 6 Scroll Down
  { kind: 'mouseButton', buttons: 0x10, doubleClick: false }, // 7 Forward
  { kind: 'mouseButton', buttons: 8, doubleClick: false }, // 8 Backward
]

/**
 * What leaving in stock format would cost, counted rather than described.
 *
 * Every field is a count of things that will not be in the file. Zero
 * everywhere means the save is lossless, which is worth being able to say.
 */
export interface StockLoss {
  /** Board-wide settings with no element to hold them. Always the same list. */
  globalFields: readonly string[]
  /** Keymap entries whose binding the format cannot express. */
  bindings: number
  /** Keys whose modifier mask holds more than one bit. */
  multiModifier: number
  /** Macro slots above the file's ten. */
  macroSlots: number
  /** Macro events the format cannot express — masks with two bits, unknowns. */
  macroEvents: number
  /** True when the document carries advanced-key tables, which are not written. */
  advancedKeys: boolean
  /** Per-key fields kept only for an exact round trip, which the file drops. */
  roundTrip: number
}

export function lossless(loss: StockLoss): boolean {
  return (
    loss.globalFields.length === 0 &&
    loss.bindings === 0 &&
    loss.multiModifier === 0 &&
    loss.macroSlots === 0 &&
    loss.macroEvents === 0 &&
    !loss.advancedKeys &&
    loss.roundTrip === 0
  )
}

/**
 * Board-wide settings the stock file has nowhere to put.
 *
 * Spelled out rather than derived from the document, because the answer does
 * not depend on the document: the elements do not exist, so any of these that
 * were read are lost and any that were not are lost too.
 */
const GLOBAL_FIELDS_LOST = [
  'reportRate',
  'debounceLevel',
  'bottomOutTrigger',
  'actuationCheck',
  'magnetTest',
] as const

// --- obfuscation ---------------------------------------------------------

/** XOR in place of a copy, both directions — the transform is its own inverse. */
function unmask(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ XOR_KEY
  return out
}

/** True when these bytes look like an obfuscated stock profile. */
export function isStockProfile(bytes: Uint8Array): boolean {
  return bytes[0] === OBFUSCATED_MAGIC[0] && bytes[1] === OBFUSCATED_MAGIC[1]
}

/**
 * The XML text inside a stock file.
 *
 * A file that is already plaintext is passed through. That is not politeness
 * to hand-edited files: it is what makes a decoded sample from `docs/` usable
 * as a test input without a second code path to produce it.
 */
export function stockText(bytes: Uint8Array): string {
  const plain = isStockProfile(bytes) ? unmask(bytes) : bytes
  return new TextDecoder('utf-8').decode(plain)
}

/** Text to file bytes, obfuscated the way the stock driver writes them. */
export function stockBytes(text: string): Uint8Array {
  return unmask(new TextEncoder().encode(text))
}

// --- reading -------------------------------------------------------------

export class StockParseError extends Error {}

function attrNum(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function requireNum(el: Element, name: string): number {
  const value = attrNum(el, name)
  if (value === undefined) {
    throw new StockParseError(`<${el.tagName}> has no numeric ${name}`)
  }
  return value
}

/**
 * Parses a stock profile into this app's document.
 *
 * `spec` is the board a write would go to, and it decides two things the file
 * does not carry: which HID usage is which key (the layout), and how many
 * layers and macro slots are real. A file whose `pro_name` names another board
 * is still read — the warning belongs to the caller, which has the whole
 * document to judge — but a file whose keys are not this board's produces a
 * short array, and `check.ts` refuses it.
 */
export function parseStockProfile(
  bytes: Uint8Array,
  spec: DeviceSpec,
): { doc: ProfileDocument; notes: string[] } {
  const stock = spec.stockProfile
  if (!stock) throw new StockParseError('this board has no stock profile format')

  const text = stockText(bytes)
  const dom = new DOMParser().parseFromString(text, 'application/xml')
  const failure = dom.querySelector('parsererror')
  if (failure) throw new StockParseError(failure.textContent?.trim() || 'malformed XML')

  const info = dom.querySelector('profile > info')
  if (!info) throw new StockParseError('no <info> element')

  const notes: string[] = []
  const proName = info.getAttribute('pro_name') ?? ''
  if (proName && proName !== stock.proName) {
    notes.push(`pro_name "${proName}" ≠ "${stock.proName}"`)
  }

  /** HID usage → this project's key index. Built from the live layout. */
  const indexByUsage = new Map<number, number>()
  for (const key of spec.layout.keys) indexByUsage.set(key.code, key.index)
  const keys = spec.layout.keys.length

  const doc: ProfileDocument = {
    version: PROFILE_VERSION,
    savedAt: new Date().toISOString(),
    app: versionLine(),
    device: {
      specId: spec.id,
      name: info.getAttribute('name') || proName || spec.name,
      vendorId: attrNum(info, 'vid') ?? spec.usb.vendorId,
      productId: attrNum(info, 'pid') ?? (spec.usb.productIds[0] ?? 0),
      keyCount: keys,
    },
    blocks: {},
  }

  const perf = readPerf(info, spec, indexByUsage, notes)
  if (perf) doc.blocks.keyPerf = perf

  const keymap = readKeymap(info, stock, indexByUsage, keys, notes)
  if (keymap) doc.blocks.keymap = keymap

  const macros = readMacros(info, spec, stock, notes)
  if (macros) doc.blocks.macros = macros

  const rgb = readKeyLight(info, indexByUsage, keys)
  if (rgb) doc.blocks.keyRgb = rgb

  const lighting = readLightMode(info)
  if (lighting) doc.blocks.global = { lighting }

  if (info.querySelector('adv_keys > adv_item')) {
    notes.push('advanced')
  }

  return { doc, notes }
}

function readPerf(
  info: Element,
  spec: DeviceSpec,
  indexByUsage: Map<number, number>,
  notes: string[],
): KeyConfig[] | undefined {
  const items = [...info.querySelectorAll('perf_info > item')]
  if (items.length === 0) return undefined

  const cpm = spec.encoding.countsPerMm
  const configs: (KeyConfig | undefined)[] = new Array(spec.layout.keys.length)
  let unplaced = 0

  for (const item of items) {
    const usage = requireNum(item, 'key_code')
    const index = indexByUsage.get(usage)
    if (index === undefined) {
      unplaced++
      continue
    }
    const mode = requireNum(item, 'key_mode')
    const rtPress = requireNum(item, 'rt_press')
    const rtRelease = requireNum(item, 'rt_release')
    const top = requireNum(item, 'press_deadzone')
    const bottom = requireNum(item, 'release_deadzone')
    configs[index] = {
      actuationMm: countsToMm(requireNum(item, 'key_actuation'), cpm),
      // The file stores the same three-valued `key_mode` the wire does, and
      // this app folds its two rapid-trigger variants into `continuous`.
      mode: mode === spec.keyPerf.keyMode.off ? 'normal' : 'rapidTrigger',
      rapidTrigger: {
        enabled: mode !== spec.keyPerf.keyMode.off,
        pressMm: countsToMm(rtPress, cpm),
        releaseMm: countsToMm(rtRelease, cpm),
        continuous: mode === spec.keyPerf.keyMode.fullStroke,
      },
      deadZone: {
        enabled: requireNum(item, 'deadzone_state') !== 0,
        topMm: countsToMm(top, cpm),
        bottomMm: countsToMm(bottom, cpm),
      },
      switchType: attrNum(item, 'switch_type'),
    }
  }

  if (unplaced > 0) notes.push(`perf:${unplaced}`)
  // A key the file did not mention has no entry, and a half-filled array would
  // write defaults over keys nobody asked about. The block is dropped instead.
  if (configs.some((c) => c === undefined)) {
    notes.push('perfShort')
    return undefined
  }
  return configs as KeyConfig[]
}

function readKeymap(
  info: Element,
  stock: StockProfileSpec,
  indexByUsage: Map<number, number>,
  keys: number,
  notes: string[],
): ProfileLayer[] | undefined {
  const items = [...info.querySelectorAll('key_info > item')]
  if (items.length === 0) return undefined

  const byLayer = new Map<number, (KeyBinding | null)[]>()
  let undecodable = 0
  let derived = 0
  /*
   * Layers the file has and this board does not store — the Raven61's 2 and 3,
   * whose rows the stock driver writes over blobs that are not keymaps. Counted
   * rather than skipped quietly: the file plainly has them, and someone who
   * set something there deserves to hear that it is not coming back.
   */
  const skipped = new Set<number>()

  for (const item of items) {
    const layer = requireNum(item, 'fn_layer')
    if (stock.derivedLayers.includes(layer)) {
      derived++
      continue
    }
    if (!stock.layers.includes(layer)) {
      skipped.add(layer)
      continue
    }
    const index = indexByUsage.get(requireNum(item, 'key_code'))
    if (index === undefined) continue

    let entries = byLayer.get(layer)
    if (!entries) {
      entries = new Array<KeyBinding | null>(keys).fill(null)
      byLayer.set(layer, entries)
    }
    const binding = bindingFromStock(item)
    if (binding === null) undecodable++
    else entries[index] = binding
  }

  if (undecodable > 0) notes.push(`keymap:${undecodable}`)
  if (derived > 0) notes.push(`derived:${derived}`)
  if (skipped.size > 0) notes.push(`layers:${skipped.size}`)
  if (byLayer.size === 0) return undefined

  return [...byLayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([layer, entries]) => ({ layer, entries }))
}

/** One `key_info > item` as a binding, or null when the type is not one of ours. */
function bindingFromStock(item: Element): KeyBinding | null {
  const macroType = requireNum(item, 'macro_type')
  const value = requireNum(item, 'macro_value')
  const value2 = attrNum(item, 'macro_value2') ?? 0
  const value3 = attrNum(item, 'macro_value3') ?? 0

  if (macroType === 1) return { kind: 'none', raw: RECORD_TYPE.key }
  if (macroType === 5) return MOUSE_CATALOG[value - 1] ?? null

  const record = MACRO_TYPE_TO_RECORD[macroType]
  if (record === undefined) return null

  switch (record) {
    case RECORD_TYPE.key: {
      /*
       * `macro_value2` is a modifier *usage*, not a mask — the driver keeps one
       * and the firmware ORs whatever it is given. Turning it into the single
       * bit it stands for is the whole conversion.
       */
      const mask =
        value2 >= MODIFIER_BASE_USAGE && value2 <= MODIFIER_BASE_USAGE + 7
          ? 1 << (value2 - MODIFIER_BASE_USAGE)
          : 0
      return value === 0 && mask === 0
        ? { kind: 'none', raw: RECORD_TYPE.key }
        : { kind: 'key', usage: value & 0xff, modifiers: mask }
    }
    // Both of these pack the record's two bytes into one number, low byte
    // first: FN1 is 511, which is `f0 ff 01`.
    case RECORD_TYPE.consumer:
      return { kind: 'consumer', usage: value & 0xffff }
    case RECORD_TYPE.action:
      return { kind: 'action', code: value & 0xff, arg: (value >> 8) & 0xff }
    case RECORD_TYPE.macro:
      return { kind: 'macro', slot: value & 0xff, repeat: value3 & 0xff }
    default:
      return { kind: 'advanced', type: record, record: value & 0xff, param: value3 & 0xff }
  }
}

function readMacros(
  info: Element,
  spec: DeviceSpec,
  stock: StockProfileSpec,
  notes: string[],
): Macro[] | undefined {
  const items = [...info.querySelectorAll('macro_info > macro_item')]
  if (items.length === 0) return undefined

  const macros: Macro[] = Array.from({ length: spec.macros.slots }, (_, slot) => emptyMacro(slot))
  let unconverted = 0

  for (const item of items) {
    // `macro_id` is 1-based in the file and 0-based here: the stock `M 1` is
    // this app's slot #0.
    const slot = requireNum(item, 'macro_id') - 1
    if (slot < 0 || slot >= spec.macros.slots) continue

    const events: MacroEvent[] = []
    for (const record of item.querySelectorAll('record_item > item')) {
      const type = requireNum(record, 'type')
      if (type !== RECORD_PRESS && type !== RECORD_RELEASE) {
        unconverted++
        continue
      }
      const usage = usageForVk(requireNum(record, 'value'))
      if (usage === undefined) {
        unconverted++
        continue
      }
      const press = type === RECORD_PRESS
      const delayMs = Math.max(0, Math.min(0xffff, requireNum(record, 'delay_time')))
      events.push(
        usage >= MODIFIER_BASE_USAGE && usage <= MODIFIER_BASE_USAGE + 7
          ? { action: { kind: 'modifiers', mask: 1 << (usage - MODIFIER_BASE_USAGE) }, press, delayMs }
          : { action: { kind: 'key', usage }, press, delayMs },
      )
    }
    macros[slot] = { slot, events, programmed: true, terminated: true, offset: 0 }
  }

  if (unconverted > 0) notes.push(`macroEvents:${unconverted}`)
  /*
   * The store is written whole — the offset table is its only index — so
   * applying a file that describes ten slots empties the rest. That is the
   * right outcome for "put this profile back" and it is still someone's macros
   * going away, so it is said before the write rather than found afterwards.
   */
  if (spec.macros.slots > stock.macroSlots) {
    notes.push(`macroSlotsCleared:${spec.macros.slots - stock.macroSlots}`)
  }
  return macros
}

function readKeyLight(
  info: Element,
  indexByUsage: Map<number, number>,
  keys: number,
): (Rgb | null)[] | undefined {
  const items = [...info.querySelectorAll('key_light > item')]
  if (items.length === 0) return undefined

  const colors: (Rgb | null)[] = new Array(keys).fill(null)
  for (const item of items) {
    const index = indexByUsage.get(requireNum(item, 'key_code'))
    if (index === undefined) continue
    const hex = item.getAttribute('key_rgb') ?? ''
    const match = /^#?([0-9a-fA-F]{6})$/.exec(hex)
    if (!match) continue
    const n = Number.parseInt(match[1]!, 16)
    colors[index] = { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
  }
  return colors
}

/**
 * The one `light_mode` row the board is running.
 *
 * The file carries every mode's settings and marks the live one with
 * `status="1"`. This app's lighting model is the *current* effect — one mode,
 * one set of controls — so the rest are read past. They are not lost in any
 * sense the board would notice: the board holds one too.
 */
function readLightMode(info: Element): LightingPatch | undefined {
  const items = [...info.querySelectorAll('light_mode > item')]
  const active = items.find((i) => attrNum(i, 'status') === 1) ?? items[0]
  if (!active) return undefined

  const packed = attrNum(active, 'color_value') ?? 0
  return {
    lightMode: attrNum(active, 'mode') ?? LIGHT_MODE_OFF,
    brightness: attrNum(active, 'brightness') ?? 100,
    speed: attrNum(active, 'speed') ?? 0,
    direction: (attrNum(active, 'direction') ?? 0) !== 0,
    colorful: (attrNum(active, 'colorful') ?? 0) !== 0,
    color: { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff },
  }
}

// --- writing -------------------------------------------------------------

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * Escapes an attribute value, apostrophes included.
 *
 * `'` is escaped because the stock driver escapes it — `key_name="&apos;"` is
 * in its own export — and a file this app writes should read back through the
 * stock driver's parser the way its own does.
 */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]!)
}

function tag(name: string, attrs: readonly (readonly [string, string | number])[]): string {
  const body = attrs.map(([k, v]) => `${k}="${esc(String(v))}"`).join(' ')
  return `<${name} ${body}/>`
}

/**
 * Writes a document as a stock profile, and says what it could not take.
 *
 * The loss report is built while writing rather than in a pass of its own, so
 * what the dialog shows is what the encoder actually did — a second pass that
 * predicts the first is a second thing to keep in step.
 */
export function encodeStockProfile(
  doc: ProfileDocument,
  spec: DeviceSpec,
): { bytes: Uint8Array; loss: StockLoss } {
  const stock = spec.stockProfile
  if (!stock) throw new StockParseError('this board has no stock profile format')

  const loss: StockLoss = {
    globalFields: doc.blocks.global
      ? GLOBAL_FIELDS_LOST.filter((f) => doc.blocks.global![f] !== undefined)
      : [],
    bindings: 0,
    multiModifier: 0,
    macroSlots: 0,
    macroEvents: 0,
    advancedKeys: doc.blocks.advancedKeys !== undefined,
    roundTrip: 0,
  }

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<profile>']
  lines.push(
    `<info name="${esc(doc.device.name)}" pid="${doc.device.productId}" vid="${doc.device.vendorId}" pro_name="${esc(stock.proName)}">`,
  )

  lines.push(...writeMacroInfo(doc, stock, loss))
  lines.push(...writeKeyInfo(doc, spec, stock, loss))
  lines.push(...writePerfInfo(doc, spec, loss))
  lines.push(...writeLightMode(doc))
  lines.push(...writeKeyLight(doc, spec))

  lines.push('</info>', '</profile>')
  // CRLF, which is what both stock exports use.
  return { bytes: stockBytes(`${lines.join('\r\n')}\r\n`), loss }
}

function writeMacroInfo(doc: ProfileDocument, stock: StockProfileSpec, loss: StockLoss): string[] {
  const macros = doc.blocks.macros
  if (!macros) return []

  const lines = ['<macro_info>']
  for (let slot = 0; slot < stock.macroSlots; slot++) {
    const macro = macros.find((m) => m.slot === slot)
    const events = macro?.events ?? []
    const records: string[] = []
    for (const event of events) {
      const record = stockMacroRecord(event)
      if (record === null) loss.macroEvents++
      else records.push(record)
    }
    const head = `macro_id="${slot + 1}" name="M ${slot + 1}" times="1" type="1" delaytime="${records.length > 0 ? 10 : 0}"`
    if (records.length === 0) {
      lines.push(`<macro_item ${head}/>`)
      continue
    }
    lines.push(`<macro_item ${head}>`, '<record_item>', ...records, '</record_item>', '</macro_item>')
  }
  lines.push('</macro_info>')

  // Slots the file has no room for. Counted as "not written" rather than
  // squeezed in: `macro_id` 11 is a row the stock driver would not read.
  for (const macro of macros) {
    if (macro.slot >= stock.macroSlots && macro.events.length > 0) loss.macroSlots++
  }
  return lines
}

/** One macro event as a `record_item > item`, or null when it cannot be one. */
function stockMacroRecord(event: MacroEvent): string | null {
  const action = event.action
  let usage: number
  if (action.kind === 'key') {
    usage = action.usage
  } else if (action.kind === 'modifiers') {
    /*
     * A mask with two bits set is one record here and two in the file, and
     * splitting it would change the timing — the delay belongs to the record,
     * so two records means two waits where the board has one. Reported instead.
     */
    if (action.mask === 0 || (action.mask & (action.mask - 1)) !== 0) return null
    usage = MODIFIER_BASE_USAGE + Math.log2(action.mask)
  } else {
    return null
  }
  const vk = vkForUsage(usage)
  if (vk === undefined) return null
  return tag('item', [
    ['desc', ''],
    ['type', event.press ? RECORD_PRESS : RECORD_RELEASE],
    ['value', vk],
    // The stock player waits at least a tick; this app allows 0, which is how
    // two keys go down together. The file keeps the 0 — it is the stock
    // *encoder* that clamps, and nothing here should pre-empt that.
    ['delay_time', event.delayMs],
  ])
}

function writeKeyInfo(
  doc: ProfileDocument,
  spec: DeviceSpec,
  stock: StockProfileSpec,
  loss: StockLoss,
): string[] {
  const layers = doc.blocks.keymap
  if (!layers) return []

  const lines = ['<key_info>']
  for (const layerNo of stock.layers) {
    const layer = layers.find((l) => l.layer === layerNo)
    if (!layer) continue
    for (const key of spec.layout.keys) {
      const binding = layer.entries[key.index]
      if (binding === null || binding === undefined) continue
      const attrs = stockKeyAttrs(binding, loss)
      lines.push(
        tag('item', [
          ['fn_layer', layerNo],
          ['key_code', key.code],
          ['layout_desc', key.code],
          ['macro_type', attrs.macroType],
          ['macro_value', attrs.value],
          ['macro_value2', attrs.value2],
          ['macro_value3', attrs.value3],
          ['macro_desc', attrs.desc],
        ]),
      )
    }
  }
  lines.push('</key_info>')
  return lines
}

interface StockKeyAttrs {
  macroType: number
  value: number
  value2: number
  value3: number
  desc: string
}

/** Unassigned, which is also what a binding the format cannot hold becomes. */
const UNASSIGNED: StockKeyAttrs = { macroType: 1, value: 1, value2: 0, value3: 0, desc: '' }

function stockKeyAttrs(binding: KeyBinding, loss: StockLoss): StockKeyAttrs {
  switch (binding.kind) {
    case 'none':
      return UNASSIGNED
    case 'key': {
      let value2 = 0
      if (binding.modifiers !== 0) {
        if ((binding.modifiers & (binding.modifiers - 1)) !== 0) loss.multiModifier++
        // The lowest bit set, which is the one the stock driver would have
        // stored had it been the one to record this.
        const bit = 31 - Math.clz32(binding.modifiers & -binding.modifiers)
        value2 = MODIFIER_BASE_USAGE + bit
      }
      return { macroType: 2, value: binding.usage, value2, value3: 0, desc: '' }
    }
    case 'consumer':
      return { macroType: 6, value: binding.usage, value2: 0, value3: 0, desc: '' }
    case 'action':
      return {
        macroType: 12,
        value: (binding.code & 0xff) | ((binding.arg & 0xff) << 8),
        value2: 0,
        value3: 0,
        desc: '',
      }
    case 'macro':
      return { macroType: 3, value: binding.slot, value2: 0, value3: binding.repeat, desc: '' }
    case 'mouseButton':
    case 'mouseWheel': {
      const index = MOUSE_CATALOG.findIndex((c) => sameMouse(c, binding))
      if (index < 0) {
        loss.bindings++
        return UNASSIGNED
      }
      return { macroType: 5, value: index + 1, value2: 0, value3: 0, desc: '' }
    }
    case 'advanced':
      /*
       * The keymap entry could be written — `macro_type` 14-19 exists — but the
       * record it points at would not be, because `adv_keys` is not written at
       * all (see the file header). An entry naming a record the file does not
       * carry is worse than no entry, so it goes out unassigned and is counted.
       */
      loss.bindings++
      return UNASSIGNED
    case 'unknown':
      loss.bindings++
      return UNASSIGNED
  }
}

function sameMouse(a: KeyBinding, b: KeyBinding): boolean {
  if (a.kind === 'mouseButton' && b.kind === 'mouseButton') {
    return a.buttons === b.buttons && a.doubleClick === b.doubleClick
  }
  if (a.kind === 'mouseWheel' && b.kind === 'mouseWheel') return a.delta === b.delta
  return false
}

function writePerfInfo(doc: ProfileDocument, spec: DeviceSpec, loss: StockLoss): string[] {
  const configs = doc.blocks.keyPerf
  if (!configs) return []

  const cpm = spec.encoding.countsPerMm
  const mode = spec.keyPerf.keyMode
  const lines = ['<perf_info>']
  for (const key of spec.layout.keys) {
    const cfg = configs[key.index]
    if (!cfg) continue
    // `switchFlags` and `rtUnset` exist so a write can put back exactly what a
    // read found. The file has no column for either, so they are counted.
    if (cfg.switchFlags !== undefined || cfg.rtUnset) loss.roundTrip++
    lines.push(
      tag('item', [
        ['key_code', key.code],
        ['switch_type', cfg.switchType ?? 0],
        [
          'key_mode',
          cfg.mode === 'normal'
            ? mode.off
            : cfg.rapidTrigger.continuous
              ? mode.fullStroke
              : mode.rapidTrigger,
        ],
        ['key_actuation', mmToCounts(cfg.actuationMm, cpm)],
        ['rt_press', mmToCounts(cfg.rapidTrigger.pressMm, cpm)],
        ['rt_release', mmToCounts(cfg.rapidTrigger.releaseMm, cpm)],
        ['deadzone_state', cfg.deadZone.enabled ? 1 : 0],
        ['press_deadzone', mmToCounts(cfg.deadZone.topMm, cpm)],
        ['release_deadzone', mmToCounts(cfg.deadZone.bottomMm, cpm)],
      ]),
    )
  }
  lines.push('</perf_info>')
  return lines
}

function writeLightMode(doc: ProfileDocument): string[] {
  const lighting = doc.blocks.global?.lighting
  if (!lighting) return []

  const color = lighting.color ?? { r: 0, g: 0, b: 0 }
  const packed = (color.r << 16) | (color.g << 8) | color.b
  /*
   * One row, for the one mode the board is running. The stock file carries
   * every mode's settings; this app only ever knew about the live one, and a
   * row invented for a mode nobody read would be a setting made up.
   */
  return [
    '<light_mode>',
    tag('item', [
      ['mode', lighting.lightMode ?? LIGHT_MODE_OFF],
      ['brightness', lighting.brightness ?? 100],
      ['speed', lighting.speed ?? 0],
      ['direction', lighting.direction ? 1 : 0],
      ['colorful', lighting.colorful ? 1 : 0],
      ['colorindex', 0],
      ['color_value', packed],
      ['status', 1],
    ]),
    '</light_mode>',
  ]
}

function writeKeyLight(doc: ProfileDocument, spec: DeviceSpec): string[] {
  const colors = doc.blocks.keyRgb
  if (!colors) return []

  const lines = ['<key_light>']
  for (const key of spec.layout.keys) {
    const color = colors[key.index] ?? { r: 0, g: 0, b: 0 }
    const hex = [color.r, color.g, color.b]
      .map((c) => c.toString(16).toUpperCase().padStart(2, '0'))
      .join('')
    lines.push(
      tag('item', [
        ['key_name', key.label],
        ['key_code', key.code],
        ['key_rgb', `#${hex}`],
      ]),
    )
  }
  lines.push('</key_light>')
  return lines
}
