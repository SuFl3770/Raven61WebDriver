import type { HidLink } from '../hid/link'
import type { MessageKey } from '../i18n'
import type {
  DeviceInfo,
  GlobalSettings,
  KeyConfig,
  KeyPerfSnapshot,
  KeySample,
  KeymapEntry,
} from './types'

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
  /** Message key for the codec's display name — see i18n/locales. */
  readonly labelKey: MessageKey
  readonly confidence: Confidence
  /** Message key for the notes rendered next to the connection status. */
  readonly notesKey?: MessageKey

  /** Cheap, side-effect-free check that this codec matches the attached device. */
  probe(link: HidLink): Promise<boolean>

  readDeviceInfo?(link: HidLink): Promise<DeviceInfo>

  readKeyConfigs?(link: HidLink): Promise<KeyConfig[]>
  writeKeyConfigs?(link: HidLink, configs: readonly (KeyConfig | null)[]): Promise<void>

  /**
   * The same read, but keeping the raw block. Panels prefer this so they can
   * show the bytes next to the decoded values — during reverse engineering a
   * decoded view alone can look right while being indexed wrongly.
   */
  readKeyPerf?(link: HidLink): Promise<KeyPerfSnapshot>

  /**
   * Board-wide settings. Separate from the per-key ones because they are a
   * separate block on the wire, and because one of the performance tab's
   * switches — "always trigger when bottoming" — lives here rather than per key.
   */
  readGlobalSettings?(link: HidLink): Promise<GlobalSettings>

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
  | 'readKeyPerf'
  | 'readGlobalSettings'
  | 'startMonitor'
  | 'readKeymap'
  | 'writeKeymap'
  | 'commit'

export function supports(codec: Raven61Codec, cap: Capability): boolean {
  return typeof (codec as unknown as Record<string, unknown>)[cap] === 'function'
}
