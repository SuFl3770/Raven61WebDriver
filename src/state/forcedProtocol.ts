/**
 * The debug-only switch that lets an unrecognised board be driven with the
 * default protocol. See `src/device/forced.ts` for what that means and why it
 * is guarded.
 *
 * Two properties matter more than the code:
 *
 *   - **It is not persisted.** Every other preference in this app survives a
 *     reload; this one does not. Sending another keyboard's command bytes is a
 *     thing you do deliberately, in a session where you are watching the
 *     traffic log — not a setting that is quietly still on next week.
 *   - **It turns itself off on disconnect.** Unplugging is the end of the
 *     experiment. Leaving it armed would mean the next board plugged in gets
 *     forced without anyone asking for it.
 *
 * The store holds nothing but the flag: `state/link.ts` subscribes and
 * re-probes, which keeps the dependency pointing one way.
 */

import { useSyncExternalStore } from 'react'

let forced = false
const listeners = new Set<() => void>()

export function forcedProtocol(): boolean {
  return forced
}

export function setForcedProtocol(on: boolean): void {
  if (forced === on) return
  forced = on
  for (const fn of listeners) fn()
}

export function subscribeForcedProtocol(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useForcedProtocol(): boolean {
  return useSyncExternalStore(subscribeForcedProtocol, forcedProtocol)
}
