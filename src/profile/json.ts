/**
 * This app's own profile file: the document, as JSON.
 *
 * The format is the model (`model.ts`) written out, which is the point of it —
 * every block this app can read is a block it can save, with nothing dropped
 * on the way through. The stock XML cannot say that (see `stock.ts`), so this
 * is what a save defaults to and the only format offered on a board whose
 * vendor file nobody has decoded.
 *
 * ## What this file does and does not check
 *
 * Parsing answers one question: is this a profile document at all. Shape only
 * — the envelope, the block containers, the array-ness of the arrays. Whether
 * the *values* can go on a board is `check.ts`, against the live spec, and
 * doing it here as well would be two answers to one question with only one of
 * them shown.
 *
 * So this rejects a JSON file that is not a profile and accepts one that is,
 * however unusable its contents turn out to be.
 */

import { versionLine } from '../version'
import { PROFILE_VERSION, type ProfileDocument } from './model'

/** The file extension and MIME type a save writes. */
export const JSON_PROFILE = { extension: '.json', mime: 'application/json' } as const

export function encodeJsonProfile(doc: ProfileDocument): string {
  // Two spaces and a trailing newline: the file is meant to be diffable and to
  // survive a text editor without a spurious "no newline at end of file".
  return `${JSON.stringify(doc, null, 2)}\n`
}

export class ProfileParseError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses a JSON profile, or throws `ProfileParseError` naming what is missing.
 *
 * The envelope is checked field by field rather than with a cast. A cast would
 * make `doc.device.keyCount` a number as far as the compiler is concerned and
 * `undefined` at run time, and the first thing that touches it is a comparison
 * that decides whether to offer a write.
 */
export function parseJsonProfile(text: string): ProfileDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ProfileParseError(e instanceof Error ? e.message : String(e))
  }
  if (!isObject(raw)) throw new ProfileParseError('root is not an object')

  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProfileParseError('version is missing or not a positive integer')
  }

  const device = raw.device
  if (!isObject(device)) throw new ProfileParseError('device is missing')
  for (const field of ['specId', 'name'] as const) {
    if (typeof device[field] !== 'string') throw new ProfileParseError(`device.${field} is not a string`)
  }
  for (const field of ['vendorId', 'productId', 'keyCount'] as const) {
    if (typeof device[field] !== 'number') throw new ProfileParseError(`device.${field} is not a number`)
  }

  const blocks = raw.blocks
  if (!isObject(blocks)) throw new ProfileParseError('blocks is missing')

  // Container shapes only. An array of the wrong things is `check.ts`'s to
  // refuse, and it says which element and why; a non-array cannot get that far.
  for (const field of ['keyPerf', 'keymap', 'macros', 'keyRgb'] as const) {
    if (blocks[field] !== undefined && !Array.isArray(blocks[field])) {
      throw new ProfileParseError(`blocks.${field} is not an array`)
    }
  }
  for (const field of ['advancedKeys', 'global'] as const) {
    if (blocks[field] !== undefined && !isObject(blocks[field])) {
      throw new ProfileParseError(`blocks.${field} is not an object`)
    }
  }

  return raw as unknown as ProfileDocument
}

/** The envelope a capture fills in, so `capture.ts` does not repeat it. */
export function profileEnvelope(device: ProfileDocument['device']): ProfileDocument {
  return {
    version: PROFILE_VERSION,
    savedAt: new Date().toISOString(),
    app: versionLine(),
    device,
    blocks: {},
  }
}
