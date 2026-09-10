/**
 * The board-wide settings block — command 0x05 reads it, 0x06 writes it back.
 *
 * Lifted out of the old `raven61.ts` unchanged apart from taking a spec: the
 * offsets and bits below are the Raven61's, and a sibling board states its own
 * in `DeviceSpec.global` rather than forking this file. What cannot be a spec
 * field is the *shape* — one flags byte, one rate byte with the tick rate in
 * its high nibble — because that is what the two stock call sites edit.
 */

import type { FrameSpec, GlobalSpec } from '../device/spec'
import { COMMAND, DEFAULT_FRAME, sign } from './frame'
import {
  decodeLighting,
  emptyLightingPatch,
  lightingOffsets,
  patchLighting,
  type LightingPatch,
} from './lighting'
import type { GlobalSettings } from './types'

/** Byte offsets inside the 0x05 / 0x06 payload. See GlobalSettings. */
export const GLOBAL = {
  /** Block length the stock driver asks for. */
  length: 0x20,
  rate: 12,
  deadZone: 13,
  gameLock: 14,
  flags: 15,
  /**
   * The lighting effect settings, which share this block — see
   * `protocol/lighting.ts` for the layout and where it came from.
   *
   * ⚠ `lightMode` is byte 16, which an earlier pass of this project recorded
   * as a **sleep timeout**. It is not one: the stock driver looks its effect
   * row up by this value, and the `>= 23 -> 0xff` clamp that made it look like
   * a timeout is the effect table's own range. Nothing in this block is known
   * to hold a sleep time.
   */
  lightMode: 16,
  brightness: 17,
  speed: 18,
  direction: 19,
  colorful: 20,
  colorIndex: 21,
  color: 22,
} as const

/** Bits of `payload[15]`. */
export const GLOBAL_FLAGS = {
  tachyon: 0x01,
  bottomOutTrigger: 0x02,
  actuationCheck: 0x04,
  magnetTest: 0x08,
  debounceShift: 5,
  debounceMask: 0x03,
} as const

/**
 * The flag byte the stock driver writes when its performance tab opens.
 *
 * NOT required to start the stream — hardware showed that no value of this byte
 * makes travel arrive without 0xa8, and that 0xa8 works without it. Kept as a
 * record of what the stock driver does on a tab change, and as something the
 * monitor can send deliberately:
 *
 *   0x43933c  entering tab 7 queues job 0x0e
 *   0x442f00  job 0x0e dispatches to 0x429560
 *   0x429560  sends 0x01, then 0x06, waits 400 ms, then 0x02
 *
 * That 0x06 packet carries four data bytes, at payload[12..15], and payload[15]
 * is built from UI state: bits 0-1 from `perf_bottomrapidtrigger_mode`, bit 2
 * from `actuation_check`, bit 3 from the magnet-axis test, bit 5 from
 * `debounce_level`. The analog-mode flag forces bits 2 and 3 on together
 * (`or bl, 0xc` at 0x42994e), which is the state a calibration pass leaves.
 *
 * ⚠ **The "independent fields" reasoning that used to be here was wrong.** It
 * claimed the other 0x06 call site (0x428a30) leaves payload[12..15] zero, and
 * that switching tabs therefore cannot be resetting the report rate. In fact
 * both call sites copy the 0x05 reply into the write buffer before editing it
 * (0x42960a and 0x428b13), so neither writes a sparse block and nothing was
 * ever shown about field independence. See `globalWriteRequest`.
 *
 * Bits 0-1, 2 and 5 of that byte are user settings, so a patch must set only
 * the bits it means — `patchGlobalFlags` does that.
 */
export const ANALOG_REPORT = {
  /** Byte offset inside the 0x06 payload. */
  offset: GLOBAL.flags,
  /** `actuation_check` — the flag that looks like "report analog travel". */
  actuationCheck: GLOBAL_FLAGS.actuationCheck,
  /** The magnet-axis test. */
  magnetTest: GLOBAL_FLAGS.magnetTest,
  /** Both, which is what the driver sends while its analog mode is on. */
  both: GLOBAL_FLAGS.actuationCheck | GLOBAL_FLAGS.magnetTest,
  /** The driver sleeps this long between the 0x06 and the closing 0x02. */
  settleMs: 400,
} as const

/**
 * What the global block holds once the firmware has reset it — read out of the
 * defaults table at flash 0x175b4, the source the reset routine copies from.
 *
 * Used to check the reset landed, not to decide whether it worked: this is one
 * firmware build's table, and another build may ship different numbers. A board
 * that comes back with something else is reported as exactly that, rather than
 * as a failure.
 *
 * Three of these are worth reading twice. `reportRate: 4` is 1000 Hz under
 * REPORT_RATES, which is the sane thing for a factory default to be and so is
 * independent support for that table. `flags: 0x03` has both Tachyon and
 * "always trigger when bottoming" *on*, where the stock driver's own database
 * defaults them off — the firmware and the driver disagree about what default
 * means, and the firmware is the one that wins a reset.
 *
 * And the lighting four are what corrected the field this file used to call
 * `sleepMinutes`. The table reads `06 64 00 00 01` at those offsets, and the
 * stock database's own defaults for the same row are mode 6, brightness 100,
 * **speed 4**, colorful 1 — the speed disagreeing by exactly the `4 - x`
 * inversion, which is what makes two tables that know nothing about each other
 * into a check on the layout rather than two copies of one guess.
 */
export const FACTORY_GLOBAL = {
  /** `reporte_rate` 4 — 1000 Hz. */
  reportRate: 4,
  tickRate: 0,
  deadZone: 1,
  /** `payload[15]`: Tachyon and bottom-out trigger on, debounce level 0. */
  flags: 0x03,
  debounceLevel: 0,
  /** Effect 6 — Wave on this board's table. Not a number of minutes. */
  lightMode: 6,
  /** Percent. */
  brightness: 100,
  /** As stored: 0 is the fastest, and the database's own default is speed 4. */
  speedWire: 0,
  colorful: 1,
} as const

/**
 * The block as this module reads it when a caller names no spec.
 *
 * `activeLayer` is offset 1 — readable, but writing it does not switch layers
 * on this board. See `ACTIVE_LAYER_OFFSET` in layers.ts for why it is recorded
 * anyway.
 */
export const DEFAULT_GLOBAL: GlobalSpec = {
  length: GLOBAL.length,
  offsets: {
    rate: GLOBAL.rate,
    deadZone: GLOBAL.deadZone,
    gameLock: GLOBAL.gameLock,
    flags: GLOBAL.flags,
    activeLayer: 1,
    lightMode: GLOBAL.lightMode,
    brightness: GLOBAL.brightness,
    speed: GLOBAL.speed,
    direction: GLOBAL.direction,
    colorful: GLOBAL.colorful,
    colorIndex: GLOBAL.colorIndex,
    color: GLOBAL.color,
  },
  flags: { ...GLOBAL_FLAGS },
  settleMs: ANALOG_REPORT.settleMs,
  factoryDefaults: { ...FACTORY_GLOBAL },
}

export function decodeGlobalSettings(
  payload: Uint8Array,
  spec: GlobalSpec = DEFAULT_GLOBAL,
): GlobalSettings {
  const o = spec.offsets
  const f = spec.flags
  const rate = payload[o.rate] ?? 0
  const lock = payload[o.gameLock] ?? 0
  const flags = payload[o.flags] ?? 0
  return {
    raw: payload.slice(),
    reportRate: rate & 0x0f,
    tickRate: (rate >> 4) & 0x0f,
    deadZone: payload[o.deadZone] ?? 0,
    disableWin: (lock & 0x01) !== 0,
    disableAltTab: (lock & 0x02) !== 0,
    disableAltF4: (lock & 0x04) !== 0,
    tachyon: (flags & f.tachyon) !== 0,
    bottomOutTrigger: (flags & f.bottomOutTrigger) !== 0,
    actuationCheck: (flags & f.actuationCheck) !== 0,
    magnetTest: (flags & f.magnetTest) !== 0,
    debounceLevel: (flags >> f.debounceShift) & f.debounceMask,
    lighting: decodeLighting(payload, spec),
  }
}

/**
 * The fields of the global block this app is willing to change.
 *
 * Deliberately not "the whole block": most of it is settings that belong to
 * other screens, and one byte of it is the analog-test pair that stops the
 * board typing. A patch names what it means to change and nothing else.
 */
export interface GlobalPatch {
  /**
   * `perf_bottomrapidtrigger_mode` — the stock UI's "always trigger when
   * bottoming out". The one rapid-trigger setting that is board-wide rather
   * than per key.
   */
  bottomOutTrigger?: boolean
  /** `actuation_check`. */
  actuationCheck?: boolean
  /** The magnet-axis test bit. */
  magnetTest?: boolean
  /** `debounce_level`, 0-3. */
  debounceLevel?: number
  /**
   * `reporte_rate` — the USB polling rate, as the low nibble of `payload[12]`.
   * See REPORT_RATES for what the four values mean.
   *
   * The one patch field that is not a bit of the flags byte, and the one with a
   * side effect worth knowing about: the rate the board enumerates at is the
   * rate the host polls it at, so a change here may take a replug — or may drop
   * the WebHID handle outright — before it shows.
   */
  reportRate?: number
  /**
   * The lighting effect settings, which live in the same block.
   *
   * Nested rather than flattened in, because they are one screen's worth of
   * settings and because `protocol/lighting.ts` owns their encoding — the
   * speed inversion and the firmware's own limits are there, not here.
   */
  lighting?: LightingPatch
}

/**
 * One patch on top of another — later wins, field by field.
 *
 * Exists because a control that moves continuously emits a patch per pixel, and
 * a block write is a read-modify-write with a settle delay in the middle: sent
 * one at a time they queue up and the board falls seconds behind the pointer.
 * `BoardSync.applyGlobal` merges them instead and sends one. See
 * `state/sync.ts`.
 *
 * `lighting` is merged one level deeper rather than replaced, so a drag on the
 * brightness slider does not throw away a colour picked a moment earlier. Every
 * other field of a `GlobalPatch` is a scalar, and a later value for one of
 * those genuinely does replace the earlier.
 */
export function mergeGlobalPatch(base: GlobalPatch | null, next: GlobalPatch): GlobalPatch {
  if (!base) return { ...next }
  const out: GlobalPatch = { ...base, ...next }
  if (base.lighting || next.lighting) {
    out.lighting = { ...base.lighting, ...next.lighting }
  }
  return out
}

/**
 * Applies a patch to the rate byte. `tick_rate` shares it as the high nibble
 * and belongs to another screen, so it is carried through untouched.
 */
export function patchGlobalRate(rate: number, patch: GlobalPatch): number {
  if (patch.reportRate === undefined) return rate
  return ((rate & 0xf0) | (patch.reportRate & 0x0f)) & 0xff
}

/** Applies a patch to the flags byte, leaving the bits it does not name alone. */
export function patchGlobalFlags(
  flags: number,
  patch: GlobalPatch,
  spec: GlobalSpec = DEFAULT_GLOBAL,
): number {
  const bits = spec.flags
  let out = flags
  const set = (mask: number, on: boolean) => {
    out = on ? out | mask : out & ~mask & 0xff
  }
  if (patch.bottomOutTrigger !== undefined) set(bits.bottomOutTrigger, patch.bottomOutTrigger)
  if (patch.actuationCheck !== undefined) set(bits.actuationCheck, patch.actuationCheck)
  if (patch.magnetTest !== undefined) set(bits.magnetTest, patch.magnetTest)
  if (patch.debounceLevel !== undefined) {
    const shifted = (patch.debounceLevel & bits.debounceMask) << bits.debounceShift
    out = (out & ~(bits.debounceMask << bits.debounceShift) & 0xff) | shifted
  }
  return out
}

export interface GlobalWriteResult {
  before: GlobalSettings
  after: GlobalSettings
  /** Byte offsets inside the payload that came back different from what was sent. */
  mismatched: { offset: number; wanted: number; got: number }[]
  /** True when the patch was already the board's state, so nothing was sent. */
  unchanged: boolean
}

/**
 * Builds the `0x06` request from a `0x05` reply, which is where the read-modify
 * -write happens: every byte the patch does not name is the byte the board
 * just reported.
 */
export function globalWriteRequest(
  reply: ArrayLike<number>,
  patch: GlobalPatch,
  opts: { global?: GlobalSpec; frame?: FrameSpec; command?: number } = {},
): Uint8Array {
  const spec = opts.global ?? DEFAULT_GLOBAL
  const frame = opts.frame ?? DEFAULT_FRAME
  const command = opts.command ?? COMMAND.globalSettings
  const out = new Uint8Array(frame.payloadLength)
  for (let i = 0; i < frame.payloadLength; i++) out[i] = reply[i] ?? 0
  out[frame.offsets.magic] = frame.magic
  out[frame.offsets.command] = command
  out[spec.offsets.rate] = patchGlobalRate(out[spec.offsets.rate] ?? 0, patch)
  out[spec.offsets.flags] = patchGlobalFlags(out[spec.offsets.flags] ?? 0, patch, spec)
  if (patch.lighting) patchLighting(out, patch.lighting, spec)
  return sign(out, frame)
}

/**
 * The bytes a patch can touch — the only ones worth verifying.
 *
 * Both are checked whichever fields the patch named. A byte the patch left
 * alone was copied out of the board's own reply, so reading it back different
 * is worth hearing about too.
 */
export function writtenOffsets(
  spec: GlobalSpec = DEFAULT_GLOBAL,
  patch?: GlobalPatch,
): readonly number[] {
  const base = [spec.offsets.rate, spec.offsets.flags]
  // Only when the patch named a lighting field. Verifying nine bytes a write
  // never touched would turn a board that disagrees about `colorIndex` — the
  // one byte here nobody has decoded — into a mismatch report on every write.
  if (patch?.lighting && !emptyLightingPatch(patch.lighting)) {
    base.push(...lightingOffsets(spec))
  }
  return base
}

/**
 * True when two payloads carry the same data.
 *
 * From payload[4] on: the header differs by construction (0x55/0x06 against
 * 0xaa/0x05) and its checksum with it.
 */
export function sameGlobalData(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  frame: FrameSpec = DEFAULT_FRAME,
): boolean {
  for (let i = frame.offsets.data; i < frame.payloadLength; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return false
  }
  return true
}
