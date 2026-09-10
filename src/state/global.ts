import { useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../protocol/types'

/**
 * The board-wide settings block, shared.
 *
 * Two panels show it — the overview reads it as part of "what the board
 * currently has", and the bottom-out trigger edits one bit of it — and a copy
 * per panel would go stale the moment either wrote. One store, so a write
 * updates both.
 */
class GlobalStore {
  private settings: GlobalSettings | null = null
  private readAt: Date | null = null
  private listeners = new Set<() => void>()

  current(): GlobalSettings | null {
    return this.settings
  }

  lastRead(): Date | null {
    return this.readAt
  }

  load(settings: GlobalSettings): void {
    this.settings = settings
    this.readAt = new Date()
    this.emit()
  }

  /** Dropped on disconnect: stale global settings read as current ones. */
  clear(): void {
    this.settings = null
    this.readAt = null
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

export const globalStore = new GlobalStore()

export function useGlobalSettings(): GlobalSettings | null {
  return useSyncExternalStore(
    (fn) => globalStore.subscribe(fn),
    () => globalStore.current(),
  )
}
