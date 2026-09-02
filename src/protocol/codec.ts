import type { HidLink } from '../hid/link'
import type { DeviceInfo, KeyConfig, KeySample, KeymapEntry } from './types'

/**
 * How much we trust a codec against real hardware. Surfaced in the UI so a
 * guessed protocol is never mistaken for a confirmed one.
 */
export type Confidence = 'confirmed' | 'partial' | 'guess' | 'none'

/**
 * A protocol binding for one firmware family.
 *
 * Every capability is optional on purpose: during reverse engineering we learn
 * commands one at a time, and the UI enables panels as methods appear rather
 * than waiting for a complete implementation.
 */
export interface Raven61Codec {
  readonly id: string
  readonly label: string
  readonly confidence: Confidence
  /** Human-readable notes rendered next to the connection status. */
  readonly notes?: string

  /** Cheap, side-effect-free check that this codec matches the attached device. */
  probe(link: HidLink): Promise<boolean>

  readDeviceInfo?(link: HidLink): Promise<DeviceInfo>

  readKeyConfigs?(link: HidLink): Promise<KeyConfig[]>
  writeKeyConfigs?(link: HidLink, configs: readonly (KeyConfig | null)[]): Promise<void>

  /**
   * Streams analog travel. Resolves to an unsubscribe that stops the stream.
   *
   * `arm: false` listens without enabling reporting at all. `keepAlive` repeats
   * the enable packet, which is what the stock driver's calibration mode does —
   * it suppresses typing and recalibrates, so it is never the default.
   */
  startMonitor?(
    link: HidLink,
    onSample: (samples: KeySample[]) => void,
    opts?: { arm?: boolean; keepAlive?: boolean },
  ): Promise<() => Promise<void>>

  readKeymap?(link: HidLink, layer: number): Promise<KeymapEntry[]>
  writeKeymap?(link: HidLink, layer: number, entries: readonly (KeymapEntry | null)[]): Promise<void>

  /** Persist the working set to the board's flash, where the protocol needs it. */
  commit?(link: HidLink): Promise<void>
}

export type Capability =
  | 'readDeviceInfo'
  | 'readKeyConfigs'
  | 'writeKeyConfigs'
  | 'startMonitor'
  | 'readKeymap'
  | 'writeKeymap'
  | 'commit'

export function supports(codec: Raven61Codec, cap: Capability): boolean {
  return typeof (codec as unknown as Record<string, unknown>)[cap] === 'function'
}
