/**
 * Demo mode: the app with a board in front of it that is not there.
 *
 * Everything this app does is a view onto a device, so without one there is a
 * connect screen and nothing else — which leaves anyone who wants to see what
 * the configurator *is* needing to buy the keyboard first. This opens a
 * simulated one instead. It is not a separate UI and not a set of stubs: a
 * software board is handed to the same `HidLink`, and from there the codec is
 * probed, the blocks are read chunk by chunk and every write is verified by
 * reading back, exactly as they are over USB. See `src/demo/board.ts`.
 *
 * The flag below is derived rather than stored. "Is this a demo" is a question
 * about which device the link holds, and a second copy of that answer could
 * disagree with the link — which is the one bug this mode must not have, since
 * the whole UI hangs off it saying so.
 */

import { useSyncExternalStore } from 'react'
import { registerDevice } from '../device/registry'
import { DemoHidDevice } from '../demo/device'
import { demoSpec } from '../demo/spec'
import { link, refreshCodec } from './link'

/**
 * What the simulated device enumerates as.
 *
 * The ids are the demo spec's, because that is how a codec is chosen — probing
 * is vendor and product, so a device reporting anything else would take the
 * "no definition for what is plugged in" path instead of the app. They belong
 * to no product (`ffff:ffff`, see `demo/spec.ts`), which is what keeps a real
 * keyboard from ever matching this definition. The *name* is where it says
 * what it is: that is what the device card shows, and it must never read as
 * hardware.
 */
const DEMO_DEVICE = {
  vendorId: demoSpec.usb.vendorId,
  productId: demoSpec.usb.productIds[0]!,
  // The spec's name already says what it is, and the device card prints it
  // beside `ffff:ffff` under a badge reading "demo". Three of those is two too
  // many.
  productName: demoSpec.name,
  payloadLength: demoSpec.frame.payloadLength,
} as const

export function isDemo(): boolean {
  return link.device instanceof DemoHidDevice
}

/**
 * Opens the simulated board. A real device already attached is left alone.
 *
 * There is no matching `stopDemo`: leaving is closing the link, which is what
 * the device card's disconnect button already does for every board. A second
 * way to do the same thing is a second thing that can drift out of step with
 * `link.connected`.
 */
export async function startDemo(): Promise<void> {
  if (isDemo()) return
  // Registered on the way in rather than at import, so a session that never
  // asks for the demo never has a board in the registry that is not one.
  // Duplicates are ignored, so starting the demo twice is not a problem.
  registerDevice(demoSpec)
  const device = new DemoHidDevice(DEMO_DEVICE)
  // The link's contract is `HIDDevice`; this implements the part of it the link
  // uses. See the note on the class for why it does not declare the rest.
  await link.open(device as unknown as HIDDevice)
  await refreshCodec()
}

export function useDemo(): boolean {
  return useSyncExternalStore(
    (fn) => link.onChange(fn),
    () => isDemo(),
  )
}
