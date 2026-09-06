/**
 * Checking a JSON board definition before it is allowed to talk to hardware.
 *
 * A TypeScript spec is checked by the compiler. A JSON one is not, and it ends
 * up driving writes to flash — so this is not a formality: a `slots` that came
 * through as a string, or a `flags` bit that is 256, would be a bad packet
 * built out of a typo. Everything here fails loudly and names the field.
 *
 * What it does **not** do is judge whether the numbers are right for the board.
 * Nothing on this side can know that; `confidence` is where the author says how
 * far they have checked, and the UI repeats it rather than guessing.
 */

import { BASE_PROTOCOL_ID, mergeSpec, FAMILY_BASELINE } from './define'
import type { DeviceSpec } from './spec'

export interface ValidationResult {
  spec?: DeviceSpec
  errors: string[]
  warnings: string[]
}

const CONFIDENCE = ['confirmed', 'partial', 'guess', 'none']

/** Sections that may appear, and whether each leaf is a byte, a size, or a flag. */
const SECTIONS: Record<string, Record<string, LeafKind>> = {
  frame: {
    reportId: 'byte',
    payloadLength: 'size',
    magic: 'byte',
    ack: 'byte',
    replyData: 'byte',
    'offsets.magic': 'index',
    'offsets.command': 'index',
    'offsets.reserved': 'index',
    'offsets.checksum': 'index',
    'offsets.data': 'index',
    'block.length': 'index',
    'block.offsetLo': 'index',
    'block.offsetHi': 'index',
    'block.data': 'index',
  },
  commands: {
    begin: 'byte?',
    end: 'byte?',
    readFirmware: 'byte?',
    readGlobalSettings: 'byte?',
    writeGlobalSettings: 'byte?',
    readKeymapDefaults: 'byte?',
    readKeymapLive: 'byte?',
    writeKeymapLive: 'byte?',
    readKeyPerf: 'byte?',
    writeKeyPerf: 'byte?',
    readCalibration: 'byte?',
    analogTestOn: 'byte?',
    analogTestOff: 'byte?',
    factoryReset: 'byte?',
  },
  event: {
    type: 'index',
    modifiers: 'index',
    usage: 'index',
    travelRaw: 'index',
    depth: 'index',
    direction: 'index',
    calState: 'index',
    scaleUnits: 'index',
    scaleTenths: 'index',
    scaleHundredths: 'index',
    travel: 'index',
    adc: 'index',
    adcBaseline: 'index',
    'kind.key': 'byte',
    'kind.fn': 'byte',
    fnSelector: 'byte',
    modifierBaseUsage: 'byte',
    defaultTravelCounts: 'size',
  },
  keyPerf: {
    recordSize: 'size',
    slots: 'size',
    'limits.rtMin': 'size',
    'limits.rtMax': 'size',
    'limits.deadZoneMin': 'count',
    'limits.deadZoneMax': 'size',
    'limits.actuationMin': 'size',
    'limits.actuationMax': 'size',
    'keyMode.off': 'byte',
    'keyMode.rapidTrigger': 'byte',
    'keyMode.fullStroke': 'byte',
  },
  keymap: {
    entrySize: 'size',
    slots: 'size',
    layers: 'size',
    layerBytes: 'size',
    defaultsBlobSize: 'size',
    plainKey: 'byte',
    layerKey: 'byte',
    fnSelector: 'byte',
    modifierBaseUsage: 'byte',
  },
  global: {
    length: 'size',
    'offsets.rate': 'index',
    'offsets.deadZone': 'index',
    'offsets.gameLock': 'index',
    'offsets.flags': 'index',
    'offsets.sleep': 'index',
    'offsets.activeLayer': 'index?',
    'flags.tachyon': 'byte',
    'flags.bottomOutTrigger': 'byte',
    'flags.actuationCheck': 'byte',
    'flags.magnetTest': 'byte',
    'flags.debounceShift': 'count',
    'flags.debounceMask': 'byte',
    settleMs: 'count',
    'factoryDefaults.reportRate': 'byte',
    'factoryDefaults.tickRate': 'byte',
    'factoryDefaults.deadZone': 'byte',
    'factoryDefaults.flags': 'byte',
    'factoryDefaults.debounceLevel': 'byte',
    'factoryDefaults.sleepMinutes': 'byte',
  },
  monitor: { rearmMs: 'size', ackMs: 'size' },
  factoryReset: { firstWaitMs: 'count', secondWaitMs: 'count' },
  calibration: { records: 'size', recordSize: 'size' },
  encoding: { countsPerMm: 'size' },
  profileSupport: { count: 'count', hostSwitchable: 'bool', kind: 'string' },
  slotMap: { resolveTolerance: 'count' },
}

/** Fields whose value is a list, checked by hand below rather than as a leaf. */
const LIST_FIELDS: readonly [string, string][] = [
  ['slotMap', 'unusedSlots'],
  ['profileSupport', 'scope'],
]

type LeafKind = 'byte' | 'byte?' | 'index' | 'index?' | 'size' | 'count' | 'bool' | 'string'

const TOP_LEVEL = new Set([
  'id',
  'name',
  'notes',
  'basedOn',
  'confidence',
  'usb',
  'layout',
  'switchTypes',
  'reportRates',
  'requestTimeoutMs',
  ...Object.keys(SECTIONS),
])

/**
 * Reads one JSON value into a spec, or explains why it cannot.
 *
 * `source` is only used in messages — the file the object came from, so an
 * error names something the author can open.
 */
export function validateSpec(input: unknown, source: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const at = (field: string) => `${source}: ${field}`

  if (!isObject(input)) return { errors: [`${source}: not a JSON object`], warnings }

  // JSON has no comments, and a definition is a file people edit by hand with a
  // byte table open beside them. A key starting with `//` is a note, at any
  // depth: dropped here, so nothing below has to know about it.
  const raw = stripComments(input)

  for (const key of Object.keys(raw)) {
    if (key === 'labelKey' || key === 'notesKey') {
      // Not a nitpick: the message keys are compiled from the reference bundle,
      // so a key named here would render as itself. `name` and `notes` are the
      // fields that work for a board this app does not ship.
      errors.push(at(`${key} is for built-in specs only — use name / notes instead`))
      continue
    }
    if (!TOP_LEVEL.has(key)) errors.push(at(`unknown field "${key}"`))
  }

  if (typeof raw.id !== 'string' || raw.id.trim() === '') errors.push(at('id must be a name'))
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push(at('name must be a name'))
  }
  if (typeof raw.confidence !== 'string' || !CONFIDENCE.includes(raw.confidence)) {
    errors.push(at(`confidence must be one of ${CONFIDENCE.join(', ')}`))
  }
  // The one field with nothing to do with syntax. A JSON spec is a partial one
  // — everything it leaves out is the Raven61's framing, command bytes and
  // block sizes — so it has to say out loud that its board speaks that
  // protocol. Nothing here can check the claim; refusing to guess it is the
  // whole point.
  if (raw.basedOn !== BASE_PROTOCOL_ID) {
    errors.push(
      at(
        `basedOn must be "${BASE_PROTOCOL_ID}" — a JSON definition inherits that board's protocol ` +
          `(framing, command bytes, block sizes), so it has to say so. Only set it once your board ` +
          `has actually answered those commands.`,
      ),
    )
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    errors.push(at('notes must be text'))
  }
  if (raw.requestTimeoutMs !== undefined) {
    checkLeaf(raw.requestTimeoutMs, 'size', at('requestTimeoutMs'), errors)
  }

  checkUsb(raw.usb, at, errors)
  checkLayout(raw.layout, at, errors, warnings)
  checkTables(raw, at, errors)

  for (const [section, leaves] of Object.entries(SECTIONS)) {
    const value = raw[section]
    if (value === undefined) continue
    if (!isObject(value)) {
      errors.push(at(`${section} must be an object`))
      continue
    }
    checkSection(section, value, leaves, at, errors)
  }

  if (errors.length > 0) return { errors, warnings }

  const spec = mergeSpec(FAMILY_BASELINE, { ...raw, origin: 'user-json' })
  errors.push(...checkConsistency(spec, at))
  if (errors.length > 0) return { errors, warnings }
  return { spec, errors, warnings }
}

function checkUsb(usb: unknown, at: (f: string) => string, errors: string[]): void {
  if (!isObject(usb)) {
    errors.push(at('usb must be { vendorId, productIds }'))
    return
  }
  for (const key of Object.keys(usb)) {
    if (key !== 'vendorId' && key !== 'productIds') {
      errors.push(at(`unknown field "usb.${key}"`))
    }
  }
  checkLeaf(usb.vendorId, 'size', at('usb.vendorId'), errors)
  // Required, and required to be non-empty: a spec with no product id would
  // match nothing, and there is no "whole vendor" option to fall back on.
  if (!Array.isArray(usb.productIds) || usb.productIds.length === 0) {
    errors.push(at('usb.productIds must list at least one product id this board reports'))
  } else {
    usb.productIds.forEach((id, i) => checkLeaf(id, 'size', at(`usb.productIds[${i}]`), errors))
  }
}

function checkLayout(
  layout: unknown,
  at: (f: string) => string,
  errors: string[],
  warnings: string[],
): void {
  if (!isObject(layout)) {
    errors.push(at('layout must be { units, travelMm, keys }'))
    return
  }
  if (!isObject(layout.units)) errors.push(at('layout.units must be { width, height }'))
  else {
    checkLeaf(layout.units.width, 'size', at('layout.units.width'), errors)
    checkLeaf(layout.units.height, 'size', at('layout.units.height'), errors)
  }
  checkLeaf(layout.travelMm, 'size', at('layout.travelMm'), errors)

  if (!Array.isArray(layout.keys) || layout.keys.length === 0) {
    errors.push(at('layout.keys must be a non-empty list'))
    return
  }
  const seenIndex = new Set<number>()
  const seenUsage = new Map<number, string>()
  layout.keys.forEach((key, i) => {
    const where = at(`layout.keys[${i}]`)
    if (!isObject(key)) {
      errors.push(`${where} must be an object`)
      return
    }
    for (const field of ['index', 'code', 'x', 'y', 'w', 'keyIndex', 'lightIndex'] as const) {
      checkLeaf(key[field], 'count', `${where}.${field}`, errors)
    }
    if (typeof key.label !== 'string') errors.push(`${where}.label must be text`)
    const index = key.index
    if (typeof index === 'number') {
      if (index !== i) {
        // The index is what every selection, every config array and every write
        // is keyed by. Out of order it is not a label, it is a wrong key.
        errors.push(`${where}.index is ${index}, but it is entry ${i} of the list`)
      }
      if (seenIndex.has(index)) errors.push(`${where}.index ${index} is used twice`)
      seenIndex.add(index)
    }
    if (typeof key.code === 'number' && typeof key.label === 'string') {
      const first = seenUsage.get(key.code)
      if (first !== undefined) {
        // Legal, and how a slot map loses a key: `slotMapFromKeymap` resolves a
        // usage to the first key that claims it.
        warnings.push(
          `${where}: HID usage 0x${key.code.toString(16)} is already used by "${first}" — the slot map will resolve it to that key`,
        )
      } else {
        seenUsage.set(key.code, key.label)
      }
    }
  })
}

/**
 * The fields a row of each table may carry.
 *
 * Checked rather than ignored because both tables are shown to a user as
 * though somebody had checked them, and a misspelt optional field is the
 * quietest possible failure: `"colour"` does not paint, and nothing anywhere
 * says why. Notes are still allowed — a `//` key is stripped before this runs.
 */
const SWITCH_FIELDS = new Set([
  'value',
  'name',
  'travelMm',
  'selectable',
  'vendor',
  'magnetGauss',
  'color',
])
const RATE_FIELDS = new Set(['value', 'hz'])

function checkRowFields(
  row: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  errors: string[],
): void {
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) errors.push(`${where}: unknown field "${key}"`)
  }
}

function checkTables(raw: Record<string, unknown>, at: (f: string) => string, errors: string[]) {
  if (raw.switchTypes !== undefined) {
    if (!Array.isArray(raw.switchTypes)) errors.push(at('switchTypes must be a list'))
    else
      raw.switchTypes.forEach((s, i) => {
        const where = at(`switchTypes[${i}]`)
        if (!isObject(s)) return void errors.push(`${where} must be an object`)
        checkRowFields(s, SWITCH_FIELDS, where, errors)
        checkLeaf(s.value, 'byte', `${where}.value`, errors)
        checkLeaf(s.travelMm, 'size', `${where}.travelMm`, errors)
        if (typeof s.name !== 'string') errors.push(`${where}.name must be text`)
        if (typeof s.selectable !== 'boolean') errors.push(`${where}.selectable must be true/false`)
        // Descriptive, and both optional: a table recovered from a driver
        // binary carries neither, so absent is the normal case. Present and
        // wrong is not — a swatch that never paints, or a magnet figure in
        // millitesla sitting in a gauss column, is read as fact.
        if (s.vendor !== undefined && typeof s.vendor !== 'string') {
          errors.push(`${where}.vendor must be text`)
        }
        if (s.magnetGauss !== undefined) checkLeaf(s.magnetGauss, 'size', `${where}.magnetGauss`, errors)
        if (s.color !== undefined && !isHexColor(s.color)) {
          errors.push(`${where}.color must be a hex colour like "#f08a3c"`)
        }
      })
  }
  if (raw.reportRates !== undefined) {
    if (!Array.isArray(raw.reportRates)) errors.push(at('reportRates must be a list'))
    else
      raw.reportRates.forEach((r, i) => {
        const where = at(`reportRates[${i}]`)
        if (!isObject(r)) return void errors.push(`${where} must be an object`)
        checkRowFields(r, RATE_FIELDS, where, errors)
        checkLeaf(r.value, 'byte', `${where}.value`, errors)
        checkLeaf(r.hz, 'size', `${where}.hz`, errors)
      })
  }
}

function checkSection(
  section: string,
  value: Record<string, unknown>,
  leaves: Record<string, LeafKind>,
  at: (f: string) => string,
  errors: string[],
): void {
  const known = new Set<string>()
  for (const path of Object.keys(leaves)) known.add(path.split('.')[0]!)
  // The two list-valued fields, which have no entry in the leaf table above.
  for (const [owner, field] of LIST_FIELDS) if (owner === section) known.add(field)
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(at(`unknown field "${section}.${key}"`))
  }
  for (const [path, kind] of Object.entries(leaves)) {
    const found = readPath(value, path)
    if (found === undefined) continue
    checkLeaf(found, kind, at(`${section}.${path}`), errors)
  }
  // `slotMap.unusedSlots` and `profileSupport.scope` are lists, so they sit
  // outside the leaf table.
  if (section === 'slotMap' && value.unusedSlots !== undefined) {
    if (!Array.isArray(value.unusedSlots)) errors.push(at('slotMap.unusedSlots must be a list'))
    else
      value.unusedSlots.forEach((s, i) =>
        checkLeaf(s, 'count', at(`slotMap.unusedSlots[${i}]`), errors),
      )
  }
  if (section === 'profileSupport' && value.scope !== undefined) {
    if (!Array.isArray(value.scope)) errors.push(at('profileSupport.scope must be a list'))
  }
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (!isObject(current)) return undefined
    current = current[part]
  }
  return current
}

function checkLeaf(value: unknown, kind: LeafKind, where: string, errors: string[]): void {
  if (kind === 'bool') {
    if (typeof value !== 'boolean') errors.push(`${where} must be true or false`)
    return
  }
  if (kind === 'string') {
    if (typeof value !== 'string') errors.push(`${where} must be text`)
    return
  }
  const optional = kind.endsWith('?')
  if (value === null) {
    if (!optional) errors.push(`${where} may not be null on this board`)
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where} must be a number`)
    return
  }
  const base = optional ? kind.slice(0, -1) : kind
  if (base === 'byte' && (!Number.isInteger(value) || value < 0 || value > 0xff)) {
    errors.push(`${where} must be a byte, 0-255`)
  }
  if (base === 'index' && (!Number.isInteger(value) || value < 0 || value > 0xffff)) {
    errors.push(`${where} must be a whole byte offset`)
  }
  if (base === 'size' && (!(value > 0) || !Number.isFinite(value))) {
    errors.push(`${where} must be greater than zero`)
  }
  if (base === 'count' && (!Number.isFinite(value) || value < 0)) {
    errors.push(`${where} must be zero or more`)
  }
}

/**
 * The checks that only make sense once the spec is whole: sizes that have to
 * agree with each other.
 *
 * Each of these is a mistake that would otherwise show up as a truncated read
 * or a packet the board ignores, hours later.
 */
function checkConsistency(spec: DeviceSpec, at: (f: string) => string): string[] {
  const errors: string[] = []
  const f = spec.frame
  if (f.block.data >= f.payloadLength) {
    errors.push(at('frame.block.data leaves no room for chunk data in the payload'))
  }
  if (f.offsets.data >= f.payloadLength) {
    errors.push(at('frame.offsets.data is past the end of the payload'))
  }
  if (spec.global.length > f.payloadLength) {
    errors.push(
      at(`global.length (${spec.global.length}) is more than one ${f.payloadLength}-byte payload`),
    )
  }
  for (const [name, offset] of Object.entries(spec.global.offsets)) {
    if (offset !== null && offset >= spec.global.length) {
      errors.push(at(`global.offsets.${name} (${offset}) is outside the block it reads`))
    }
  }
  const layerFits = spec.keymap.slots * spec.keymap.entrySize <= spec.keymap.layerBytes
  if (!layerFits) {
    errors.push(
      at(
        `keymap.slots x keymap.entrySize (${spec.keymap.slots * spec.keymap.entrySize}) does not fit in keymap.layerBytes (${spec.keymap.layerBytes})`,
      ),
    )
  }
  if (spec.layout.keys.length > spec.keyPerf.slots) {
    errors.push(
      at(
        `layout has ${spec.layout.keys.length} keys but keyPerf.slots is ${spec.keyPerf.slots} — the block cannot hold them`,
      ),
    )
  }
  if (spec.layout.keys.length > spec.keymap.slots) {
    errors.push(
      at(
        `layout has ${spec.layout.keys.length} keys but keymap.slots is ${spec.keymap.slots} — the block cannot hold them`,
      ),
    )
  }
  if (spec.slotMap.resolveTolerance >= spec.layout.keys.length) {
    errors.push(
      at('slotMap.resolveTolerance is at least the key count, so any read would be trusted'),
    )
  }
  return errors
}

/** Drops every `//`-prefixed key, at every depth, leaving arrays alone. */
function stripComments(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (key.startsWith('//')) continue
    out[key] = stripNested(field)
  }
  return out
}

/**
 * Into lists as well as objects.
 *
 * The lists are where a note is most wanted — one row of a switch table or a
 * key table, saying what that row is and who measured it — and a note that
 * only worked at the top of the file would push every annotation away from the
 * thing it annotates.
 */
function stripNested(field: unknown): unknown {
  if (Array.isArray(field)) return field.map(stripNested)
  return isObject(field) ? stripComments(field) : field
}

/**
 * Hex only, rather than anything a browser would accept.
 *
 * The value ends up as an inline background, and this is the one field in a
 * definition that is painted rather than sent. Keeping it to six digits means
 * a definition cannot reach anywhere else through the style attribute, and a
 * misspelt colour name is caught here instead of rendering as nothing.
 */
function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
