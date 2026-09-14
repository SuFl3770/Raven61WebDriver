/**
 * The Raven61: what the hardware *is*.
 *
 * How it talks is `protocol.ts`, which keys it has is `layout.json`, and which
 * switches it takes is `switches.json`. What is left here is the identity — the
 * ids it enumerates as, the polling rates it accepts, and how its layers
 * work.
 *
 * It doubles as the worked example. A sibling board copies this folder, changes
 * what its own captures say is different and leaves the rest inherited — see
 * `src/device/README.md`.
 */

import { RAVEN61_PROFILE_SUPPORT } from '../../../protocol/layers'
import type { DeviceSpec, ReportRateSpec } from '../../spec'
import { RAVEN61_LAYOUT } from './layout'
import { RAVEN61_PROTOCOL } from './protocol'
import { RAVEN61_LIGHT_EFFECTS } from './lighting'
import { RAVEN61_SWITCH_TYPES } from './switches'

/**
 * Device ids recovered from the stock driver binary. It matches devices by the
 * Windows hardware id `VID_19F5&PID_xxxx&MI_01`, i.e. always USB interface 1 —
 * the vendor interface, not the keyboard interface.
 */
export const RAVEN_VENDOR_ID = 0x19f5

/**
 * The product id this spec speaks to, and the only one.
 *
 * `0xFED0` is what the **firmware's own identity page** reports — flash
 * 0x20000 reads `f5 19 d0 fe 10 01`, i.e. VID 0x19F5, PID 0xFED0, bcdDevice
 * 0x0110 (docs/protocol.md §2.10). That is the board every byte in
 * `src/protocol` was decoded from.
 *
 * The other two ids below come from the stock driver's string pool, whose
 * name-to-id pairing is documented as unreliable — and the driver ships layout
 * files for three different boards. So `0xFE20` and `0xFEB1` are most likely a
 * Raven68 and an ABT68: **different key counts, and a protocol nobody here has
 * tested.** Claiming them would mean driving an untested board with this one's
 * command bytes, so they are deliberately not in `productIds`.
 *
 * If a board reporting one of them turns out to answer this protocol, add its
 * id here — after it has answered, not before.
 */
export const RAVEN61_PRODUCT_ID = 0xfed0

/**
 * The vendor's other ids — recorded, and deliberately not claimed.
 *
 * Nothing matches on these. They are here so the next person does not have to
 * re-derive why the driver lists three ids while this spec answers one, and so
 * that adding one later is a two-line change with the reason attached. A board
 * reporting one of them still appears in the device chooser (which filters by
 * vendor) and can be opened — it simply gets no codec.
 */
export const RAVEN_FAMILY_PRODUCT_IDS = [0xfe20, 0xfeb1] as const

/** Layout files shipped by the stock driver, for reference. */
export const RAVEN_FAMILY = ['Raven61', 'Raven68', 'ABT68'] as const

/**
 * `reporte_rate` (the vendor's own typo) — the USB polling rate.
 *
 * The value on the wire is *not* a rate, and not an index into the list as it
 * reads either: it is the number the stock driver attaches to each item of its
 * own report-rate combo box (built at 0x4443ef-0x444527, one AddString per
 * entry with the value pushed alongside the language-string id).
 *
 * The shipped profile database agrees: `reporte_rate` is 1 in the default
 * profile and 4 in the three user profiles, the two ends of that range and
 * nothing outside it. 8000 Hz being on the list is not a mistake either — the
 * firmware calls itself `HALL_HS_USB_KB`, and high speed is what it takes.
 *
 * Nothing here is confirmed against hardware: no capture of the stock driver
 * changing the rate has been taken, so the pairing rests on the driver's own
 * table alone.
 */
export const RAVEN61_REPORT_RATES: readonly ReportRateSpec[] = [
  { value: 1, hz: 8000 },
  { value: 2, hz: 4000 },
  { value: 3, hz: 2000 },
  { value: 4, hz: 1000 },
] as const

/**
 * Framing, the per-key performance block and the keymap are decoded and
 * confirmed on hardware. The lighting and advanced-key blocks are not — so
 * this spec names no command for them, and the panels that would need one say
 * "not decoded" rather than showing controls that do nothing.
 */
export const raven61Spec: DeviceSpec = {
  id: 'raven61-v1',
  name: 'Raven61',
  labelKey: 'codec.raven61.label',
  notesKey: 'codec.raven61.notes',
  confidence: 'partial',
  origin: 'built-in',
  usb: {
    vendorId: RAVEN_VENDOR_ID,
    // One id, on purpose. See RAVEN61_PRODUCT_ID.
    productIds: [RAVEN61_PRODUCT_ID],
  },
  layout: RAVEN61_LAYOUT,
  ...RAVEN61_PROTOCOL,
  switchTypes: RAVEN61_SWITCH_TYPES,
  reportRates: RAVEN61_REPORT_RATES,
  lightEffects: RAVEN61_LIGHT_EFFECTS,
  /**
   * Layers, not profiles — two of them, keymap only, no host-side switch.
   * Declared so a future profile panel can ask instead of assuming. See
   * protocol/layers.ts for how the firmware gets there. [fw], not
   * hardware-verified.
   */
  profileSupport: RAVEN61_PROFILE_SUPPORT,
  /**
   * The stock driver's exported profile, decoded from two of them — see
   * `docs/protocol.md` §5.5 and `src/profile/stock.ts`.
   *
   * `proName` is what both files carry in `info@pro_name`, and it is checked
   * on import rather than ignored: the driver ships layouts for three boards
   * and writes this string from the one the profile was taken on.
   */
  stockProfile: {
    format: 'raven-xor-xml',
    proName: 'Raven61 HE',
    macroSlots: 10,
    /*
     * Two, not the four `fn_layer` values the file carries.
     *
     * The stock export writes rows for layers 2 and 3, and the board has no
     * storage behind either: the firmware indexes four, but layer 2 lands on
     * the per-key RGB blob and layer 3 on the macro table (see
     * `protocol/layers.ts`). The rows are inert in the file and writing them
     * would not be. So this app reads and writes the two that exist, and says
     * out loud that it skipped the rest.
     */
    layers: [0, 1],
    derivedLayers: [101],
  },
}
