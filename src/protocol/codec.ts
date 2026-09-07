import type { DeviceSpec } from '../device/spec'
import type { HidLink } from '../hid/link'
import { t, type MessageKey } from '../i18n'
import type { CalRecord } from './calibration'
import type {
  FactoryResetResult,
  FactoryResetStage,
  KeymapWriteResult,
  KeyPerfWriteResult,
  KeyRgbWriteResult,
} from './engine'
import type { GlobalPatch, GlobalWriteResult } from './global'
import type { Rgb } from './keyRgb'
import type { ProfileSupport } from './layers'
import type { SlotMap } from './slotMap'
import type {
  DeviceInfo,
  FirmwareIdentity,
  GlobalSettings,
  KeyConfig,
  KeyPerfSnapshot,
  KeyRgbSnapshot,
  KeySample,
  KeymapEntry,
} from './types'

/**
 * How much we trust a codec against real hardware. Surfaced in the UI so a
 * guessed protocol is never mistaken for a confirmed one.
 */
export type Confidence = 'confirmed' | 'partial' | 'guess' | 'none'

/**
 * A protocol binding for one keyboard.
 *
 * Most codecs are not written by hand: `createCodec` in `engine.ts` builds one
 * from a `DeviceSpec`, and adding a board means adding a spec. This interface
 * is what that produces, and it is also the seam for a board whose protocol is
 * a different shape altogether — such a codec implements this directly and
 * registers itself the same way.
 *
 * Every capability is optional on purpose: during reverse engineering we learn
 * commands one at a time, and the UI enables panels as methods appear rather
 * than waiting for a complete implementation.
 */
export interface KeyboardCodec {
  readonly id: string
  /** Display name. For a built-in board, `labelKey` overrides it. */
  readonly name: string
  /**
   * Message key for the codec's display name — see i18n/locales.
   *
   * Only a built-in codec can have one: `MessageKey` is derived from the
   * reference bundle at compile time, so a spec loaded from JSON has no way to
   * name a key that exists. Those use `name` and `notes`. Read both through
   * `codecLabel` / `codecNotes` rather than reaching for either directly.
   */
  readonly labelKey?: MessageKey
  readonly confidence: Confidence
  /** Free-text notes, for a codec with no `notesKey`. */
  readonly notes?: string
  /** Message key for the notes rendered next to the connection status. */
  readonly notesKey?: MessageKey

  /**
   * The board this codec was built for, when it came from a spec.
   *
   * Panels read framing and command bytes off it to show what they are about
   * to send. A hand-written codec may leave it undefined; a caller that needs
   * the layout should use the active-device store instead, which always has
   * one.
   */
  readonly spec?: DeviceSpec

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

  /**
   * Puts the board into analog test mode and takes it out again.
   *
   * Lower level than `startMonitor`, and separate from it because three panels
   * need the mode without the sample mapping: the events tab decodes raw
   * payloads, the sensors tab keeps its own per-key state, and calibration
   * holds the mode open with `keepAlive`.
   */
  armAnalogStream?(
    link: HidLink,
    opts?: { keepAlive?: boolean },
  ): Promise<() => Promise<void>>

  /**
   * The board's own calibration table — what the firmware learned about each
   * switch, and what it lights the key LEDs from.
   */
  readCalibration?(link: HidLink): Promise<CalRecord[]>

  /**
   * Which key sits in which slot of the per-key blocks, read off the board.
   *
   * Exposed because a panel that shows slots has to say where the mapping came
   * from: a fallback map puts most keys in the right place and a few in the
   * wrong one. `SlotMap.source` is that answer.
   */
  readSlotMap?(link: HidLink): Promise<{ map: SlotMap; blob?: Uint8Array }>

  /**
   * What each key of one layer is bound to, in this board's key order.
   *
   * A layer rather than the whole block because that is the unit the board
   * addresses and the unit the stock driver writes.
   */
  readKeymap?(link: HidLink, layer: number): Promise<KeymapEntry[]>

  /**
   * Rebinds keys of one layer, and checks that the write took.
   *
   * `null` for a key leaves it alone: the block is wider than the board's keys,
   * so a write built from this app's model alone would put zeros over
   * everything else. Read-modify-write, like the performance block.
   */
  writeKeymap?(
    link: HidLink,
    layer: number,
    entries: readonly (KeymapEntry | null)[],
  ): Promise<KeymapWriteResult>

  /**
   * What the board left the factory with, for the keys of one layer. `null` for
   * a key the read cannot speak for.
   *
   * Separate from `readKeymap` because it is a different block — the factory
   * table in code flash rather than the live one — and because a UI that offers
   * "put this key back" must not do it from this app's idea of the default.
   */
  readKeymapDefaults?(link: HidLink, layer: number): Promise<(KeymapEntry | null)[]>

  /**
   * The stored per-key custom colours — the only lighting block this project
   * has decoded. See `protocol/keyRgb.ts`.
   *
   * Separate from `readLightFrame` because they are different memories with
   * different answers: this is the layer that survives a power cycle, that one
   * is what the LEDs are showing this instant.
   */
  readKeyColors?(link: HidLink): Promise<KeyRgbSnapshot>

  /**
   * Sets the colour of named keys, and checks that the write took.
   *
   * `null` for a key leaves it alone — the block is wider than the board's
   * keys, so a write built from this app's model would zero everything else.
   * Read-modify-write, like every other block here.
   *
   * A verified write means *the bytes are in the block*. Whether the key lights
   * up depends on the lighting mode, and no command for that has been decoded,
   * so a codec cannot promise it and a panel must not imply it.
   */
  writeKeyColors?(link: HidLink, colors: readonly (Rgb | null)[]): Promise<KeyRgbWriteResult>

  /**
   * Puts a whole colour block back, byte for byte — the undo for the write
   * above, using the bytes the board had rather than this app's idea of them.
   */
  restoreKeyRgb?(link: HidLink, blob: Uint8Array): Promise<void>

  /**
   * The LED frame the board is displaying right now, effects and the firmware's
   * calibration overlay included.
   *
   * Read-only, and not a settings read: it is a RAM buffer the effect engine
   * rewrites every frame. It exists so the app can show whether a stored colour
   * is actually reaching the LEDs, which is the one thing a verified write to
   * the stored layer cannot say.
   */
  readLightFrame?(link: HidLink): Promise<KeyRgbSnapshot>

  /**
   * The same frame, over and over, so a panel can show which keys are lit as it
   * happens. Resolves to a function that stops it.
   *
   * Shaped like `startMonitor` because it is the same kind of thing — a stream
   * a panel subscribes to and must be able to stop — and separate from
   * `readLightFrame` because a watch reads the slot map once and a one-shot
   * read cannot. It is what the stock driver does with its idle time; see
   * `watchLightFrame` in engine.ts.
   */
  watchLightFrame?(
    link: HidLink,
    onFrame: (snapshot: KeyRgbSnapshot) => void,
    opts?: { intervalMs?: number; onError?: (message: string) => void },
  ): Promise<() => void>

  /**
   * What this board's layers or profiles actually are — how many, what they
   * carry, and whether the host can switch them. See protocol/layers.ts.
   *
   * A plain value rather than a method because it is a property of the
   * firmware family, not something the board is asked. A codec that leaves it
   * undefined is saying "not looked at", which is not the same as `kind:
   * 'none'`.
   */
  readonly profileSupport?: ProfileSupport

  /**
   * Which layer or profile the board is on.
   *
   * Unimplemented everywhere so far. On Raven61 the byte is readable — global
   * settings offset 1 — but reading it alone would be a panel that shows a
   * number nobody can change, so it waits for a board where the pair below
   * exists too.
   */
  readActiveProfile?(link: HidLink): Promise<number>

  /**
   * Switches to one.
   *
   * The capability that decides whether a profile UI is possible at all. On
   * Raven61 there is no such command: only a key action moves the layer, so
   * this stays undefined rather than being faked by rewriting blocks. A codec
   * for a sibling that does expose profiles implements this first.
   */
  writeActiveProfile?(link: HidLink, index: number): Promise<void>

  /** Persist the working set to the board's flash, where the protocol needs it. */
  commit?(link: HidLink): Promise<void>

  /**
   * ⚠⚠ Puts the board back to its factory settings, losing everything
   * configured on it.
   *
   * Last in this interface because it is last in every other sense: it is the
   * only capability whose whole purpose is to destroy state, and a UI offering
   * it owes the user a confirmation rather than a button. See `factoryReset`
   * in engine.ts for what the firmware does and what it leaves alone.
   */
  factoryReset?(
    link: HidLink,
    onStage?: (stage: FactoryResetStage) => void,
  ): Promise<FactoryResetResult>
}

/**
 * The old name, from when this app spoke to one board.
 *
 * Kept so nothing outside has to change in the same commit as the split; new
 * code says `KeyboardCodec`.
 */
export type Raven61Codec = KeyboardCodec

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
  | 'armAnalogStream'
  | 'readCalibration'
  | 'readSlotMap'
  | 'readKeymap'
  | 'writeKeymap'
  | 'readKeymapDefaults'
  | 'readKeyColors'
  | 'writeKeyColors'
  | 'restoreKeyRgb'
  | 'readLightFrame'
  | 'watchLightFrame'
  | 'readActiveProfile'
  | 'writeActiveProfile'
  | 'commit'
  | 'factoryReset'

export function supports(codec: KeyboardCodec, cap: Capability): boolean {
  return typeof (codec as unknown as Record<string, unknown>)[cap] === 'function'
}

/**
 * What to show for a codec's name.
 *
 * A built-in board names a translation key; one loaded from a user's JSON
 * cannot, so it carries the string itself. Every call site goes through this
 * rather than deciding for itself, which is what keeps a user-supplied board
 * from rendering as a blank label.
 */
export function codecLabel(codec: KeyboardCodec): string {
  return codec.labelKey ? t(codec.labelKey) : codec.name
}

/** The same for the notes line. Empty when the codec has nothing to say. */
export function codecNotes(codec: KeyboardCodec): string {
  return codec.notesKey ? t(codec.notesKey) : (codec.notes ?? '')
}
