import { useSyncExternalStore } from 'react'
import { KEY_COUNT } from '../keyboard/raven61'

/** Key selection is shared across tabs so switching panels keeps your context. */
class SelectionStore {
  private set: ReadonlySet<number> = new Set()
  private listeners = new Set<() => void>()

  current(): ReadonlySet<number> {
    return this.set
  }

  toggle(index: number, additive: boolean): void {
    const next = new Set(additive ? this.set : [])
    if (additive && this.set.has(index)) next.delete(index)
    else next.add(index)
    this.set = next
    this.emit()
  }

  selectAll(): void {
    this.set = new Set(Array.from({ length: KEY_COUNT }, (_, i) => i))
    this.emit()
  }

  clear(): void {
    this.set = new Set()
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

/** Falls back to "all keys" so an edit with nothing selected still means something. */
export function targetKeys(sel: ReadonlySet<number>): number[] {
  return sel.size > 0 ? [...sel] : Array.from({ length: KEY_COUNT }, (_, i) => i)
}
