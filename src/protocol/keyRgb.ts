/**
 * The per-key custom RGB blob: command 0x0a reads it, 0x0b writes it.
 *
 * 384 bytes at flash 0x20f00, three per slot, 128 slots — and the index is a
 * hardware slot number, exactly as it is for the performance and keymap blocks.
 * The three blocks share one slot space (docs §4.6), so this file reuses
 * `slotMap.ts` rather than growing an addressing scheme of its own.
 *
 * The layout came out of the firmware, not the driver: the LED path at 0x135f8
 * loads `[slot*3 + 0..2]` straight into the R, G and B registers. That is also
 * what settles a mistake this project made twice — 384 bytes of 3-byte records
 * in the same address range read like a keymap layer, and reading it as one
 * sent the first slot-mapping attempt down its fallback path (docs §4.6). It is
 * colour, and an all-zero record means *no custom colour*, not an unassigned
 * layer.
 *
 * ## What this block is, and what it is not
 *
 * It is the **stored custom layer**. It is not what the board is displaying:
 * that is a RAM buffer one stage further on, which 0xde reads and the effect
 * engine rewrites every frame. So a colour written here is verified by reading
 * *this* block back, and whether it reaches the LEDs is a separate question
 * that only 0xde can answer — see `readLightFrame` in engine.ts.
 *
 * That distinction is the honest limit of this tab. Which lighting mode makes
 * the firmware consult this layer is **not decoded**: the effect settings live
 * in the global block's `[17..24]` and in the two 256-byte blocks behind
 * 0xa4/0xa6, and neither field layout has been recovered (docs §9). So the app
 * can put a colour in this block and prove the bytes landed, and it cannot
 * promise the key lights up.
 */

import type { KeyRgbSpec } from '../device/spec'

/** 128 slots of 3 bytes. The board uses 64 of them; the block is 128 wide. */
export const KEY_RGB: KeyRgbSpec = {
  recordSize: 3,
  slots: 128,
  /**
   * 100 ms — ten frames a second, which is enough to watch an effect move and
   * far below what the link can carry (one frame is seven packets).
   *
   * Chosen here, not recovered: see `framePollMs` in device/spec.ts for why the
   * stock driver has no equivalent number to copy.
   */
  framePollMs: 100,
}

/** Bytes in the whole block, which is what a read and a write both transfer. */
export function keyRgbBlobSize(spec: KeyRgbSpec = KEY_RGB): number {
  return spec.recordSize * spec.slots
}

/** One colour, in the 0-255 channels the wire stores. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * No custom colour.
 *
 * The board's own way of saying it — three zero bytes — and therefore the value
 * a "clear this key" edit writes. It is not the same as black: black is what
 * the firmware would show for an off LED, and the firmware treats this record
 * as absent rather than as a colour. Nothing in this app can tell the two
 * apart, so it does not offer black separately and says so in the panel.
 */
export const UNLIT: Rgb = { r: 0, g: 0, b: 0 }

export function isUnlit(color: Rgb): boolean {
  return color.r === 0 && color.g === 0 && color.b === 0
}

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/** Rounds and bounds a colour to what a byte can hold. */
export function clampRgb(color: Rgb): Rgb {
  const byte = (v: number) => {
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(255, Math.round(v)))
  }
  return { r: byte(color.r), g: byte(color.g), b: byte(color.b) }
}

/** Reads one record out of the blob. */
export function decodeKeyRgb(
  blob: ArrayLike<number>,
  slot: number,
  spec: KeyRgbSpec = KEY_RGB,
): Rgb {
  const at = slot * spec.recordSize
  return { r: blob[at] ?? 0, g: blob[at + 1] ?? 0, b: blob[at + 2] ?? 0 }
}

/** Writes one record into a blob, in place. */
export function encodeKeyRgb(
  blob: Uint8Array,
  slot: number,
  color: Rgb,
  spec: KeyRgbSpec = KEY_RGB,
): void {
  const at = slot * spec.recordSize
  const c = clampRgb(color)
  blob[at] = c.r
  blob[at + 1] = c.g
  blob[at + 2] = c.b
}

/** `#rrggbb`, which is what an `<input type="color">` reads and writes. */
export function hexOf(color: Rgb): string {
  const c = clampRgb(color)
  const two = (v: number) => v.toString(16).padStart(2, '0')
  return `#${two(c.r)}${two(c.g)}${two(c.b)}`
}

/** `#rrggbb` or `rrggbb` back to channels. Null for anything else. */
export function parseHex(text: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim())
  if (!match) return null
  const n = Number.parseInt(match[1]!, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/**
 * How bright a colour looks, 0 to 1 — for choosing a legend colour that stays
 * readable on a cap painted with it.
 *
 * The sRGB luma weights rather than a plain average: a saturated green and a
 * saturated blue are nowhere near equally bright, and averaging puts white text
 * on the green one.
 */
export function luminanceOf(color: Rgb): number {
  const c = clampRgb(color)
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
}

/** The record as hex bytes — what a mismatch report shows. */
export function rgbRecordHex(
  blob: ArrayLike<number>,
  slot: number,
  spec: KeyRgbSpec = KEY_RGB,
): string {
  const at = slot * spec.recordSize
  const bytes: string[] = []
  for (let i = 0; i < spec.recordSize; i++) {
    bytes.push((blob[at + i] ?? 0).toString(16).padStart(2, '0'))
  }
  return bytes.join(' ')
}

/** Slots whose record differs between two blobs. */
export function changedRgbSlots(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
  spec: KeyRgbSpec = KEY_RGB,
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
