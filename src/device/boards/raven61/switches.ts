/**
 * The Raven61's switch table — which magnetic switches it reports, and what is
 * known about each one.
 *
 * The rows live in `switches.json` beside this file; what is left here is the
 * type and the provenance. Splitting it that way costs one indirection and
 * buys two things: the table can be edited, diffed and copied without touching
 * code — it is the same shape as the `switchTypes` list in a
 * `src/device/user/*.device.json`, so a row moves either way — while every
 * sentence explaining where its numbers came from stays in a file that can
 * hold sentences. JSON cannot, and this table is mostly footnotes.
 *
 * The import is assigned to a typed constant with no cast, so a row whose
 * `travelMm` came through as a string is a build error. What that does *not*
 * catch is a misspelt field name — TypeScript ignores extra keys on an
 * imported value, so `"colour"` would simply never paint. `tools/check/
 * device-spec.ts` runs the shipped table through the same validator a user's
 * JSON gets, and rejects unknown fields there.
 *
 * ## What each column is worth
 *
 * Only `value` and `travelMm` reach the hardware or the arithmetic. `value` is
 * what gets written into the low 5 bits of the perf record, and `travelMm` is
 * the stroke every millimetre in this app is measured against — get it wrong
 * and actuation, rapid trigger and the depth bars are all wrong together.
 *
 * `vendor`, `magnetGauss` and `color` are description. Nothing is written from
 * them and no number is computed from them: they are there so the list reads
 * as the switches on someone's desk instead of seven names. An entry with none
 * of them is exactly as correct as one with all three — see `SwitchTypeSpec`
 * in `src/device/spec.ts`.
 *
 * ## Where the names and the travel came from
 *
 * **Names are hardware-derived.** Each type was set for the whole board in the
 * stock driver and read back here, so the value-to-name pairing is measured,
 * not inferred. That matters because it contradicts the binary: the stock
 * driver pushes language strings 1450-1457 in ascending order as varargs
 * (0x44af0d-0x44aff8), which would put Light Breeze at 0, and hardware says 0
 * is Magnetic Orange. Four of the eight came out swapped that way — 0 with 4,
 * and 1 with 3 — while 2, 5, 6 and 7 matched. So that vararg list is not the
 * order the selector ends up in, and how it gets reordered is still unknown.
 *
 * Travel comes from a dword table at 0x576c8c, and stays attached to the *value*
 * rather than the name: the driver indexes it with the raw `switch_type`
 * (0x43a7df), the same number it hands to SetCurSel. Its 3.32 / 3.80 / 3.50 /
 * 3.40 / 2.50 mm entries are why total stroke cannot be assumed to be 4 mm for
 * every board.
 *
 * ## The eighth entry, and why it is not here
 *
 * The driver's table has eight names; this one has seven. `Chocolate Dwarf`
 * was value 7, and it is not a part that exists — the board's owner checked it
 * against hardware and found dummy data, so the row is gone rather than
 * carried as an entry nobody may choose. A board that somehow reported 7 now
 * shows up as a value not in the table, which is the honest reading of a
 * number nothing is known to answer to.
 *
 * `selectable` stays in the schema for the next board that ships a name with
 * nothing behind it. Every row here is selectable.
 *
 * ## The vendor, magnet and colour columns
 *
 * These three are description: nothing is written from them, and no number is
 * computed from them. They are filled in by somebody holding the switches —
 * the driver's table is a list of names, a travel and nothing else, so none of
 * this came out of the binary and none of it can be checked against it.
 *
 * The colours are a swatch for picking a row out of a list, not a claim about
 * a particular batch's dye. Where one is missing the app draws its hatch and
 * says nothing, which is what an empty field should look like.
 */

import type { SwitchTypeSpec } from '../../spec'
import table from './switches.json'

export const RAVEN61_SWITCH_TYPES: readonly SwitchTypeSpec[] = table.switchTypes
