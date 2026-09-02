import { useSyncExternalStore } from 'react'

/**
 * App preferences, kept out of the protocol layer and persisted per browser.
 *
 * `debug` decides whether the reverse-engineering panels are shown. They earned
 * their place while the protocol was being decoded, but for someone who just
 * wants to see key travel they are noise — so they are off by default and the
 * settings tab turns them back on.
 */
export interface Settings {
  debug: boolean
}

const STORAGE_KEY = 'raven61.settings.v1'

const DEFAULTS: Settings = { debug: false }

class SettingsStore {
  private value: Settings = DEFAULTS
  private listeners = new Set<() => void>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.value = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      // A corrupt or unavailable store just means defaults.
    }
  }

  current(): Settings {
    return this.value
  }

  set<K extends keyof Settings>(key: K, next: Settings[K]): void {
    if (this.value[key] === next) return
    this.value = { ...this.value, [key]: next }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value))
    } catch {
      // Private browsing and blocked storage are fine; it is only a preference.
    }
    for (const fn of this.listeners) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const settings = new SettingsStore()

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => settings.subscribe(fn),
    () => settings.current(),
  )
}
