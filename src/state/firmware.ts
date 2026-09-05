import { useSyncExternalStore } from 'react'
import type { FirmwareIdentity } from '../protocol/types'

/**
 * Which firmware the attached board is running, read once and kept.
 *
 * A store rather than component state because the settings tab is unmounted
 * every time another tab is open, and the read would otherwise go out again on
 * each visit. The answer cannot change while a device stays attached — a
 * firmware update takes the device away with it — so one read per connection is
 * exactly the right number.
 */
class FirmwareStore {
  private identity: FirmwareIdentity | null = null
  private listeners = new Set<() => void>()

  current(): FirmwareIdentity | null {
    return this.identity
  }

  load(identity: FirmwareIdentity): void {
    this.identity = identity
    this.emit()
  }

  /** Dropped on disconnect: the next board is not promised to be this one. */
  clear(): void {
    this.identity = null
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

export const firmwareStore = new FirmwareStore()

export function useFirmware(): FirmwareIdentity | null {
  return useSyncExternalStore(
    (fn) => firmwareStore.subscribe(fn),
    () => firmwareStore.current(),
  )
}
