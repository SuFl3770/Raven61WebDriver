/**
 * A saved profile: everything this app can put back on a board, as data.
 *
 * ## Why the blocks are named, and separate
 *
 * A write here is not one packet. The per-key block alone is a keymap read, a
 * block read, nineteen write chunks and a verify read; the macro store is the
 * whole 3.5 KB region however little changed. Applying a whole file is
 * therefore minutes of traffic in the worst case, and a failure half way
 * through leaves the board holding half a profile.
 *
 * So a document is a bag of independent blocks rather than one value. The load
 * dialog checks each one on its own, shows what it found, and writes the ones
 * that were ticked — which is also what makes "put my actuation back but leave
 * the keymap alone" a thing that can be asked for.
 *
 * ## Why the board's own bytes are kept for the advanced keys
 *
 * Every other block round-trips through this app's model, which is decoded and
 * confirmed. The advanced-key tables are three opaque blobs with a decoder this
 * app is less sure of, and `restoreAdvancedKeys` puts them back byte for byte.
 * Storing the bytes rather than the decode means a file written today still
 * restores correctly if the decoder is corrected tomorrow.
 */

import type { KeyBinding } from '../protocol/keymap'
import type { Macro } from '../protocol/macros'
import type { Rgb } from '../protocol/keyRgb'
import type { GlobalPatch } from '../protocol/global'
import type { KeyConfig } from '../protocol/types'

/**
 * The file format's own version, bumped when an older file would be read
 * wrongly rather than merely incompletely.
 *
 * Adding a block does not bump it — a reader that does not know a block leaves
 * it out of the list it offers, which is the honest outcome. Changing what an
 * existing field *means* does.
 */
export const PROFILE_VERSION = 1

/**
 * The blocks a profile can carry, in the order the load dialog lists them and
 * the order `applyProfile` writes them.
 *
 * The order is not arbitrary. `advancedKeys` and `macros` go before `keymap`
 * because a keymap entry can point at an advanced-key record or a macro slot,
 * and a board that has the pointer before the thing pointed at is a board
 * whose key does something undefined in between. `global` is last because it
 * is the one block whose write can cost the connection — a changed polling
 * rate may drop the WebHID handle — and everything else should already be in
 * when that happens.
 */
export const PROFILE_BLOCKS = [
  'keyPerf',
  'advancedKeys',
  'macros',
  'keymap',
  'keyRgb',
  'global',
] as const

export type ProfileBlock = (typeof PROFILE_BLOCKS)[number]

/** One keymap layer, as a file holds it. */
export interface ProfileLayer {
  /** `fn_layer` — an index into the board's layers, not a position in a list. */
  layer: number
  /**
   * One binding per key, in this project's key order.
   *
   * `null` is a key the read could not place — the slot map did not resolve it
   * — and stays null rather than becoming "unassigned", which would write a
   * real value over something nobody read.
   */
  entries: readonly (KeyBinding | null)[]
}

/**
 * The three advanced-key tables, base64 of the bytes the board handed over.
 *
 * Base64 rather than an array of numbers because 1.5 KB of `[144,0,0,...]` is
 * most of the file and none of it is meant to be read by a human.
 */
export interface ProfileAdvancedKeys {
  dks: string
  pair: string
  toggle: string
}

/** What a file says about the board it was taken from. */
export interface ProfileDevice {
  /** `DeviceSpec.id` — which definition drove the read. */
  specId: string
  /** `DeviceSpec.name`, for a file opened on a board that has no such spec. */
  name: string
  vendorId: number
  productId: number
  /** Keys in the layout, which every per-key array is expected to be as long as. */
  keyCount: number
  /**
   * The board's firmware identity at the time of the save, when it answered.
   *
   * Shown on import and never checked. The reply is a build name and a compile
   * date, not a version (see `FirmwareIdentity`), so a mismatch is not grounds
   * to refuse anything — it is grounds to say so.
   */
  firmware?: string
}

export interface ProfileDocument {
  version: number
  /** ISO 8601, from the machine that wrote the file. */
  savedAt: string
  /** `versionLine()` of the build that wrote it, for a bug report to quote. */
  app: string
  device: ProfileDevice
  /**
   * The blocks this file actually carries.
   *
   * Every field optional, and absent rather than empty for a block that was
   * not read — the load dialog has to tell "this profile has no macros" apart
   * from "this profile does not say", and an empty array says the first.
   */
  blocks: {
    keyPerf?: readonly KeyConfig[]
    keymap?: readonly ProfileLayer[]
    macros?: readonly Macro[]
    advancedKeys?: ProfileAdvancedKeys
    /** One stored colour per key, `null` for a key with none. */
    keyRgb?: readonly (Rgb | null)[]
    /**
     * The board-wide settings, as the patch that would put them back.
     *
     * A patch rather than the whole `GlobalSettings` because that is what a
     * write takes, and because the read carries a raw payload whose undecoded
     * bytes belong to the board that produced them — writing another board's
     * would be putting back bytes nobody has decoded.
     */
    global?: GlobalPatch
  }
}

/** Which blocks a document actually carries, in `PROFILE_BLOCKS` order. */
export function blocksPresent(doc: ProfileDocument): ProfileBlock[] {
  return PROFILE_BLOCKS.filter((b) => doc.blocks[b] !== undefined)
}

/** Message key for a block's name, so the bundles stay checkable. */
export function blockKey(block: ProfileBlock) {
  return `profile.block.${block}` as const
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64, by hand.
 *
 * `btoa` would do it, but only through a string built one character per byte,
 * and the same `atob` round trip has already gone wrong once elsewhere in this
 * family of apps when a byte above 0x7f met a source file's encoding. These
 * two are twelve lines and cannot.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

/** Returns null for anything that is not base64, rather than throwing. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]/g, '')
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let acc = 0
  let bits = 0
  let at = 0
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}
