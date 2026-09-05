/**
 * The board's calibration table, and what the firmware does with it.
 *
 * Recovered from the firmware image rather than from the stock driver — see
 * `tools/fw/calibration.py`, which prints every constant below straight out of
 * `Raven FW/FW.exe`, and docs/protocol.md §3.3 for the derivation.
 *
 * ## What the board actually stores
 *
 * One 8-byte record per sensor slot, 64 of them, at flash 0x20300:
 *
 *   [0..3]  float32  scale — ADC counts per 1/800 of full travel
 *   [4]     u8       state — what the LED shows
 *   [5..7]  AA BB FF a tag the boot path checks before trusting the record
 *
 * `scale` is the calibration. Every scan the firmware computes
 * `travelRaw = (rest - live) / scale`, clamps it at 800, and runs it through a
 * per-switch-type curve to get the depth in 0.02 mm counts that the rest of the
 * protocol speaks. So the scale *is* the mapping from magnet to millimetres,
 * and a key with the wrong one reports the wrong depth — which is what a
 * miscalibrated key feels like.
 *
 * ## How the firmware learns it
 *
 * In the scan loop (0xe5d8), for any key not already marked calibrated:
 *
 *   cand = (rest - live) / 800
 *   if (cand > scale && cand < 2.0 && cand - scale > 0.005)
 *       if (round(cand * 100) held for 24 consecutive scans)
 *           scale = cand;  if (state <= 1) state++
 *
 * It only ever grows. Pressing a key deeper than it has ever been pressed
 * raises the scale; nothing lowers it except a reset.
 *
 * ## Why the LED is not a good indicator, and what to use instead
 *
 * `state` is a *counter of how many times the scale grew*, saturating at two
 * and then latching to 0xFF. That makes it wrong in both directions:
 *
 *  - Every record ships at `state = 0`, so a board straight out of a firmware
 *    update lights every key red however well calibrated it is. The stock
 *    driver's own string 1056 describes exactly this.
 *  - Two growth events are enough to latch 0xFF, and a growth event only needs
 *    the scale to move by 0.005. Two half-presses can turn a key "green"
 *    without it ever having been bottomed out.
 *  - A key whose scale is already right can never grow again, so it stays red
 *    for ever.
 *  - The boot path (0xa63a) forces `state = 0xFF` whenever the stored scale
 *    falls outside [0.62, 1.24] — a record bad enough to be thrown away is
 *    reported as calibrated.
 *
 * The honest signal is the scale itself. It has a floor the firmware refuses to
 * go below (0.62, also the shipped default and the value a reset writes), so a
 * key still sitting at the floor has never been calibrated, and one only just
 * above it has been calibrated badly. `gradeRecord` reads that, and the
 * firmware's own verdict is reported alongside so the two can be compared.
 */

/** Sensor slots, and so calibration records, on the board. */
export const CAL_SLOTS = 64
export const CAL_RECORD_BYTES = 8
export const CAL_TABLE_BYTES = CAL_SLOTS * CAL_RECORD_BYTES

/**
 * Firmware constants. Every one of these is read back by
 * `tools/fw/calibration.py`; the comment gives the address it lives at.
 */
export const CAL = {
  /**
   * Full travel in the linearised unit the firmware divides by (0x1569c).
   * `travelRaw` runs 0 … this, whatever the switch's stroke in millimetres.
   */
  travelRawFull: 800,
  /**
   * `travelRaw` the firmware treats as bottomed out (0x156b4) — 96% of full.
   * Chosen in the firmware, not here, and unlike a millimetre threshold it does
   * not need to know the switch's stroke.
   */
  bottomOutRaw: 768,
  /**
   * The scale a record ships with, the value a reset writes, and the floor the
   * boot check rejects below (0x15690). A key at exactly this has never been
   * calibrated.
   */
  scaleFloor: 0.62,
  /** Boot check rejects above this too (0x15694). */
  scaleCeiling: 1.24,
  /**
   * The firmware's own "calibrated enough" line (0x156b8), used as one of the
   * conditions for advancing the state.
   */
  scaleCalibrated: 0.63,
  /** Smallest growth the learner will take (0x156a4). */
  scaleStep: 0.005,
  /** Scans a quantised candidate must hold before it is committed (0xe6ca). */
  stableScans: 24,
} as const

/**
 * `state` values with a meaning. Everything between is transient — the learner
 * increments through 2, and the next scan latches it to `done`.
 */
export const CAL_STATE = {
  /** LED red. */
  fresh: 0x00,
  /** LED amber. */
  learning: 0x01,
  /** No LED override; the lighting effect shows through. */
  done: 0xff,
} as const

/**
 * The colours the firmware paints, from its status palette at 0x1753c. The
 * overlay at 0x13974 only paints states 0 and 1, so only two of the eight
 * entries are reachable — the third is what "calibrated" looks like on the
 * board, which is the effect colour rather than green.
 */
export const CAL_LED = {
  fresh: '#FF0000',
  learning: '#FF8000',
} as const

/** How good a key's calibration is, in the order a legend should list them. */
export type CalHealth = 'unknown' | 'uncalibrated' | 'weak' | 'ok'

export interface CalRecord {
  /** ADC counts per 1/800 of full travel, as the board has it. */
  scale: number
  /** The firmware's own byte — see CAL_STATE. */
  state: number
  /** False when the record's AA BB FF tag is missing, i.e. the board would
   *  rewrite it on the next boot. */
  valid: boolean
}

const TAG = [0xaa, 0xbb, 0xff]

/** Decodes one 8-byte record. */
export function parseCalRecord(bytes: ArrayLike<number>, at = 0): CalRecord {
  const buf = new Uint8Array(4)
  for (let i = 0; i < 4; i++) buf[i] = bytes[at + i] ?? 0
  return {
    scale: new DataView(buf.buffer).getFloat32(0, true),
    state: bytes[at + 4] ?? 0,
    valid: TAG.every((b, i) => (bytes[at + 5 + i] ?? 0) === b),
  }
}

/** Decodes the whole 512-byte table. */
export function parseCalTable(blob: ArrayLike<number>): CalRecord[] {
  const out: CalRecord[] = []
  for (let slot = 0; slot < CAL_SLOTS; slot++) {
    out.push(parseCalRecord(blob, slot * CAL_RECORD_BYTES))
  }
  return out
}

/**
 * The floor as the board actually holds it.
 *
 * The record stores a float32, and 0.62 is not representable in one: reading it
 * back gives 0.6200000047683716, which is *above* the 0.62 written here. A key
 * that has never been calibrated then tests as "very slightly better than the
 * floor" and grades one step too kindly — which is exactly what the shipped
 * record did before this existed.
 *
 * A scale reassembled from an event's decimal digits is the other way round:
 * 6/10 + 2/100 is a clean double at or just under 0.62. Rounding the constant
 * to float32 covers both, since every real scale is a float32 to begin with.
 */
const SCALE_FLOOR_F32 = Math.fround(CAL.scaleFloor)

/**
 * How far above the floor a key's scale sits, 0 … 1.
 *
 * The floor is where an uncalibrated key sits and the ceiling is where the
 * firmware stops believing the record, so the span between them is the whole
 * range a real calibration can land in. Reported as a fraction because the
 * absolute numbers mean nothing to anyone who has not read the firmware.
 */
export function scaleHeadroom(scale: number): number {
  const span = CAL.scaleCeiling - SCALE_FLOOR_F32
  return Math.min(1, Math.max(0, (scale - SCALE_FLOOR_F32) / span))
}

/**
 * Below this much headroom a key is only just off the floor: the board has
 * learned *something* but not much, which is what a key that was pressed but
 * not bottomed out looks like.
 *
 * ⚠ Unlike everything else in this module this number is ours, not the
 * firmware's — the firmware has no "nearly calibrated" state to copy, only the
 * counter that `state` is. It is set where the firmware's own
 * `scaleCalibrated` line falls (0.63, one step above the floor), rounded to a
 * fraction: 0.63 is 1.6% of the way up the range, and doubling that leaves room
 * for a key that grew a couple of steps and stopped.
 */
export const WEAK_HEADROOM = 0.03

/**
 * A key's calibration, graded from the record.
 *
 * `state` is deliberately not the input. It is reported next to this so the
 * board's own opinion stays visible, but grading on it would reproduce the
 * fault this module exists to work around.
 */
export function gradeRecord(record: CalRecord | undefined): CalHealth {
  if (!record || !record.valid) return 'unknown'
  if (record.scale <= SCALE_FLOOR_F32) return 'uncalibrated'
  if (scaleHeadroom(record.scale) < WEAK_HEADROOM) return 'weak'
  return 'ok'
}

/** True when the firmware would be lighting this key's LED. */
export function ledColor(state: number): string | undefined {
  if (state === CAL_STATE.fresh) return CAL_LED.fresh
  if (state === CAL_STATE.learning) return CAL_LED.learning
  return undefined
}

/**
 * Whether a press reached the depth the firmware counts as bottomed out.
 *
 * Takes `travelRaw` rather than millimetres on purpose. The firmware's own test
 * is against the linearised 0 … 800 scale, which is switch-independent; the
 * millimetre figure is that same number bent through the switch's stroke curve,
 * so a threshold in millimetres has to know the switch type to mean anything —
 * and gets it wrong on the short switches, which was the previous bug here.
 */
export function isBottomedOut(travelRaw: number): boolean {
  return travelRaw >= CAL.bottomOutRaw
}
