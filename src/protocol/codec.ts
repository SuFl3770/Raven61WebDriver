import type { HidLink } from '../hid/link'
import type { MessageKey } from '../i18n'
import type {
  FactoryResetResult,
  FactoryResetStage,
  GlobalPatch,
  GlobalWriteResult,
  KeyPerfWriteResult,
} from './raven61'
import type {
  DeviceInfo,
  FirmwareIdentity,
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

  /**
   * Which firmware the board is running. Separate from `readDeviceInfo`
   * because it is the one part of a DeviceInfo the board can actually be asked
   * for: the rest is either in the HID descriptor already or, like total
   * travel, a per-key property that no single number can stand for.
   */
  readFirmware?(link: HidLink): Promise<FirmwareIdentity>

  readKeyConfigs?(link: HidLink): Promise<KeyConfig[]>
  writeKeyConfigs?(link: HidLink, configs: readonly (KeyConfig | null)[]): Promise<void>

  /**
   * The same read, but keeping the raw block. Panels prefer this so they can
   * show the bytes next to the decoded values — during reverse engineering a
   * decoded view alone can look right while being indexed wrongly.
   */
  readKeyPerf?(link: HidLink): Promise<KeyPerfSnapshot>

  /**
   * The same write, reporting what it did: which slots changed, which keys had
   * no slot to write to, and whether the board read back what was sent.
   *
   * Panels prefer this over `writeKeyConfigs` for the last part. An
   * acknowledged write that the firmware ignored is indistinguishable from a
   * successful one unless something reads the bytes back.
   */
  writeKeyPerf?(
    link: HidLink,
    configs: readonly (KeyConfig | null)[],
  ): Promise<KeyPerfWriteResult>

  /**
   * Puts a whole performance blob back, byte for byte. Exists so a write can be
   * undone with the bytes the board had before it, rather than with this app's
   * idea of what they were.
   */
  restoreKeyPerf?(link: HidLink, blob: Uint8Array): Promise<void>

  /**
   * Board-wide settings. Separate from the per-key ones because they are a
   * separate block on the wire, and because one of the performance tab's
   * switches — "always trigger when bottoming" — lives here rather than per key.
   */
  readGlobalSettings?(link: HidLink): Promise<GlobalSettings>

  /**
   * Changes named fields of that block. A patch rather than a whole value
   * because the block is shared: most of it belongs to other screens, and one
   * byte of it is the analog-test pair that stops the board typing.
   *
   * The implementation reads the block, edits the named bits and writes it
   * back — which is what the stock driver does at both of its own call sites.
   */
  writeGlobalSettings?(link: HidLink, patch: GlobalPatch): Promise<GlobalWriteResult>

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

  /**
   * ⚠⚠ Puts the board back to its factory settings, losing everything
   * configured on it.
   *
   * Last in this interface because it is last in every other sense: it is the
   * only capability whose whole purpose is to destroy state, and a UI offering
   * it owes the user a confirmation rather than a button. See `factoryReset`
   * in raven61.ts for what the firmware does and what it leaves alone.
   */
  factoryReset?(
    link: HidLink,
    onStage?: (stage: FactoryResetStage) => void,
  ): Promise<FactoryResetResult>
}

export type Capability =
  | 'readDeviceInfo'
  | 'readFirmware'
  | 'readKeyConfigs'
  | 'writeKeyConfigs'
  | 'readKeyPerf'
  | 'writeKeyPerf'
  | 'restoreKeyPerf'
  | 'readGlobalSettings'
  | 'writeGlobalSettings'
  | 'startMonitor'
  | 'readKeymap'
  | 'writeKeymap'
  | 'commit'
  | 'factoryReset'

export function supports(codec: Raven61Codec, cap: Capability): boolean {
  return typeof (codec as unknown as Record<string, unknown>)[cap] === 'function'
}
