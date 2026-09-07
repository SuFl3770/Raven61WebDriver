/**
 * The lighting effect settings — mode, brightness, speed, direction, colour.
 *
 * They live in the **board-wide settings block**, the one command 0x05 reads
 * and 0x06 writes: `payload[16..24]`, right after the performance tab's own
 * bytes. So this file is not a new transport. It is the field layout of nine
 * bytes inside a block the app already reads, writes and verifies — see
 * `global.ts`, which owns the read-modify-write.
 *
 * ## Where the layout came from
 *
 * Two independent artifacts, agreeing field for field.
 *
 * **The stock driver.** Its general-settings write at `0x428a30` loads one row
 * of its own `t_light_data` table (`0x4076d0`, `SELECT * FROM t_light_data
 * WHERE profile = ? AND mode = ?`) and copies that row's columns into the
 * packet. The loader stores SQLite column *n* at `struct + 4n`, so the column
 * order *is* the struct order, and the write reads it back out in order:
 *
 *     0x428b3f  payload[16] = the mode it just looked the row up by
 *     0x428b4d  payload[17] = struct+0x10  column 4   brightness
 *     0x428b58  payload[18] = 4 - struct+0x14   column 5   speed, inverted
 *     0x428b62  payload[19] = struct+0x18  column 6   direction
 *     0x428b6c  payload[20] = struct+0x1c  column 7   colorful
 *     0x428b76  payload[21] = struct+0x20  column 8   colorindex
 *     0x428b8c  payload[22] = struct+0x24 & 0xff      color_value, low byte
 *     0x428b82  payload[23] = >> 8
 *     0x428b97  payload[24] = >> 16
 *
 * **The firmware.** It copies the block to RAM `0x20002a04` at boot
 * (`0xa590`), so `payload[j]` is `0x20002a04 + j - 8`, and then:
 *
 *   - validates two of these fields at boot (`0xa72a`): `brightness > 100`
 *     becomes 100, `speed > 4` becomes 2. That is where the ranges below come
 *     from — they are the firmware's own limits, not a UI convention.
 *   - drives the same two from key actions: the brightness action (`0xf9ac`)
 *     cycles 0 / 25 / 50 / 75 / 100, which is what fixes brightness as a
 *     *percentage*; the speed action (`0xfb00`) steps 0..4 with the same clamp.
 *   - treats direction and colorful as plain booleans — the toggles at
 *     `0x00fbee` and `0x00fc5c` store nothing but 0 and 1.
 *   - reads the speed byte in every effect renderer as a **period**:
 *     `if (tick < (speed + 1) * 10) skip` at `0x010d86`. So a bigger wire value
 *     is slower, and the driver's `4 - x` makes its own slider read the usual
 *     way round.
 *   - loads `payload[22..24]` into the same three colour globals
 *     (`gp-0x74e`, `gp-0x74d`, `gp-0x74c`) that the per-key RGB path fills from
 *     `[slot*3+0..2]` at `0x135f8`. Those three are R, G and B in that order
 *     (docs §3.8), so `payload[22]` is red — which also fixes the driver's
 *     `color_value` as `0x00BBGGRR`.
 *
 * And the two defaults tables agree: the firmware's factory block at flash
 * `0x175b4` reads `06 64 00 00 01 00 ff 00 00` for these nine bytes, while the
 * stock database's own defaults for the same row are mode 6, brightness 100,
 * **speed 4**, direction 0, colorful 1, colorindex 0, color_value 255. Speed 4
 * against a wire 0, and `color_value 255` against `ff 00 00`, are exactly what
 * the inversion and the byte order predict. Neither table knows about the
 * other.
 *
 * ## What is still unknown
 *
 * `colorindex` (`payload[21]`). It is 0 in every row of the stock database and
 * in the firmware's defaults, the firmware reads it, and nothing seen says what
 * it selects. It is therefore **carried through untouched** by a write rather
 * than being sent as a guess — see `LightingPatch`.
 */

import type { GlobalSpec, LightEffectSpec } from '../device/spec'
import type { Rgb } from './keyRgb'

/**
 * Bits of `LightEffectSpec.supports` — the stock table's `config_func`.
 *
 * Which control each bit shows, and how that was established rather than
 * guessed, is in `device/boards/raven61/lighting.ts`.
 */
export const LIGHT_CONTROL = {
  brightness: 0x01,
  speed: 0x02,
  /**
   * The direction toggle.
   *
   * Four bits rather than one: the stock page has four *pairs* of radio
   * buttons — the strings include Within/Outside and Clockwise/Anticlockwise —
   * and each effect sets exactly one of the four to choose its pair. Which bit
   * is which pair is not established, so this is their union and the app labels
   * the toggle neutrally.
   */
  direction: 0x04 | 0x08 | 0x40 | 0x80,
  colorful: 0x10,
  color: 0x20,
  /** Only Custom Light: the per-key colour editor stands in for a colour. */
  perKey: 0x100,
  /** Only Musical Rhythm, whose layer this project has not decoded. */
  music: 0x200,
} as const

/** Firmware limits, from the boot validation at 0xa72a. */
export const LIGHT_LIMITS = {
  /** Percent. `> 100` is rewritten to 100 at boot. */
  brightnessMax: 100,
  /** `> 4` is rewritten to 2 at boot. */
  speedMax: 4,
} as const

/** What the mode byte holds when nothing is lit. */
export const LIGHT_MODE_OFF = 0xff

/** The lighting half of the settings block, decoded. */
export interface LightingSettings {
  /** `payload[16]`. A `LightEffectSpec.mode`, or 0xff for off. */
  mode: number
  /** `payload[17]`, percent 0-100. */
  brightness: number
  /**
   * Speed as the stock UI means it: 0 slowest, 4 fastest.
   *
   * The wire stores `4 - speed` because the firmware reads the byte as a
   * period. Decoding flips it back, so nothing above this line has to know.
   */
  speed: number
  /** `payload[19]`. Which way the effect runs; the pair of labels is the effect's. */
  direction: boolean
  /** `payload[20]`. The effect cycles hues instead of using one colour. */
  colorful: boolean
  /** `payload[21]`. Undecoded — kept so a write can put it back unchanged. */
  colorIndex: number
  /** `payload[22..24]`, R then G then B. */
  color: Rgb
}

/** True when a board's spec locates the lighting bytes at all. */
export function hasLighting(spec: GlobalSpec): boolean {
  const o = spec.offsets
  return (
    o.lightMode !== null &&
    o.brightness !== null &&
    o.speed !== null &&
    o.direction !== null &&
    o.colorful !== null &&
    o.colorIndex !== null &&
    o.color !== null
  )
}

/**
 * Reads the lighting fields out of a 0x05 reply.
 *
 * Returns null when the board's spec does not place them, which is how a
 * sibling that has not been looked at says so — the panel then shows the
 * undecoded notice instead of nine zeroes dressed as settings.
 */
export function decodeLighting(
  payload: ArrayLike<number>,
  spec: GlobalSpec,
): LightingSettings | null {
  const o = spec.offsets
  if (!hasLighting(spec)) return null
  const at = (i: number) => payload[i] ?? 0
  const wireSpeed = at(o.speed!)
  return {
    mode: at(o.lightMode!),
    brightness: at(o.brightness!),
    // Clamped before flipping: a byte the firmware would reject would otherwise
    // decode to a negative speed and the UI would show a slider off its scale.
    speed: LIGHT_LIMITS.speedMax - Math.min(wireSpeed, LIGHT_LIMITS.speedMax),
    direction: at(o.direction!) !== 0,
    colorful: at(o.colorful!) !== 0,
    colorIndex: at(o.colorIndex!),
    color: { r: at(o.color!), g: at(o.color! + 1), b: at(o.color! + 2) },
  }
}

/**
 * The lighting fields a write may change.
 *
 * Named fields rather than a whole `LightingSettings`, for the reason the rest
 * of `GlobalPatch` is a patch: the block is shared with three other screens,
 * and one byte of it is the analog-test pair that stops the board typing. A
 * patch says what it means to change.
 *
 * `colorIndex` is deliberately absent. Nothing is known about what it selects,
 * so the read-modify-write puts the board's own byte back and this app never
 * originates a value for it.
 */
export interface LightingPatch {
  /** A `LightEffectSpec.mode`, or `LIGHT_MODE_OFF`. */
  lightMode?: number
  /** Percent, 0-100. Saturated to the firmware's limit. */
  brightness?: number
  /** 0 slowest to 4 fastest, as the UI means it. Inverted on the way out. */
  speed?: number
  direction?: boolean
  colorful?: boolean
  color?: Rgb
}

function byte(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(max, Math.round(value)))
}

/**
 * Applies a lighting patch to a copy of the block, in place.
 *
 * Saturating rather than rejecting, and to the *firmware's* limits: the boot
 * validation rewrites a brightness above 100 to 100 and a speed above 4 to 2,
 * so a value past the end would not come back as itself and the verify read
 * would report a mismatch the user could do nothing about.
 */
export function patchLighting(
  out: Uint8Array,
  patch: LightingPatch,
  spec: GlobalSpec,
): void {
  const o = spec.offsets
  if (!hasLighting(spec)) return
  if (patch.lightMode !== undefined) out[o.lightMode!] = byte(patch.lightMode, 0xff)
  if (patch.brightness !== undefined) {
    out[o.brightness!] = byte(patch.brightness, LIGHT_LIMITS.brightnessMax)
  }
  if (patch.speed !== undefined) {
    // The wire is a period, so it runs the other way. Same flip the stock
    // driver does at 0x428b52 — `mov al, 4 / sub al, speed`.
    out[o.speed!] = LIGHT_LIMITS.speedMax - byte(patch.speed, LIGHT_LIMITS.speedMax)
  }
  if (patch.direction !== undefined) out[o.direction!] = patch.direction ? 1 : 0
  if (patch.colorful !== undefined) out[o.colorful!] = patch.colorful ? 1 : 0
  if (patch.color !== undefined) {
    out[o.color!] = byte(patch.color.r, 0xff)
    out[o.color! + 1] = byte(patch.color.g, 0xff)
    out[o.color! + 2] = byte(patch.color.b, 0xff)
  }
}

/** The block offsets a lighting patch can touch — the ones worth verifying. */
export function lightingOffsets(spec: GlobalSpec): number[] {
  const o = spec.offsets
  if (!hasLighting(spec)) return []
  return [
    o.lightMode!,
    o.brightness!,
    o.speed!,
    o.direction!,
    o.colorful!,
    o.color!,
    o.color! + 1,
    o.color! + 2,
  ]
}

/** True when the patch names nothing. */
export function emptyLightingPatch(patch: LightingPatch): boolean {
  return (
    patch.lightMode === undefined &&
    patch.brightness === undefined &&
    patch.speed === undefined &&
    patch.direction === undefined &&
    patch.colorful === undefined &&
    patch.color === undefined
  )
}

/** The effect a mode byte names, or undefined when the table has no such row. */
export function effectOf(
  effects: readonly LightEffectSpec[] | undefined,
  mode: number,
): LightEffectSpec | undefined {
  return effects?.find((e) => e.mode === mode)
}

/** Whether an effect uses a given control. See LIGHT_CONTROL. */
export function supportsControl(effect: LightEffectSpec | undefined, control: number): boolean {
  return effect !== undefined && (effect.supports & control) !== 0
}
