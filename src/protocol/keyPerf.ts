/**
 * The per-key performance blob: command 0xa0 reads it, 0xa1 writes it.
 *
 * 1024 bytes, 8 per key slot, indexed by the key's **position in the layout
 * XML's key list** — which is this project's `KeyDef.index`, not `keyIndex` and
 * not the HID usage.
 *
 * The first version of this file used `keyIndex` and produced garbage: keys
 * whose `keyIndex` is 64 or above (the bottom two rows, Backspace, Enter) read
 * back as all zeros, and everything else showed another key's record. Two
 * findings settled it:
 *
 * - The stock driver's layout parser reads `key_index` and `light_index` from
 *   the XML and **throws both away** (0x42e9d8, 0x42ea1e: the atoi result is
 *   overwritten, never stored). Those two attribute names are referenced from
 *   exactly one place in the whole binary, so nothing else uses them either.
 *   `keyIndex` being the firmware address was an assumption, and a wrong one.
 * - On hardware, every slot at or above 61 came back zero, which is what a
 *   compact 0..60 assignment over a 61-key board looks like. Indexing by
 *   `keyIndex` predicts data up to slot 109; indexing by the XML's `row_col`
 *   (row * 16 + col) predicts data at 64-77. Both were empty.
 *
 * Established by reading the stock driver's decoder (0x427120) against its
 * encoder (0x42c390); the two are exact inverses, which is what makes the
 * layout below more than a guess. The 11 fields it decodes into line up
 * one-to-one with the columns of `t_key_perf_data`, and the factory-default
 * constants the binary carries at 0x582100 / 0x5820e0 read back as
 * `switch_type 3, key_mode 1, actuation 75, rt 5/5, dead zones 0` — the same
 * values the stock database holds.
 *
 *   rec[0]  bits 0-4  switch_type      (decoder masks with 0x1f)
 *           bits 5-7  device flags     (encoder ORs 0xa0 on some firmware)
 *   rec[1]            key_mode         0 off, 1 rapid trigger, 2 + full stroke
 *   rec[2..3] bits0-8 key_actuation - 1
 *   rec[4]
 *   rec[5]  bit 0     rt_press - 1     (bit 8 of the 9-bit value)
 *           bits 1-5  press_deadzone
 *   rec[6]
 *   rec[7]  bit 0     rt_release - 1
 *           bits 1-5  release_deadzone
 *
 * Two encoding quirks worth keeping in mind:
 *
 * - Values are stored with a **-1 offset**. 1.5 mm is 75 counts, which goes on
 *   the wire as 74. Reading adds it back.
 * - `deadzone_state` has no bit of its own. The decoder derives it from the two
 *   dead-zone fields being non-zero, and the encoder only writes them when the
 *   state is on, so the round trip is stable.
 */
import { countsToMm, mmToCounts } from './encoding'
import type { KeyConfig, KeyMode } from './types'

/** 128 slots of 8 bytes. Key indices reach 109, so 128 covers the board. */
export const KEY_PERF = {
  recordSize: 8,
  slots: 128,
  get blobSize() {
    return this.recordSize * this.slots
  },
} as const

/** `t_key_perf_data.key_mode`, as the wire stores it. */
export const KEY_MODE_WIRE = {
  /** Rapid trigger off. */
  off: 0,
  /** Rapid trigger, active between actuation and the bottom. */
  rapidTrigger: 1,
  /**
   * Rapid trigger that stays active for the rest of the stroke once the key has
   * been pressed past actuation — the stock UI's "full stroke quick trigger".
   *
   * Not a separate field: the stock driver folds its two toggles into this one
   * value at 0x43aa13, where the rapid-trigger toggle sets 1 and the
   * full-stroke toggle overrides it with 2.
   */
  fullStroke: 2,
} as const

/** A raw record, in the units the wire uses (0.02 mm counts). */
export interface KeyPerfRecord {
  /** `switch_type`, 0-7. See SWITCH_TYPES. */
  switchType: number
  /**
   * Bits 5-7 of rec[0]. The encoder sets 0xa0 here on some firmware
   * (`[this+0x798]`, gated on a device field) and the decoder throws them away,
   * so their meaning is unknown — they are preserved for an exact round trip.
   */
  switchFlags: number
  keyMode: number
  actuationCounts: number
  rtPressCounts: number
  rtReleaseCounts: number
  pressDeadzoneCounts: number
  releaseDeadzoneCounts: number
  /** Derived, not stored: true when either dead zone is non-zero. */
  deadzoneState: boolean
  /**
   * True when rec[4..7] are all 0xff, which is how the board marks a key whose
   * rapid-trigger and dead-zone values were never set.
   *
   * Decoding them literally gives 512-count sensitivities and 31-count dead
   * zones — values the UI would then show as a 0.62 mm dead zone on a key that
   * has none. The stock driver's performance tab shows nothing for those keys,
   * which is the giveaway.
   */
  rtUnset: boolean
}

const NINE_BITS = 0x1ff
const FIVE_BITS = 0x1f

/** Reads one 8-byte record out of the blob. */
export function decodeKeyPerfRecord(blob: ArrayLike<number>, slot: number): KeyPerfRecord {
  const at = slot * KEY_PERF.recordSize
  const b = (i: number) => blob[at + i] ?? 0
  const rtUnset = b(4) === 0xff && b(5) === 0xff && b(6) === 0xff && b(7) === 0xff
  const pressDeadzone = rtUnset ? 0 : (b(5) >> 1) & FIVE_BITS
  const releaseDeadzone = rtUnset ? 0 : (b(7) >> 1) & FIVE_BITS
  return {
    switchType: b(0) & FIVE_BITS,
    switchFlags: b(0) & ~FIVE_BITS & 0xff,
    keyMode: b(1),
    // +1 because the wire stores value - 1.
    actuationCounts: (((b(3) << 8) | b(2)) & NINE_BITS) + 1,
    rtPressCounts: rtUnset ? 0 : (((b(5) << 8) | b(4)) & NINE_BITS) + 1,
    rtReleaseCounts: rtUnset ? 0 : (((b(7) << 8) | b(6)) & NINE_BITS) + 1,
    pressDeadzoneCounts: pressDeadzone,
    releaseDeadzoneCounts: releaseDeadzone,
    deadzoneState: pressDeadzone > 0 || releaseDeadzone > 0,
    rtUnset,
  }
}

/**
 * Writes one record. Mirrors the encoder, including its clamps: rapid-trigger
 * sensitivities are forced to at least one count, and dead-zone bits are only
 * laid down when the dead zone is both enabled and non-zero.
 */
export function encodeKeyPerfRecord(rec: KeyPerfRecord): Uint8Array {
  const out = new Uint8Array(KEY_PERF.recordSize)
  const actuation = (Math.max(1, rec.actuationCounts) - 1) & NINE_BITS
  if (rec.rtUnset) {
    out[0] = (rec.switchType & FIVE_BITS) | (rec.switchFlags & 0xff & ~FIVE_BITS)
    out[1] = rec.keyMode & 0xff
    out[2] = actuation & 0xff
    out[3] = (actuation >> 8) & 0xff
    // Put the "never set" marker back rather than inventing sensitivities.
    out.fill(0xff, 4)
    return out
  }
  const press = (Math.max(1, rec.rtPressCounts) - 1) & NINE_BITS
  const release = (Math.max(1, rec.rtReleaseCounts) - 1) & NINE_BITS

  out[0] = (rec.switchType & FIVE_BITS) | (rec.switchFlags & 0xff & ~FIVE_BITS)
  out[1] = rec.keyMode & 0xff
  out[2] = actuation & 0xff
  out[3] = (actuation >> 8) & 0xff
  out[4] = press & 0xff
  out[5] = (press >> 8) & 0xff
  out[6] = release & 0xff
  out[7] = (release >> 8) & 0xff

  if (rec.deadzoneState) {
    if (rec.pressDeadzoneCounts > 0) {
      out[5] = ((rec.pressDeadzoneCounts & FIVE_BITS) << 1) | (out[5] & 1)
    }
    if (rec.releaseDeadzoneCounts > 0) {
      out[7] = ((rec.releaseDeadzoneCounts & FIVE_BITS) << 1) | (out[7] & 1)
    }
  }
  return out
}

/** Largest dead zone the 5-bit field can hold: 31 counts, 0.62 mm. */
export const MAX_DEADZONE_COUNTS = FIVE_BITS

/** Turns a wire record into the millimetre model the UI edits. */
export function toKeyConfig(rec: KeyPerfRecord): KeyConfig {
  const mode: KeyMode = rec.keyMode === KEY_MODE_WIRE.off ? 'normal' : 'rapidTrigger'
  return {
    actuationMm: countsToMm(rec.actuationCounts),
    mode,
    rapidTrigger: {
      enabled: rec.keyMode !== KEY_MODE_WIRE.off,
      pressMm: countsToMm(rec.rtPressCounts),
      releaseMm: countsToMm(rec.rtReleaseCounts),
      // UI-only. Showing the two values as one would hide a board that has them
      // set differently, so it follows the data rather than defaulting.
      separate: rec.rtPressCounts !== rec.rtReleaseCounts,
      continuous: rec.keyMode === KEY_MODE_WIRE.fullStroke,
    },
    deadZone: {
      enabled: rec.deadzoneState,
      topMm: countsToMm(rec.pressDeadzoneCounts),
      bottomMm: countsToMm(rec.releaseDeadzoneCounts),
    },
    switchType: rec.switchType,
    switchFlags: rec.switchFlags,
    rtUnset: rec.rtUnset,
  }
}

/**
 * And back. `switchFlags` defaults to 0 rather than to the 0xa0 the stock
 * driver sometimes sets — writing bits whose meaning is unknown, without having
 * read them off this board first, is not something to do blind.
 */
export function fromKeyConfig(config: KeyConfig): KeyPerfRecord {
  const rt = config.rapidTrigger
  const keyMode = !rt.enabled
    ? KEY_MODE_WIRE.off
    : rt.continuous
      ? KEY_MODE_WIRE.fullStroke
      : KEY_MODE_WIRE.rapidTrigger
  return {
    switchType: config.switchType ?? 0,
    switchFlags: config.switchFlags ?? 0,
    keyMode,
    actuationCounts: mmToCounts(config.actuationMm),
    rtPressCounts: mmToCounts(rt.pressMm),
    rtReleaseCounts: mmToCounts(rt.separate ? rt.releaseMm : rt.pressMm),
    pressDeadzoneCounts: mmToCounts(config.deadZone.topMm),
    releaseDeadzoneCounts: mmToCounts(config.deadZone.bottomMm),
    deadzoneState: config.deadZone.enabled,
    rtUnset: config.rtUnset === true && !rt.enabled && !config.deadZone.enabled,
  }
}

/**
 * True for a slot no key is wired to. The firmware leaves those at zero, and a
 * zeroed record decodes to actuation 1 count with rapid trigger off — plausible
 * enough to be mistaken for a real setting if it were shown.
 */
export function isEmptySlot(blob: ArrayLike<number>, slot: number): boolean {
  const at = slot * KEY_PERF.recordSize
  for (let i = 0; i < KEY_PERF.recordSize; i++) {
    if ((blob[at + i] ?? 0) !== 0) return false
  }
  return true
}
