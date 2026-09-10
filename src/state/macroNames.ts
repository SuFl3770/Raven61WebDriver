import { useSyncExternalStore } from 'react'

/**
 * What to call each macro slot — in this browser, because the board has nowhere
 * to put it.
 *
 * The macro store is an offset table and a run of 4-byte event records
 * (`protocol/macros.ts`) and that is all of it. There is no name field, no
 * length field, and no spare byte in a record to hide one in: every bit of the
 * four is accounted for by the player. So a name cannot be stored on the
 * keyboard, and this app does not pretend otherwise — the stock driver keeps
 * its own names in its SQLite file (`t_macro_data.name`, seeded as "M 1" to
 * "M 10") for exactly the same reason.
 *
 * That makes names a convenience and never an identity. The slot number is the
 * identity: it is what a keymap record carries, it is what the panel shows
 * beside the name, and a store moved to another machine still works with every
 * name gone. Nothing here is ever written to the board, and a slot with no name
 * is shown by its number rather than as blank.
 *
 * Keyed by device id as well as slot, because two attached boards have two
 * stores and slot 3 of one is not slot 3 of the other.
 */

const STORAGE_KEY = 'raven61.macroNames.v1'

/** `${deviceId}/${slot}` to the name. Flat, so the JSON round trip is trivial. */
type Names = Record<string, string>

function keyOf(deviceId: string, slot: number): string {
  return `${deviceId}/${slot}`
}

class MacroNameStore {
  private names: Names = {}
  private listeners = new Set<() => void>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'string') this.names[key] = value
          }
        }
      }
    } catch {
      // A corrupt or unavailable store just means no names. Slot numbers still
      // identify every macro, so there is nothing to recover and nothing to
      // warn about.
    }
  }

  current(): Names {
    return this.names
  }

  get(deviceId: string, slot: number): string {
    return this.names[keyOf(deviceId, slot)] ?? ''
  }

  /** Sets a name, or clears it when the text is empty or only spaces. */
  set(deviceId: string, slot: number, name: string): void {
    const key = keyOf(deviceId, slot)
    const trimmed = name.trim()
    if (trimmed === '') {
      if (!(key in this.names)) return
      const { [key]: _dropped, ...rest } = this.names
      this.names = rest
    } else {
      if (this.names[key] === trimmed) return
      this.names = { ...this.names, [key]: trimmed }
    }
    this.persist()
    this.emit()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.names))
    } catch {
      // Private browsing, or a full quota. The names stay for this session,
      // which is better than refusing the edit.
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

export const macroNames = new MacroNameStore()

/** Re-renders when any name changes. */
export function useMacroNames(): Names {
  return useSyncExternalStore(
    (fn) => macroNames.subscribe(fn),
    () => macroNames.current(),
    () => macroNames.current(),
  )
}

/** The name for one slot, or `''`. Subscribes to the store. */
export function useMacroName(deviceId: string, slot: number): string {
  const all = useMacroNames()
  return all[keyOf(deviceId, slot)] ?? ''
}
