/**
 * Raven61 physical layout: ANSI 60 %, 61 keys, 15u x 5u.
 *
 * The rows are in `layout.json` beside this file, written by
 * `tools/layout/from-vendor-xml.mjs` out of the stock driver's
 * `layouts/Raven61.xml`. **That file is generated — do not hand-edit it; change
 * the generator and re-run.** This one is written by hand and is not
 * regenerated, which is the point of the split: the column notes below survive
 * the next regeneration, and the generator only ever rewrites numbers.
 *
 * Data only. The lookups live in `src/device/layout.ts`, which builds them for
 * whichever board is attached; this file is one `LayoutSpec`, and
 * `boards/raven61/index.ts` is what puts it into a device.
 *
 * - `index`      this file's ordering (row-major, left to right); what the UI uses.
 * - `code`       the key's default HID usage — **decimal in the JSON**, because
 *                JSON has no hex literals, and hex everywhere else in this app.
 *                Esc is 41 there and 0x29 in `docs/protocol.md`.
 * - `keyIndex`   the FIRMWARE's key address, used in every protocol command.
 *                It is not contiguous and does not follow the visual order:
 *                Backspace is 92, Enter 76, Menu 109.
 * - `lightIndex` per-key LED address. Mostly equal to keyIndex; the vendor XML
 *                lists 37 for both "-" and "T", which looks like their bug.
 *
 * The import is assigned field by field rather than handed over whole, so the
 * compiler checks each one and the JSON's `//` notes stay out of the spec.
 * A misspelt *field name* is still invisible to it — `tools/check/
 * device-spec.ts` puts this layout through the validator a user's JSON gets,
 * which is what catches that, along with an ordering the slot map would
 * silently resolve wrong.
 */
import type { KeyDef, LayoutSpec } from '../../spec'
import raw from './layout.json'

export const RAVEN61_KEYS: KeyDef[] = raw.keys

export const RAVEN61_LAYOUT: LayoutSpec = {
  units: raw.units,
  /** Full travel, in mm. Confirmed on hardware: every key event reports 200 counts. */
  travelMm: raw.travelMm,
  keys: RAVEN61_KEYS,
}
