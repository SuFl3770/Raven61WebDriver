/**
 * The demo board as a `DeviceSpec` — the same kind of definition a real board
 * has, because that is what makes the demo run the real code path.
 *
 * Nothing about the app is told there is a demo. `refreshCodec` probes the
 * registered specs against whatever the link is holding, and this one claims
 * the ids the simulated device enumerates as; everything downstream — the key
 * grid, the slot map, the panels, the write verification — comes from here the
 * way it comes from `boards/raven61/index.ts` for the real board.
 *
 * ## Why it is not under `device/boards/`
 *
 * A built-in board is a claim about hardware someone can buy. This is not one,
 * so it lives with the rest of the demo and registers itself only when the demo
 * is started (see `state/demo.ts`). `origin: 'demo'` is what keeps it out of
 * the places that answer "what real hardware do we know" — the device chooser's
 * filter and the interface ranking, in `hid/filters.ts`.
 *
 * ## What it inherits, and what it does not
 *
 * The protocol is `DEFAULT_PROTOCOL`, which is the Raven61's, because that is
 * the one this project has decoded and the whole point is to exercise it. Two
 * sections differ, and both follow from the board being wider than a 60 %:
 *
 *   - **Calibration records.** 64 is the Raven61's sensor count, and 87 keys do
 *     not fit in it. The table is 128 records here, which is also what the
 *     per-key blocks are wide.
 *   - **Unused slots.** The Raven61 has three dead channels in its slot space,
 *     found in a hardware dump. This board's wiring is whatever this file says
 *     it is, and inventing holes to match someone else's board would be
 *     inventing evidence — so the slots run straight through.
 */

import { DEFAULT_PROTOCOL } from '../device/protocols/default'
import { RAVEN61_PROFILE_SUPPORT } from '../protocol/layers'
import { RAVEN61_REPORT_RATES } from '../device/boards/raven61/index'
import { RAVEN61_SWITCH_TYPES } from '../device/boards/raven61/switches'
import type { DeviceSpec } from '../device/spec'
import { DEMO_TKL_LAYOUT } from './layout'

/**
 * Ids no product reports.
 *
 * `ffff:ffff` is not an assigned USB vendor and cannot collide with a board
 * someone owns — which matters, because a spec is matched on these and a demo
 * that claimed a real pair would drive that keyboard with this file's key
 * count. It is also what the device card prints, where it reads as exactly what
 * it is.
 */
export const DEMO_VENDOR_ID = 0xffff
export const DEMO_PRODUCT_ID = 0xffff

/** Calibration records, one per slot of the per-key blocks. */
const DEMO_CAL_RECORDS = DEFAULT_PROTOCOL.keyPerf.slots

export const demoSpec: DeviceSpec = {
  id: 'demo-tkl-87',
  name: 'Demo TKL',
  labelKey: 'codec.demo.label',
  notesKey: 'codec.demo.notes',
  /**
   * Not a boast. Confidence is how far the codec is trusted against the board
   * in front of it, and here the board is this project's own simulation of the
   * protocol — the pairing is exact by construction. What it does not mean is
   * that anything here was confirmed on hardware; `notesKey` says so, and the
   * Raven61's own spec still says `partial` for the parts that were.
   */
  confidence: 'confirmed',
  origin: 'demo',
  usb: { vendorId: DEMO_VENDOR_ID, productIds: [DEMO_PRODUCT_ID] },
  layout: DEMO_TKL_LAYOUT,
  ...DEFAULT_PROTOCOL,
  calibration: { ...DEFAULT_PROTOCOL.calibration, records: DEMO_CAL_RECORDS },
  slotMap: { ...DEFAULT_PROTOCOL.slotMap, unusedSlots: [] },
  switchTypes: RAVEN61_SWITCH_TYPES,
  reportRates: RAVEN61_REPORT_RATES,
  profileSupport: RAVEN61_PROFILE_SUPPORT,
}
