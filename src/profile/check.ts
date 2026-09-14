/**
 * What stands between a file and a write to someone's keyboard flash.
 *
 * A profile is a file. It may have been written by an older build, edited by
 * hand, taken from another board, or produced by the stock driver — and every
 * one of those paths ends at `writeKeyPerf`, which puts bytes in flash. So each
 * block is checked against the *live* spec before it is offered: lengths
 * against the layout's key count, values against the field widths the encoder
 * saturates at, record types against what the keymap codec can encode, blob
 * sizes against the tables they go back into.
 *
 * ## Errors disable a block; warnings do not
 *
 * The split is about what the write would do, not about how odd the file looks.
 *
 * An **error** means applying this block would write something wrong — an array
 * that is not as long as the board has keys, a macro body the player would run
 * off the end of, a colour table sized for a different board. The dialog
 * refuses to tick it.
 *
 * A **warning** means the block will write correctly and something about it is
 * worth saying first: a different board, an unknown switch type, a value this
 * app will saturate on the way out. Ticking it is the user's call.
 *
 * Nothing here judges whether the settings are *good*. A 0.1 mm actuation is a
 * strange thing to want and a perfectly valid thing to write.
 */

import type { DeviceSpec } from '../device/spec'
import { encodeRecord } from '../protocol/keymap'
import { macroEventsStored, macroEventBudget, MACRO_MAX_DELAY_MS } from '../protocol/macros'
import { advancedBlobSize } from '../protocol/advancedKeys'
import { LIGHT_MODE_OFF } from '../protocol/lighting'
import { mmToCounts } from '../protocol/encoding'
import { t } from '../i18n'
import {
  PROFILE_BLOCKS,
  PROFILE_VERSION,
  fromBase64,
  type ProfileBlock,
  type ProfileDocument,
} from './model'

export interface BlockReport {
  block: ProfileBlock
  /** False when the file does not carry this block at all. */
  present: boolean
  /** Whether it may be written. False when `errors` is non-empty. */
  applicable: boolean
  errors: string[]
  warnings: string[]
  /** A short count for the row — "61 keys", "4 layers", "3 macros". */
  summary: string
}

export interface ProfileReport {
  /** Set when the file cannot be used at all; the blocks are then not checked. */
  fatal: string | null
  /** About the board the file came from, not about any one block. */
  deviceWarnings: string[]
  blocks: BlockReport[]
}

function report(block: ProfileBlock, present: boolean): BlockReport {
  return { block, present, applicable: false, errors: [], warnings: [], summary: '' }
}

/** Finishes a row: a block with no errors and something in it may be written. */
function settle(row: BlockReport): BlockReport {
  row.applicable = row.present && row.errors.length === 0
  return row
}

/**
 * Checks a document against the board a write would go to.
 *
 * `spec` is the live one — the board that is plugged in now — not whatever the
 * file says it was taken from. That is the whole point: the file's own claim
 * about itself is the thing being checked.
 */
export function checkProfile(doc: ProfileDocument, spec: DeviceSpec): ProfileReport {
  const deviceWarnings: string[] = []

  if (!Number.isInteger(doc.version) || doc.version < 1) {
    return { fatal: t('profile.check.badVersion'), deviceWarnings, blocks: [] }
  }
  if (doc.version > PROFILE_VERSION) {
    return {
      fatal: t('profile.check.newer', { version: doc.version, supported: PROFILE_VERSION }),
      deviceWarnings,
      blocks: [],
    }
  }

  const keys = spec.layout.keys.length

  if (doc.device.specId !== spec.id) {
    deviceWarnings.push(t('profile.check.otherSpec', { from: doc.device.name || doc.device.specId }))
  } else if (doc.device.productId !== spec.usb.productIds[0]) {
    deviceWarnings.push(
      t('profile.check.otherProduct', { from: hex(doc.device.productId), to: hex(spec.usb.productIds[0] ?? 0) }),
    )
  }
  if (doc.device.keyCount !== keys) {
    deviceWarnings.push(t('profile.check.otherKeyCount', { from: doc.device.keyCount, to: keys }))
  }

  const blocks = PROFILE_BLOCKS.map((block) => checkBlock(block, doc, spec, keys))
  return { fatal: null, deviceWarnings, blocks }
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
}

function checkBlock(
  block: ProfileBlock,
  doc: ProfileDocument,
  spec: DeviceSpec,
  keys: number,
): BlockReport {
  switch (block) {
    case 'keyPerf':
      return checkKeyPerf(doc, spec, keys)
    case 'keymap':
      return checkKeymap(doc, spec, keys)
    case 'macros':
      return checkMacros(doc, spec)
    case 'advancedKeys':
      return checkAdvancedKeys(doc, spec)
    case 'keyRgb':
      return checkKeyRgb(doc, keys)
    case 'global':
      return checkGlobal(doc, spec)
  }
}

function checkKeyPerf(doc: ProfileDocument, spec: DeviceSpec, keys: number): BlockReport {
  const row = report('keyPerf', doc.blocks.keyPerf !== undefined)
  const configs = doc.blocks.keyPerf
  if (!configs) return row
  row.summary = t('profile.summary.keys', { count: configs.length })

  if (configs.length !== keys) {
    row.errors.push(t('profile.check.length', { got: configs.length, want: keys }))
    return settle(row)
  }

  const { limits } = spec.keyPerf
  const cpm = spec.encoding.countsPerMm
  const travel = spec.layout.travelMm
  let saturated = 0
  let noSwitch = 0
  const unknownSwitch = new Set<number>()

  for (const [index, cfg] of configs.entries()) {
    if (!cfg || typeof cfg !== 'object') {
      row.errors.push(t('profile.check.keyBad', { index }))
      return settle(row)
    }
    if (!Number.isFinite(cfg.actuationMm) || cfg.actuationMm < 0) {
      row.errors.push(t('profile.check.keyBad', { index }))
      return settle(row)
    }
    if (cfg.mode !== 'normal' && cfg.mode !== 'rapidTrigger') {
      row.errors.push(t('profile.check.keyBad', { index }))
      return settle(row)
    }
    // Out-of-range is a warning rather than an error: the encoder saturates,
    // so the write is well formed — it just will not be the number in the file.
    const counts = mmToCounts(cfg.actuationMm, cpm)
    if (counts < limits.actuationMin || counts > limits.actuationMax) saturated++
    else if (cfg.actuationMm > travel) saturated++
    const rt = cfg.rapidTrigger
    if (rt) {
      const p = mmToCounts(rt.pressMm, cpm)
      const r = mmToCounts(rt.releaseMm, cpm)
      if (p < limits.rtMin || p > limits.rtMax || r < limits.rtMin || r > limits.rtMax) saturated++
    }
    const dz = cfg.deadZone
    if (dz) {
      const top = mmToCounts(dz.topMm, cpm)
      const bottom = mmToCounts(dz.bottomMm, cpm)
      if (
        top < limits.deadZoneMin ||
        top > limits.deadZoneMax ||
        bottom < limits.deadZoneMin ||
        bottom > limits.deadZoneMax
      ) {
        saturated++
      }
    }
    if (cfg.switchType === undefined) noSwitch++
    else if (!spec.switchTypes.some((s) => s.value === cfg.switchType)) {
      unknownSwitch.add(cfg.switchType)
    }
  }

  if (saturated > 0) row.warnings.push(t('profile.check.saturate', { count: saturated }))
  /*
   * A config with no switch type is one that was never read off a board — the
   * factory-default fill. Writing it announces switch type 0 for that key,
   * which is a real change to a real field, so it is said out loud.
   */
  if (noSwitch > 0) row.warnings.push(t('profile.check.noSwitch', { count: noSwitch }))
  if (unknownSwitch.size > 0) {
    row.warnings.push(
      t('profile.check.unknownSwitch', { types: [...unknownSwitch].sort((a, b) => a - b).join(', ') }),
    )
  }
  return settle(row)
}

function checkKeymap(doc: ProfileDocument, spec: DeviceSpec, keys: number): BlockReport {
  const row = report('keymap', doc.blocks.keymap !== undefined)
  const layers = doc.blocks.keymap
  if (!layers) return row
  row.summary = t('profile.summary.layers', { count: layers.length })

  if (layers.length === 0) {
    row.errors.push(t('profile.check.noLayers'))
    return settle(row)
  }

  const seen = new Set<number>()
  let unresolved = 0
  for (const layer of layers) {
    if (!Number.isInteger(layer.layer) || layer.layer < 0 || layer.layer >= spec.keymap.layers) {
      row.errors.push(t('profile.check.layerRange', { layer: layer.layer, max: spec.keymap.layers - 1 }))
      return settle(row)
    }
    if (seen.has(layer.layer)) {
      row.errors.push(t('profile.check.layerDup', { layer: layer.layer }))
      return settle(row)
    }
    seen.add(layer.layer)
    if (layer.entries.length !== keys) {
      row.errors.push(t('profile.check.layerLength', { layer: layer.layer, got: layer.entries.length, want: keys }))
      return settle(row)
    }
    for (const [index, binding] of layer.entries.entries()) {
      if (binding === null) {
        unresolved++
        continue
      }
      /*
       * The encoder is the check. It is the same function the write uses, so
       * anything it refuses is a record that would have gone out wrong — and
       * anything it accepts is three bytes, whatever this app thinks of them.
       */
      let bytes: [number, number, number]
      try {
        bytes = encodeRecord(binding)
      } catch {
        row.errors.push(t('profile.check.bindingBad', { layer: layer.layer, index }))
        return settle(row)
      }
      if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 0xff)) {
        row.errors.push(t('profile.check.bindingBad', { layer: layer.layer, index }))
        return settle(row)
      }
      if (binding.kind === 'macro' && binding.slot >= spec.macros.slots) {
        row.errors.push(t('profile.check.macroSlotRange', { slot: binding.slot, max: spec.macros.slots - 1 }))
        return settle(row)
      }
      if (binding.kind === 'advanced' && binding.record >= spec.advancedKeys.records) {
        row.errors.push(
          t('profile.check.advRecordRange', { record: binding.record, max: spec.advancedKeys.records - 1 }),
        )
        return settle(row)
      }
      if (binding.kind === 'unknown') {
        row.warnings.push(t('profile.check.unknownBinding', { layer: layer.layer, index }))
      }
    }
  }
  if (unresolved > 0) row.warnings.push(t('profile.check.unresolved', { count: unresolved }))
  if (seen.size < spec.keymap.layers) {
    row.warnings.push(t('profile.check.partialLayers', { got: seen.size, want: spec.keymap.layers }))
  }
  return settle(row)
}

function checkMacros(doc: ProfileDocument, spec: DeviceSpec): BlockReport {
  const row = report('macros', doc.blocks.macros !== undefined)
  const macros = doc.blocks.macros
  if (!macros) return row

  const used = macros.filter((m) => m.events.length > 0).length
  row.summary = t('profile.summary.macros', { count: used })

  const seen = new Set<number>()
  for (const macro of macros) {
    if (!Number.isInteger(macro.slot) || macro.slot < 0 || macro.slot >= spec.macros.slots) {
      row.errors.push(t('profile.check.macroSlotRange', { slot: macro.slot, max: spec.macros.slots - 1 }))
      return settle(row)
    }
    if (seen.has(macro.slot)) {
      row.errors.push(t('profile.check.macroDup', { slot: macro.slot }))
      return settle(row)
    }
    seen.add(macro.slot)
    if (!Array.isArray(macro.events)) {
      row.errors.push(t('profile.check.macroBad', { slot: macro.slot }))
      return settle(row)
    }
    for (const event of macro.events) {
      if (!Number.isInteger(event.delayMs) || event.delayMs < 0 || event.delayMs > MACRO_MAX_DELAY_MS) {
        row.errors.push(t('profile.check.macroDelay', { slot: macro.slot, max: MACRO_MAX_DELAY_MS }))
        return settle(row)
      }
      const action = event.action
      const bad =
        action.kind === 'key'
          ? !byte(action.usage)
          : action.kind === 'modifiers'
            ? !byte(action.mask)
            : action.kind === 'unknown'
              ? !byte(action.value) || !Number.isInteger(action.nibble)
              : true
      if (bad) {
        row.errors.push(t('profile.check.macroBad', { slot: macro.slot }))
        return settle(row)
      }
    }
  }

  /*
   * The store is written whole — all 32 slots, offsets and stop records laid
   * out together — so what has to fit is the sum, not any one body. Over the
   * budget the encoder would run out of region, and a body without a stop
   * record makes *every* macro key on the board unsafe, not just that slot's.
   */
  const stored = macroEventsStored(macros, spec.macros)
  const budget = macroEventBudget(spec.macros)
  if (stored > budget) {
    row.errors.push(t('profile.check.macroBudget', { stored, budget }))
  }
  return settle(row)
}

function byte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff
}

function checkAdvancedKeys(doc: ProfileDocument, spec: DeviceSpec): BlockReport {
  const row = report('advancedKeys', doc.blocks.advancedKeys !== undefined)
  const blobs = doc.blocks.advancedKeys
  if (!blobs) return row
  row.summary = t('profile.summary.tables')

  for (const block of ['dks', 'pair', 'toggle'] as const) {
    const bytes = typeof blobs[block] === 'string' ? fromBase64(blobs[block]) : null
    if (!bytes) {
      row.errors.push(t('profile.check.blobBad', { table: block }))
      return settle(row)
    }
    const want = advancedBlobSize(block, spec.advancedKeys)
    if (bytes.length !== want) {
      row.errors.push(t('profile.check.blobSize', { table: block, got: bytes.length, want }))
      return settle(row)
    }
  }
  return settle(row)
}

function checkKeyRgb(doc: ProfileDocument, keys: number): BlockReport {
  const row = report('keyRgb', doc.blocks.keyRgb !== undefined)
  const colors = doc.blocks.keyRgb
  if (!colors) return row
  row.summary = t('profile.summary.keys', { count: colors.length })

  if (colors.length !== keys) {
    row.errors.push(t('profile.check.length', { got: colors.length, want: keys }))
    return settle(row)
  }
  for (const [index, color] of colors.entries()) {
    if (color === null) continue
    if (!byte(color.r) || !byte(color.g) || !byte(color.b)) {
      row.errors.push(t('profile.check.colorBad', { index }))
      return settle(row)
    }
  }
  return settle(row)
}

function checkGlobal(doc: ProfileDocument, spec: DeviceSpec): BlockReport {
  const row = report('global', doc.blocks.global !== undefined)
  const patch = doc.blocks.global
  if (!patch) return row
  row.summary = t('profile.summary.fields', { count: Object.keys(patch).length })

  if (patch.reportRate !== undefined) {
    if (!spec.reportRates.some((r) => r.value === patch.reportRate)) {
      row.errors.push(t('profile.check.rateUnknown', { value: patch.reportRate }))
      return settle(row)
    }
    /*
     * Not an error, and the one warning here that is about what happens next
     * rather than about the file: the rate the board enumerates at is the rate
     * the host polls it at, so changing it can take the WebHID handle with it.
     */
  }
  if (patch.debounceLevel !== undefined) {
    if (!Number.isInteger(patch.debounceLevel) || patch.debounceLevel < 0 || patch.debounceLevel > 3) {
      row.errors.push(t('profile.check.debounceRange', { value: patch.debounceLevel }))
      return settle(row)
    }
  }
  const lighting = patch.lighting
  if (lighting) {
    if (!spec.lightEffects) {
      row.warnings.push(t('profile.check.noEffectTable'))
    } else if (
      lighting.lightMode !== undefined &&
      lighting.lightMode !== LIGHT_MODE_OFF &&
      !spec.lightEffects.some((e) => e.mode === lighting.lightMode)
    ) {
      row.warnings.push(t('profile.check.modeUnknown', { mode: lighting.lightMode }))
    }
    if (lighting.brightness !== undefined && (lighting.brightness < 0 || lighting.brightness > 100)) {
      row.errors.push(t('profile.check.brightnessRange', { value: lighting.brightness }))
      return settle(row)
    }
  }
  return settle(row)
}

/** True when at least one block can be written. */
export function anyApplicable(report: ProfileReport): boolean {
  return report.blocks.some((b) => b.applicable)
}
