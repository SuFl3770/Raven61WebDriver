/**
 * Profile files: one door in, two ways out.
 *
 * A load takes bytes and works out what they are rather than trusting the
 * extension. A stock export is recognised by its first two bytes (`47 44`, `<?`
 * XOR'd), a plain XML by `<?xml`, and anything else is tried as JSON — which
 * means a stock file someone renamed to `.json`, or a JSON someone saved as
 * `.xml`, both open.
 *
 * `format` comes back with the document because the two are not interchangeable
 * afterwards: a stock file carries a subset (see `stock.ts`), and a panel that
 * offers "save it back the way it came" has to know which way that was.
 */

import type { DeviceSpec } from '../device/spec'
import { t } from '../i18n'
import { parseJsonProfile, ProfileParseError } from './json'
import type { ProfileDocument } from './model'
import { isStockProfile, parseStockProfile, StockParseError } from './stock'

export type ProfileFormat = 'json' | 'stock'

export interface LoadedProfile {
  doc: ProfileDocument
  format: ProfileFormat
  /**
   * What the reader noticed but did not treat as a failure — a `pro_name` from
   * another board, records it could not convert. Machine-readable tags rather
   * than sentences, because the bundle is where sentences live.
   */
  notes: string[]
}

/** Both formats' extensions, for the file picker's `accept`. */
export const PROFILE_ACCEPT = '.json,.xml,application/json,application/xml,text/xml'

function looksLikeXml(bytes: Uint8Array): boolean {
  // `<?xml` — a plaintext export, or a file someone has already unmasked.
  return bytes[0] === 0x3c && bytes[1] === 0x3f
}

/**
 * Reads a profile file.
 *
 * Throws `ProfileParseError` or `StockParseError`; both carry a message worth
 * showing. Nothing here checks whether the document can go on the board — that
 * is `checkProfile`, and it needs the live spec rather than the file.
 */
export function loadProfile(bytes: Uint8Array, spec: DeviceSpec): LoadedProfile {
  if (isStockProfile(bytes) || looksLikeXml(bytes)) {
    // Translated, unlike the errors `stock.ts` raises: this one is reached by
    // opening the wrong file on the wrong board, which is an ordinary mistake
    // rather than a malformed file, and it is shown to the person who made it.
    if (!spec.stockProfile) {
      throw new StockParseError(t('profile.load.noStockFormat', { board: spec.name }))
    }
    const { doc, notes } = parseStockProfile(bytes, spec)
    return { doc, format: 'stock', notes }
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  return { doc: parseJsonProfile(text), format: 'json', notes: [] }
}

export { ProfileParseError, StockParseError }
export * from './model'
export { checkProfile, anyApplicable, type BlockReport, type ProfileReport } from './check'
export {
  captureProfile,
  type CaptureProgress,
  type CaptureResult,
  type CaptureStage,
} from './capture'
export { applyProfile, type ApplyProgress, type ApplyResult, type BlockOutcome } from './apply'
export { encodeJsonProfile, JSON_PROFILE } from './json'
export { encodeStockProfile, lossless, STOCK_PROFILE, type StockLoss } from './stock'
