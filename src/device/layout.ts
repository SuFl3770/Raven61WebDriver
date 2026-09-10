/**
 * Lookups over a board's key table.
 *
 * The layout used to be a module of constants and three `Map`s built beside
 * them, which is fine for one board and impossible for two. This builds the
 * same lookups from a `LayoutSpec` and caches them per spec object, so a
 * component can call `layoutOf(spec)` on every render without rebuilding
 * anything.
 *
 * Nothing here reads the active device — that is `active.ts`. This is the pure
 * part, so the protocol engine can use it for a board that is not the one on
 * screen.
 */

import type { KeyDef, LayoutSpec } from './spec'

export interface Layout {
  readonly keys: readonly KeyDef[]
  readonly units: { width: number; height: number }
  /** Full travel in mm for a key whose switch type says nothing better. */
  readonly travelMm: number
  readonly count: number
  /** By this table's own index — what every UI selection is. */
  byIndex(index: number): KeyDef | undefined
  /**
   * By HID usage. The analog event stream and the stock database address keys
   * this way; `keyIndex` is the firmware's own addressing and the two are not
   * interchangeable.
   */
  byUsage(usage: number): KeyDef | undefined
  /** By firmware key address. */
  byFirmwareIndex(keyIndex: number): KeyDef | undefined
}

const CACHE = new WeakMap<LayoutSpec, Layout>()

export function layoutOf(spec: LayoutSpec): Layout {
  const cached = CACHE.get(spec)
  if (cached) return cached
  const built = buildLayout(spec)
  CACHE.set(spec, built)
  return built
}

function buildLayout(spec: LayoutSpec): Layout {
  const keys = spec.keys
  const byIndex = new Map(keys.map((k) => [k.index, k]))
  const byUsage = new Map<number, KeyDef>()
  const byFirmwareIndex = new Map<number, KeyDef>()
  for (const key of keys) {
    // First one wins, so a layout that repeats a usage — two "Shift" caps that
    // both claim 0xe1, say — resolves to the earlier key rather than silently
    // moving. `validate.ts` reports the duplicate; this keeps it harmless.
    if (!byUsage.has(key.code)) byUsage.set(key.code, key)
    if (!byFirmwareIndex.has(key.keyIndex)) byFirmwareIndex.set(key.keyIndex, key)
  }
  return {
    keys,
    units: spec.units,
    travelMm: spec.travelMm,
    count: keys.length,
    byIndex: (index) => byIndex.get(index),
    byUsage: (usage) => byUsage.get(usage),
    byFirmwareIndex: (keyIndex) => byFirmwareIndex.get(keyIndex),
  }
}
