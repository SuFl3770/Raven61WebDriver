/**
 * Every board this build knows about, and the codec for each.
 *
 * Built-ins come from `specs/index.ts`. User specs are registered at startup by
 * `userSpecs.ts`, which is imported from the app entry point only — keeping the
 * glob out of this module is what lets `tools/check` bundle the protocol layer
 * under node.
 *
 * A codec is built once per spec and cached: `createCodec` closes over lookup
 * tables, and rebuilding one on every probe would throw them away.
 */

import { createCodec } from '../protocol/engine'
import type { KeyboardCodec } from '../protocol/codec'
import type { DeviceSpec } from './spec'
import { BUILT_IN_SPECS, DEFAULT_SPEC } from './boards'

/**
 * User specs first.
 *
 * Someone who writes a spec for hardware this app already claims has a reason:
 * their board answers differently. Trying theirs first means they do not have
 * to edit a built-in to be heard.
 */
const userSpecs: DeviceSpec[] = []

const CODECS = new WeakMap<DeviceSpec, KeyboardCodec>()

/**
 * Adds a spec to the registry. Ignores a duplicate id, keeping the first.
 *
 * Returns whether it was added, so the loader can say which of a user's files
 * was skipped rather than leaving them wondering which of two won.
 */
export function registerDevice(spec: DeviceSpec): boolean {
  if (allSpecs().some((s) => s.id === spec.id)) return false
  userSpecs.push(spec)
  return true
}

export function allSpecs(): readonly DeviceSpec[] {
  return [...userSpecs, ...BUILT_IN_SPECS]
}

/**
 * The specs that describe hardware — everything but the demo board.
 *
 * `allSpecs` is "what can this app drive", which the codec lookup wants. This
 * is "what might be at the other end of a USB cable", which is a different
 * question and the one the device chooser and the interface ranking are asking:
 * a simulated board contributes a vendor id no device reports and a report
 * shape that would score a real interface for no reason. See `hid/filters.ts`.
 */
export function hardwareSpecs(): readonly DeviceSpec[] {
  return allSpecs().filter((s) => s.origin !== 'demo')
}

export function specById(id: string): DeviceSpec | undefined {
  return allSpecs().find((s) => s.id === id)
}

export function codecFor(spec: DeviceSpec): KeyboardCodec {
  const cached = CODECS.get(spec)
  if (cached) return cached
  const codec = createCodec(spec)
  CODECS.set(spec, codec)
  return codec
}

/** The board whose layout the UI shows when nothing is attached. */
export function defaultSpec(): DeviceSpec {
  return DEFAULT_SPEC
}

/**
 * The spec whose USB ids match an attached device, if any.
 *
 * Matching happens here as well as in each codec's `probe` because the two
 * answer different questions: this one is "which board is this" and can be
 * asked of a device that is not open, while `probe` is "will this codec speak
 * to the link in front of it". Both are exact: vendor **and** product.
 *
 * `undefined` is the normal answer for a device nobody has written a spec for,
 * and it is what keeps this app's one decoded protocol away from boards it has
 * never been tested against.
 */
export function specForDevice(device: HIDDevice | null): DeviceSpec | undefined {
  if (!device) return undefined
  return allSpecs().find(
    (s) => s.usb.vendorId === device.vendorId && s.usb.productIds.includes(device.productId),
  )
}
