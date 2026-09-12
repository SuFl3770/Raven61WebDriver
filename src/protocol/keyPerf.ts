/**
 * The per-key performance blob: command 0xa0 reads it, 0xa1 writes it.
 *
 * 1024 bytes, 8 per slot, 128 slots. **The index is a hardware slot number, not
 * a key index of any kind** — see slotMap.ts, which reads the slot assignment
 * off the board because it cannot be computed. Two cuts of this file got that
 * wrong before the board settled it:
 *
 * - `keyIndex` from the layout XML. The stock driver's parser reads `key_index`
 *   and `light_index` and **throws both away** (0x42e9d8, 0x42ea1e: the atoi
 *   result is overwritten, never stored), and those attribute names are
 *   referenced from exactly one place in the whole binary. Keys whose
 *   `keyIndex` is 64 or above read back as zeros and the rest showed another
 *   key's record.
 * - Layout order, this project's `KeyDef.index`. Closer — 61 records do live in
 *   slots 0..63 — but a hardware dump has holes at 12, 20 and 53, so the space
 *   is 64 wide with three unused channels and the assignment is board wiring.
 *
 * The record layout itself was established by reading the stock driver's
 * decoder (0x427120) against its encoder (0x42c390); the two are exact
 * inverses, which is what makes it more than a guess. The 11 fields it decodes
 * into line up one-to-one with the columns of `t_key_perf_data`, and the
 * factory-default constants the binary carries at 0x582100 / 0x5820e0 read back
 * as `switch_type 3, key_mode 1, actuation 75, rt 5/5, dead zones 0` — the same
 * values the stock database holds. Confirmed against hardware afterwards: the
 * stock driver's own screen showed 2.60 / 1.04 / 1.24 mm for the values decoded
 * here.
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
import type { KeyPerfSpec } from '../device/spec'
import { countsToMm, mmToCounts } from './encoding'
import type { KeyConfig, KeyMode } from './types'

/**
 * 128 slots of 8 bytes. The board uses 64 of them; the block is 128 wide.
 */
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
  /**
   * `rec[1]`, kept whole — it is two nibbles.
   *
   * The low nibble is the rapid-trigger mode above, which is what the stock
   * driver's performance tab builds and what the scan reads at 0xf098. The
   * high nibble is the key's **SOCD resolution mode**: the scan pulls it out
   * with `>> 12` and hands it to the advanced-key runtime struct (0xf82e), and
   * the SOCD handler compares it against 2 and 3. See `advancedKeys.ts`.
   *
   * Whole rather than split because nothing here edits the high nibble, and
   * splitting a field this app only carries would invite a write that rebuilt
   * it from a part.
   */
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
export function decodeKeyPerfRecord(
  blob: ArrayLike<number>,
  slot: number,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): KeyPerfRecord {
  const at = slot * spec.recordSize
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
export function encodeKeyPerfRecord(
  rec: KeyPerfRecord,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): Uint8Array {
  const out = new Uint8Array(spec.recordSize)
  const L = spec.limits
  const actuation = clamp(rec.actuationCounts, L.actuationMin, L.actuationMax) - 1
  if (rec.rtUnset) {
    out[0] = (rec.switchType & FIVE_BITS) | (rec.switchFlags & 0xff & ~FIVE_BITS)
    out[1] = rec.keyMode & 0xff
    out[2] = actuation & 0xff
    out[3] = (actuation >> 8) & 0xff
    // Put the "never set" marker back rather than inventing sensitivities.
    out.fill(0xff, 4)
    return out
  }
  const press = clamp(rec.rtPressCounts, L.rtMin, L.rtMax) - 1
  const release = clamp(rec.rtReleaseCounts, L.rtMin, L.rtMax) - 1

  out[0] = (rec.switchType & FIVE_BITS) | (rec.switchFlags & 0xff & ~FIVE_BITS)
  out[1] = rec.keyMode & 0xff
  out[2] = actuation & 0xff
  out[3] = (actuation >> 8) & 0xff
  out[4] = press & 0xff
  out[5] = (press >> 8) & 0xff
  out[6] = release & 0xff
  out[7] = (release >> 8) & 0xff

  if (rec.deadzoneState) {
    // Saturate, never mask: see KEY_PERF_LIMITS.
    const top = clamp(rec.pressDeadzoneCounts, L.deadZoneMin, L.deadZoneMax)
    const bottom = clamp(rec.releaseDeadzoneCounts, L.deadZoneMin, L.deadZoneMax)
    if (top > 0) out[5] = (top << 1) | (out[5] & 1)
    if (bottom > 0) out[7] = (bottom << 1) | (out[7] & 1)
  }
  return out
}

/**
 * What each field can actually hold, and where the bound comes from.
 *
 * These are not style choices: writing past them does not fail, it **wraps**.
 * A 1.00 mm dead zone is 50 counts, and `50 & 0x1f` is 18 — the board would
 * quietly get 0.36 mm. So the encoder saturates instead of masking, and the UI
 * bounds its inputs to the same numbers.
 */
export const KEY_PERF_LIMITS = {
  /**
   * Rapid-trigger sensitivity, in counts. Minimum 1 is confirmed twice over:
   * the stock encoder clamps it (`cmp dword [edi+0x18], 1` at 0x42c576) and so
   * do the stock UI's own spin handlers (0x43ccd3 for the shared control,
   * 0x43d093 for the press control) — both force 1 when the user goes below it.
   * The maximum is the field: 9 bits.
   */
  rtMin: 1,
  rtMax: NINE_BITS + 1,
  /** Dead zones are 5 bits. 31 counts = 0.62 mm. */
  deadZoneMin: 0,
  deadZoneMax: FIVE_BITS,
  /** Actuation is the same 9-bit field as the sensitivities. */
  actuationMin: 1,
  actuationMax: NINE_BITS + 1,
} as const

/** Largest dead zone the 5-bit field can hold: 31 counts, 0.62 mm. */
export const MAX_DEADZONE_COUNTS = KEY_PERF_LIMITS.deadZoneMax

/**
 * The geometry and limits every function here assumes when no spec is passed.
 *
 * A sibling board states its own in `DeviceSpec.keyPerf`; the *record layout*
 * is not negotiable, because the bit positions above came from the stock
 * driver's encoder and decoder being exact inverses. A board that packs the
 * record differently needs a codec of its own, not a spec.
 */
export const DEFAULT_KEY_PERF: KeyPerfSpec = {
  recordSize: KEY_PERF.recordSize,
  slots: KEY_PERF.slots,
  limits: { ...KEY_PERF_LIMITS },
  keyMode: { ...KEY_MODE_WIRE },
}

/** Bytes in the whole blob, for a given geometry. */
export function keyPerfBlobSize(spec: KeyPerfSpec = DEFAULT_KEY_PERF): number {
  return spec.recordSize * spec.slots
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Turns a wire record into the millimetre model the UI edits. */
export function toKeyConfig(
  rec: KeyPerfRecord,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
  countsPerMm?: number,
): KeyConfig {
  const mm = (counts: number) => countsToMm(counts, countsPerMm)
  const mode: KeyMode = rec.keyMode === spec.keyMode.off ? 'normal' : 'rapidTrigger'
  return {
    actuationMm: mm(rec.actuationCounts),
    mode,
    rapidTrigger: {
      enabled: rec.keyMode !== spec.keyMode.off,
      pressMm: mm(rec.rtPressCounts),
      releaseMm: mm(rec.rtReleaseCounts),
      continuous: rec.keyMode === spec.keyMode.fullStroke,
    },
    deadZone: {
      enabled: rec.deadzoneState,
      topMm: mm(rec.pressDeadzoneCounts),
      bottomMm: mm(rec.releaseDeadzoneCounts),
    },
    switchType: rec.switchType,
    switchFlags: rec.switchFlags,
    rtUnset: rec.rtUnset,
  }
}

/**
 * And back, with `current` supplying the fields the model does not carry.
 *
 * `switchType` and `switchFlags` are hardware properties: which magnetic switch
 * is fitted, and three bits whose meaning is unknown (the stock encoder ORs
 * 0xa0 into them on some firmware). This app has no UI that sets either, and a
 * `KeyConfig` built from factory defaults has neither — so without `current`,
 * writing one would announce switch type 0 and clear those bits on every key it
 * touched. Passing the record the board just returned makes a write preserve
 * what it did not set, which is the only defensible behaviour for bytes we do
 * not understand.
 *
 * Same reasoning for `rtUnset`: the 0xff marker belongs to the board.
 */
export function fromKeyConfig(
  config: KeyConfig,
  current?: KeyPerfRecord,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
  countsPerMm?: number,
): KeyPerfRecord {
  const counts = (mm: number) => mmToCounts(mm, countsPerMm)
  const rt = config.rapidTrigger
  const keyMode = !rt.enabled
    ? spec.keyMode.off
    : rt.continuous
      ? spec.keyMode.fullStroke
      : spec.keyMode.rapidTrigger
  return {
    switchType: config.switchType ?? current?.switchType ?? 0,
    switchFlags: config.switchFlags ?? current?.switchFlags ?? 0,
    keyMode,
    actuationCounts: counts(config.actuationMm),
    rtPressCounts: counts(rt.pressMm),
    rtReleaseCounts: counts(rt.releaseMm),
    pressDeadzoneCounts: counts(config.deadZone.topMm),
    releaseDeadzoneCounts: counts(config.deadZone.bottomMm),
    deadzoneState: config.deadZone.enabled,
    rtUnset: (config.rtUnset ?? current?.rtUnset) === true && !rt.enabled && !config.deadZone.enabled,
  }
}

/**
 * True for a slot no key is wired to. The firmware leaves those at zero, and a
 * zeroed record decodes to actuation 1 count with rapid trigger off — plausible
 * enough to be mistaken for a real setting if it were shown.
 */
export function isEmptySlot(
  blob: ArrayLike<number>,
  slot: number,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): boolean {
  const at = slot * spec.recordSize
  for (let i = 0; i < spec.recordSize; i++) {
    if ((blob[at + i] ?? 0) !== 0) return false
  }
  return true
}

/**
 * Splices one record into a copy of the blob, leaving every other byte alone.
 *
 * A write is always read-modify-write here, and this is why. The stock driver
 * zeroes its 1024-byte staging buffer (`memset` at 0x42c44b) and fills only the
 * slots its own key collection knows about, so slots it does not model — 126,
 * 127, and the three unused channels — go back as zeros. Patching a blob the
 * board just handed us cannot lose anything we do not understand yet.
 */
export function patchSlot(
  blob: Uint8Array,
  slot: number,
  rec: KeyPerfRecord,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): Uint8Array {
  if (slot < 0 || slot >= spec.slots) throw new RangeError(`slot ${slot} is out of range`)
  const out = blob.slice()
  out.set(encodeKeyPerfRecord(rec, spec), slot * spec.recordSize)
  return out
}

/** Slots whose 8 bytes differ between two blobs. */
export function changedSlots(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): number[] {
  const out: number[] = []
  for (let slot = 0; slot < spec.slots; slot++) {
    const at = slot * spec.recordSize
    for (let i = 0; i < spec.recordSize; i++) {
      if ((before[at + i] ?? 0) !== (after[at + i] ?? 0)) {
        out.push(slot)
        break
      }
    }
  }
  return out
}

/** One record as hex, for reporting a slot that did not read back as written. */
export function recordHex(
  blob: ArrayLike<number>,
  slot: number,
  spec: KeyPerfSpec = DEFAULT_KEY_PERF,
): string {
  const at = slot * spec.recordSize
  const bytes: string[] = []
  for (let i = 0; i < spec.recordSize; i++) {
    bytes.push((blob[at + i] ?? 0).toString(16).padStart(2, '0'))
  }
  return bytes.join(' ')
}
