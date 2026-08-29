import { useSyncExternalStore } from 'react'
import { matchFingerprint } from '../keyboard/fingerprints'
import { RAVEN61_KEYS, keyByUsage } from '../keyboard/raven61'
/** The fields needed to identify a key, common to events and samples. */
export interface KeyIdentity {
  usage: number
  usageIsReal: boolean
  fingerprint: string
  sensorId: number
  adcBaseline: number
}

const STORAGE_KEY = 'raven61.sensorMap.v2'

/**
 * Identity of the key an analog event came from.
 *
 * Most keys name themselves: `payload[3]` carries their HID usage. Modifiers
 * report 0x00 and Fn reports 0x01, because HID has no keycode-array usage for
 * them, so those have to be identified some other way.
 *
 * `payload[12..13]` looked like a per-key sensor address, but it is not unique —
 * P and "/" share a value — so it is combined with the resting ADC baseline,
 * which does differ per key. That pair is the fingerprint.
 */
export function identityOf(event: KeyIdentity): string {
  return event.usageIsReal ? `usage:${event.usage}` : `fp:${event.fingerprint}`
}

/** Fingerprint -> key index, for the keys that do not name themselves. */
class SensorMap {
  private map = new Map<string, number>()
  private listeners = new Set<() => void>()
  private snapshot: ReadonlyMap<string, number> = new Map()

  constructor() {
    this.load()
    this.snapshot = new Map(this.map)
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      for (const [fp, index] of JSON.parse(raw) as [string, number][]) {
        if (RAVEN61_KEYS[index]) this.map.set(fp, index)
      }
    } catch {
      // A corrupt or unavailable store just means we start empty.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.map]))
    } catch {
      // Private browsing and blocked storage are fine; bindings are re-learnable.
    }
  }

  current(): ReadonlyMap<string, number> {
    return this.snapshot
  }

  /**
   * Key index for an event, or undefined when it still needs binding.
   *
   * A binding made here wins, so a board whose baselines have shifted can be
   * re-taught without editing the built-in table.
   */
  resolve(event: KeyIdentity): number | undefined {
    if (event.usageIsReal) return keyByUsage(event.usage)?.index
    const bound = this.map.get(event.fingerprint)
    if (bound !== undefined) return bound
    return matchFingerprint(event.sensorId, event.adcBaseline)?.keyIndex
  }

  /** True when the built-in table already covers this event. */
  isBuiltIn(event: KeyIdentity): boolean {
    return !event.usageIsReal && matchFingerprint(event.sensorId, event.adcBaseline) !== undefined
  }

  bind(fingerprint: string, keyIndex: number): void {
    this.map.set(fingerprint, keyIndex)
    this.commit()
  }

  unbind(fingerprint: string): void {
    this.map.delete(fingerprint)
    this.commit()
  }

  clear(): void {
    this.map.clear()
    this.commit()
  }

  private commit(): void {
    this.save()
    this.snapshot = new Map(this.map)
    for (const fn of this.listeners) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Emits the bindings as source, ready to paste into the layout. */
  toSource(): string {
    const rows = [...this.map]
      .sort((a, b) => a[1] - b[1])
      .map(([fp, index]) => `  ['${fp}', ${index}], // ${RAVEN61_KEYS[index]?.label ?? '?'}`)
    return `export const KEY_FINGERPRINTS = new Map<string, number>([\n${rows.join('\n')}\n])`
  }
}

export const sensorMap = new SensorMap()

export function useSensorMap(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (fn) => sensorMap.subscribe(fn),
    () => sensorMap.current(),
  )
}
