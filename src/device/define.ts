/**
 * `defineDevice` — state what your board does differently, inherit the rest.
 *
 * **Inheritance is opt-in, and `basedOn` is how you opt in.** There is one
 * decoded protocol here, the Raven61's, and no evidence that any other board
 * answers to it: the vendor ships at least three models and this app has been
 * tested against one. So a spec does not quietly pick up another board's
 * framing, command bytes and block sizes by existing — it says whose protocol
 * it claims to speak, and that claim is kept on the spec afterwards.
 *
 * ```ts
 * export const raven68Spec = defineDevice({
 *   id: 'raven68-v1',
 *   name: 'Raven68',
 *   confidence: 'guess',
 *   // "I have checked that this board answers the Raven61's protocol."
 *   basedOn: 'raven61-v1',
 *   usb: { vendorId: 0x19f5, productIds: [0xfe20] },
 *   layout: RAVEN68_LAYOUT,
 *   commands: { factoryReset: null },   // not confirmed on this board yet
 * })
 * ```
 *
 * Without `basedOn` a spec must state every section itself, which the type
 * below enforces — that is the path for a board whose protocol was decoded
 * separately.
 *
 * Inheritance is per *leaf*, not per section: naming one command leaves the
 * other thirteen alone, and naming one global offset leaves the rest. That is
 * deliberate — a partial section is the normal case when a board is only half
 * decoded, and forcing a full copy would mean copying numbers nobody checked.
 *
 * `confidence` is required rather than inherited. Inheriting it would let a
 * board that has never been plugged in claim the Raven61's `'partial'`, and
 * that badge is the one thing in this app that tells a user whether to trust
 * what they are about to write.
 */

import { DEFAULT_PROTOCOL, DEFAULT_PROTOCOL_ID } from './protocols/default'
import { raven61Spec } from './boards/raven61/index'
import type { DeviceSpec, LayoutSpec } from './spec'

/**
 * The only protocol this build has decoded, and so the only thing to inherit.
 *
 * Re-exported from `protocols/default.ts` rather than spelled again, so the id
 * a definition has to name and the protocol it actually gets cannot drift
 * apart.
 */
export const BASE_PROTOCOL_ID = DEFAULT_PROTOCOL_ID

/** A spec that names a base, with every inherited section optional down to the leaf. */
export type DeviceSpecInput = {
  id: string
  name: string
  confidence: DeviceSpec['confidence']
  /**
   * Whose protocol this board is claimed to speak.
   *
   * A claim about hardware, not a convenience: everything inherited under it —
   * framing, command bytes, block geometry, record layout — is the Raven61's,
   * and nothing here can verify that your board agrees.
   */
  basedOn: typeof BASE_PROTOCOL_ID
  /** The key table. Never inherited: it is what makes a board that board. */
  layout: LayoutSpec
  usb: DeviceSpec['usb']
} & DeepPartial<Omit<DeviceSpec, 'id' | 'name' | 'confidence' | 'basedOn' | 'layout' | 'usb'>>

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object | null
      ? T[K] extends null
        ? T[K]
        : DeepPartial<NonNullable<T[K]>> | null
      : T[K]
}

/**
 * What a board inherits when it says nothing about a section.
 *
 * Two halves, and they come from different places on purpose. The protocol is
 * the frozen copy in `protocols/default.ts` — not the live Raven61 spec, so a
 * correction to that board does not silently rewrite what other boards were
 * tested against. The rest is the Raven61's board data, because a switch list
 * and a report-rate table have to be *something* and those are the only ones
 * anyone has measured.
 *
 * That second half is the weaker of the two: a board with different switches
 * inherits the wrong names until it states its own. `src/device/README.md`
 * says so in the walkthrough, and `confidence` is where a spec author admits
 * how far they got.
 */
export const FAMILY_BASELINE: DeviceSpec = {
  ...raven61Spec,
  ...DEFAULT_PROTOCOL,
}

export function defineDevice(input: DeviceSpecInput): DeviceSpec {
  return mergeSpec(FAMILY_BASELINE, input)
}

/**
 * A board whose protocol was decoded on its own — nothing is inherited.
 *
 * Takes a complete spec, so the compiler is what checks that every section is
 * there. Use it when your board is *not* a Raven61 underneath; use
 * `defineDevice` when you have checked that it is.
 */
export function defineIndependentDevice(spec: DeviceSpec): DeviceSpec {
  return spec
}

/**
 * Merges a partial spec over a complete one.
 *
 * Arrays are replaced whole rather than merged element by element: a board's
 * switch list or key table is a statement about that board, and a half-merged
 * table would be a list of switches no board has.
 */
export function mergeSpec(base: DeviceSpec, patch: Record<string, unknown>): DeviceSpec {
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    patch,
  ) as unknown as DeviceSpec
  return normalise(merged, patch)
}

/**
 * Fixes up the one inherited value that cannot be right for every board.
 *
 * `slotMap.resolveTolerance` is "how many keys short of the full set a
 * keymap-derived mapping may come and still be trusted". The baseline's 4 is
 * sensible for a 61-key board and nonsense for a 4-key one, where it would
 * trust a mapping that resolved nothing. A board that states its own is left
 * alone — including one that states a bad value, which `validate.ts` then
 * reports rather than quietly correcting.
 */
function normalise(spec: DeviceSpec, patch: Record<string, unknown>): DeviceSpec {
  const stated = (patch.slotMap as Record<string, unknown> | undefined)?.resolveTolerance
  if (stated !== undefined) return spec
  const count = spec.layout.keys.length
  if (spec.slotMap.resolveTolerance < count) return spec
  return {
    ...spec,
    slotMap: { ...spec.slotMap, resolveTolerance: Math.max(0, count - 1) },
  }
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = deepMerge(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
