/**
 * Value encodings confirmed against the stock driver's own database.
 *
 * Evidence (`Raven61 HE_datav6_esc_*.db`, table `t_key_perf_data`):
 *   Esc actuation 1.0 mm -> key_actuation 50
 *   Esc actuation 2.0 mm -> key_actuation 100
 *   factory default 1.5 mm -> global_key_actuation 75
 *
 * Three points on a line through the origin: one count is 0.02 mm.
 */
export const COUNTS_PER_MM = 50

/** 0.02 mm — the smallest step the board can express. */
export const MM_PER_COUNT = 1 / COUNTS_PER_MM

/**
 * The three converters take the step as an argument so a board with a
 * different resolution is a spec change rather than a fork — see
 * `EncodingSpec` in `src/device/spec.ts`. `COUNTS_PER_MM` stays the default
 * because it is the family's, and because the evidence above is for it.
 */
export function mmToCounts(mm: number, countsPerMm: number = COUNTS_PER_MM): number {
  return Math.round(mm * countsPerMm)
}

export function countsToMm(counts: number, countsPerMm: number = COUNTS_PER_MM): number {
  return counts / countsPerMm
}

/** Snaps a millimetre value to something the board can actually store. */
export function quantizeMm(mm: number, countsPerMm: number = COUNTS_PER_MM): number {
  return countsToMm(mmToCounts(mm, countsPerMm), countsPerMm)
}

/** `t_key_perf_data.key_mode`. */
export const KEY_MODE = { normal: 0, rapidTrigger: 1 } as const

/**
 * The stock driver stores three switchable profiles (`t_profile_data`), plus a
 * profile 0 row in `t_config_data` holding factory defaults.
 */
export const PROFILE_COUNT = 3

/**
 * Raven61 uses four keymap layers (`t_key_macro_data.fn_layer` 0-3); layers 2
 * and 3 ship unassigned. The stock driver's UI strings mention up to eight FN
 * layers, but that is shared text across its supported boards.
 *
 * `fn_layer` 101 also appears, holding a merged keymap in which Fn itself is a
 * layer-switch action (macro_type 12, macro_value 511) rather than a HID usage.
 * Its exact role is not settled — see docs/protocol.md.
 */
export const LAYER_COUNT = 4

/** `t_key_macro_data.macro_type`. */
export const MACRO_TYPE = {
  /** Plain HID usage in `macro_value`. */
  hidKey: 2,
  /** Special action; `macro_value` 1 = unassigned, 511 = switch to FN layer 1. */
  special: 12,
} as const

/**
 * Factory defaults, in counts, from the profile 0 row of `t_config_data`.
 */
export const FACTORY_DEFAULTS = {
  actuation: 75,
  rapidTriggerPress: 5,
  rapidTriggerRelease: 5,
  deadZoneTop: 0,
  deadZoneBottom: 10,
  switchType: 3,
} as const
