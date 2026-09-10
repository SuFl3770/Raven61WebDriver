import { useSyncExternalStore } from 'react'
import { activeLayout, activeSpec } from '../device/active'
import { FACTORY_DEFAULTS, countsToMm } from '../protocol/encoding'
import type { KeyConfig } from '../protocol/types'

/**
 * How many keys the attached board has.
 *
 * Read on every use rather than captured once: the key count changes when a
 * different board is opened, and a size captured at module load would be the
 * first board's forever.
 */
function keyCount(): number {
  return activeLayout().count
}

/** Factory defaults, converted from the profile 0 counts in `t_config_data`. */
export function defaultKeyConfig(): KeyConfig {
  return {
    actuationMm: countsToMm(FACTORY_DEFAULTS.actuation),
    mode: 'normal',
    rapidTrigger: {
      enabled: false,
      pressMm: countsToMm(FACTORY_DEFAULTS.rapidTriggerPress),
      releaseMm: countsToMm(FACTORY_DEFAULTS.rapidTriggerRelease),
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
  private configs: KeyConfig[] = Array.from({ length: keyCount() }, defaultKeyConfig)
  /**
   * What the board had at the last read. Kept so an edit can be shown as a
   * change from the hardware rather than as a bare number, and so it can be
   * dropped again without a re-read.
   */
  private baseline: readonly KeyConfig[] = Array.from({ length: keyCount() }, defaultKeyConfig)
  /**
   * When the board was last read, or null if it never was.
   *
   * This gates writing. Until a read happens the set holds factory defaults,
   * and those carry no switch type — writing them would announce switch type 0
   * for every key touched. The codec guards that too (see fromKeyConfig), but
   * an app that writes values it never read is wrong regardless.
   */
  private readAt: Date | null = null
  private dirty = new Set<number>()
  /** Cached snapshot: useSyncExternalStore requires a stable identity between mutations. */
  private dirtyList: readonly number[] = []
  private listeners = new Set<() => void>()
  travelMm = activeSpec().layout.travelMm

  all(): readonly KeyConfig[] {
    return this.configs
  }

  get(index: number): KeyConfig {
    return this.configs[index] ?? defaultKeyConfig()
  }

  dirtyIndices(): readonly number[] {
    return this.dirtyList
  }

  /** The last values read from the board, whether or not they have been edited. */
  base(): readonly KeyConfig[] {
    return this.baseline
  }

  /** When the board was last read. Null until it has been. */
  lastRead(): Date | null {
    return this.readAt
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
    const count = keyCount()
    this.configs = configs.slice(0, count)
    while (this.configs.length < count) this.configs.push(defaultKeyConfig())
    // A read is the only thing that moves the baseline: it is the one moment
    // this app knows what the hardware holds.
    this.baseline = this.configs.slice()
    this.readAt = new Date()
    this.dirty.clear()
    this.emit()
  }

  /** Throws away edits to `indices`, restoring the last values read. */
  revert(indices: Iterable<number>): void {
    const next = this.configs.slice()
    for (const i of indices) {
      const base = this.baseline[i]
      if (!base) continue
      next[i] = base
      this.dirty.delete(i)
    }
    this.configs = next
    this.emit()
  }

  /**
   * Back to "nothing has been read".
   *
   * Not the same as loading factory defaults, and the difference is the point:
   * after a factory reset this app does not know what the board holds, and the
   * set it was holding is now a description of a board that no longer exists.
   * Clearing `readAt` disarms the write path too — see the note on it — so the
   * next write has to follow a real read.
   */
  clear(): void {
    this.travelMm = activeSpec().layout.travelMm
    this.configs = Array.from({ length: keyCount() }, defaultKeyConfig)
    this.baseline = this.configs.slice()
    this.readAt = null
    this.dirty.clear()
    this.emit()
  }

  /**
   * Marks keys as written. With no argument, all of them.
   *
   * The argument matters once writing happens on its own: a write takes a few
   * hundred milliseconds, and anything the user changes while it is in flight
   * must stay dirty so the next write picks it up. Clearing the whole set on
   * completion would drop those edits on the floor.
   */
  markClean(indices?: Iterable<number>): void {
    if (indices === undefined) this.dirty.clear()
    else for (const i of indices) this.dirty.delete(i)
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

export function useBaseline(): readonly KeyConfig[] {
  return useSyncExternalStore(
    (fn) => configStore.subscribe(fn),
    () => configStore.base(),
  )
}

export function useLastRead(): Date | null {
  return useSyncExternalStore(
    (fn) => configStore.subscribe(fn),
    () => configStore.lastRead(),
  )
}

export function useDirtyKeys(): readonly number[] {
  return useSyncExternalStore(
    (fn) => configStore.subscribe(fn),
    () => configStore.dirtyIndices(),
  )
}
