/**
 * Which board the app is currently showing.
 *
 * The key grid, the selection, the per-key panels and the working config set
 * all need a key table, and they need it synchronously, on every render —
 * which is why this is a small store with a plain getter rather than something
 * awaited. It holds one `DeviceSpec`, and everything else is derived.
 *
 * It also carries whether the attached device actually *matched* a spec.
 * Before anything is connected, and for a device no spec claims, `matched` is
 * false and `spec` is only a placeholder so the layout code has a shape to work
 * with — the UI must not draw it as if it were the board in front of the user.
 * `KeyGrid` checks this, and the panels are already inert because the codec for
 * an unrecognised device implements nothing.
 *
 * `setActiveSpec` is called from `state/link.ts` when a device is opened or
 * closed. A change means the key table changed under everything holding an
 * index, so the stores that key on one clear themselves — see the subscriber
 * there.
 */

import { useSyncExternalStore } from 'react'
import { layoutOf, type Layout } from './layout'
import { defaultSpec } from './registry'
import type { DeviceSpec } from './spec'

/** The attached board, and whether a spec actually claimed it. */
export interface ActiveDevice {
  spec: DeviceSpec
  /**
   * True only when a registered spec matched this device's vendor *and*
   * product id. False means "no definition for what is plugged in" — `spec` is
   * then a placeholder, not a description of the hardware.
   */
  matched: boolean
  /**
   * ⚠ True while the debug-only switch is driving an unrecognised device with
   * the default protocol.
   *
   * Never true at the same time as `matched`: a board with a definition of its
   * own has nothing to force. The UI has to keep saying this out loud — the
   * key grid it draws is a placeholder, and the bytes it sends are another
   * keyboard's. See `device/forced.ts`.
   */
  forced: boolean
}

let active: ActiveDevice = { spec: defaultSpec(), matched: false, forced: false }
const listeners = new Set<() => void>()

/** The board the UI is laid out for. Never null; see `matched`. */
export function activeSpec(): DeviceSpec {
  return active.spec
}

export function activeDevice(): ActiveDevice {
  return active
}

/** Its key table and lookups. Cached per spec, so calling this is cheap. */
export function activeLayout(): Layout {
  return layoutOf(active.spec.layout)
}

/**
 * Switches boards. Does nothing when nothing changed, so a reconnect of the
 * same keyboard does not clear anyone's state.
 */
export function setActiveDevice(
  spec: DeviceSpec,
  state: { matched: boolean; forced?: boolean } = { matched: false },
): void {
  const forced = state.forced ?? false
  if (spec === active.spec && state.matched === active.matched && forced === active.forced) return
  active = { spec, matched: state.matched, forced }
  for (const fn of listeners) fn()
}

export function subscribeActiveSpec(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDeviceSpec(): DeviceSpec {
  return useSyncExternalStore(subscribeActiveSpec, activeSpec)
}

export function useActiveDevice(): ActiveDevice {
  return useSyncExternalStore(subscribeActiveSpec, activeDevice)
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeActiveSpec, activeLayout)
}
