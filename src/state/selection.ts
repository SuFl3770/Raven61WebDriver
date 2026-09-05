import { useSyncExternalStore } from 'react'
import { KEY_COUNT } from '../keyboard/raven61'

/**
 * Which keys the per-key panels act on.
 *
 * Cleared when the main tab changes. It used to be kept, on the reasoning that
 * carrying a selection between panels saves re-picking it — but the panels that
 * share it are all inside one tab now, and a selection made three tabs ago is
 * invisible context that the next write silently obeys. Leaving a tab is the
 * clearest "I am done with those keys" there is.
 */
class SelectionStore {
  private set: ReadonlySet<number> = new Set()
  private listeners = new Set<() => void>()

  current(): ReadonlySet<number> {
    return this.set
  }

  /**
   * Flips one key.
   *
   * Plain, with no "additive" flag. It used to take one: an unmodified click
   * replaced the whole selection and only Shift or Ctrl added to it, which is
   * the convention for lists of files, not for a keyboard. Picking out the WASD
   * cluster is the normal case here, not the exception, and it should not need
   * a second hand — so every click is additive and the grid paints on drag.
   */
  toggle(index: number): void {
    const next = new Set(this.set)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    this.set = next
    this.emit()
  }

  /** Sets one key to a given state. What a drag across the grid uses. */
  setSelected(index: number, on: boolean): void {
    if (this.set.has(index) === on) return
    const next = new Set(this.set)
    if (on) next.add(index)
    else next.delete(index)
    this.set = next
    this.emit()
  }

  selectAll(): void {
    this.set = new Set(Array.from({ length: KEY_COUNT }, (_, i) => i))
    this.emit()
  }

  clear(): void {
    if (this.set.size === 0) return
    this.set = new Set()
    this.emit()
  }

  /** Replaces the whole selection. What a marquee drag rewrites as it moves. */
  replace(indices: Iterable<number>): void {
    const next = new Set(indices)
    if (next.size === this.set.size && [...next].every((i) => this.set.has(i))) return
    this.set = next
    this.emit()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

export const selection = new SelectionStore()

export function useSelection(): ReadonlySet<number> {
  return useSyncExternalStore(
    (fn) => selection.subscribe(fn),
    () => selection.current(),
  )
}

/**
 * The keys an edit applies to. Empty when nothing is selected.
 *
 * It used to fall back to every key, so that an edit with no selection still
 * did something. What it did was change all 61 — and now that a change is
 * written to the board the moment it is made, brushing a slider with nothing
 * selected rewrote the whole keyboard. The panels disable their controls on an
 * empty selection instead.
 */
export function targetKeys(sel: ReadonlySet<number>): number[] {
  return [...sel]
}
