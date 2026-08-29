import { useSyncExternalStore } from 'react'
import { DEFAULT_TRAVEL_MM, KEY_COUNT } from '../keyboard/raven61'
import { FACTORY_DEFAULTS, countsToMm } from '../protocol/encoding'
import type { KeyConfig } from '../protocol/types'

/** Factory defaults, converted from the profile 0 counts in `t_config_data`. */
export function defaultKeyConfig(): KeyConfig {
  return {
    actuationMm: countsToMm(FACTORY_DEFAULTS.actuation),
    mode: 'normal',
    rapidTrigger: {
      enabled: false,
      pressMm: countsToMm(FACTORY_DEFAULTS.rapidTriggerPress),
      releaseMm: countsToMm(FACTORY_DEFAULTS.rapidTriggerRelease),
      separate: false,
      continuous: false,
    },
    deadZone: {
      enabled: false,
      topMm: countsToMm(FACTORY_DEFAULTS.deadZoneTop),
      bottomMm: countsToMm(FACTORY_DEFAULTS.deadZoneBottom),
    },
  }
}

/**
 * Working copy of the per-key settings. Edits land here first; pushing to the
 * board is an explicit action so an un-decoded protocol never writes silently.
 */
class ConfigStore {
  private configs: KeyConfig[] = Array.from({ length: KEY_COUNT }, defaultKeyConfig)
  private dirty = new Set<number>()
  /** Cached snapshot: useSyncExternalStore requires a stable identity between mutations. */
  private dirtyList: readonly number[] = []
  private listeners = new Set<() => void>()
  travelMm = DEFAULT_TRAVEL_MM

  all(): readonly KeyConfig[] {
    return this.configs
  }

  get(index: number): KeyConfig {
    return this.configs[index] ?? defaultKeyConfig()
  }

  dirtyIndices(): readonly number[] {
    return this.dirtyList
  }

  update(indices: Iterable<number>, patch: (c: KeyConfig) => KeyConfig): void {
    const next = this.configs.slice()
    for (const i of indices) {
      const current = next[i]
      if (!current) continue
      next[i] = patch(current)
      this.dirty.add(i)
    }
    this.configs = next
    this.emit()
  }

  /** Replaces the whole set, e.g. after reading from the board. */
  load(configs: readonly KeyConfig[]): void {
    this.configs = configs.slice(0, KEY_COUNT)
    while (this.configs.length < KEY_COUNT) this.configs.push(defaultKeyConfig())
    this.dirty.clear()
    this.emit()
  }

  markClean(): void {
    this.dirty.clear()
    this.emit()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.dirtyList = [...this.dirty].sort((x, y) => x - y)
    for (const fn of this.listeners) fn()
  }
}

export const configStore = new ConfigStore()

export function useKeyConfigs(): readonly KeyConfig[] {
  return useSyncExternalStore(
    (fn) => configStore.subscribe(fn),
    () => configStore.all(),
  )
}

export function useDirtyKeys(): readonly number[] {
  return useSyncExternalStore(
    (fn) => configStore.subscribe(fn),
    () => configStore.dirtyIndices(),
  )
}
