/**
 * The Raven61's codec, and the module the hardware checks drive.
 *
 * Everything that used to be here is now in two places: the *behaviour* in
 * `engine.ts`, which works from a spec, and the *board* in
 * `device/boards/raven61/index.ts`. What is left is the binding of the two, plus
 * function-shaped wrappers for the callers that want to talk to a Raven61
 * specifically rather than to whatever is attached — which is what
 * `tools/check` is for.
 *
 * **Application code should not import this.** A panel wants the codec for the
 * board in front of the user, which is `useCodec()`; reaching for these would
 * work today only because there is one board.
 */

import { raven61Spec } from '../device/boards/raven61/index'
import type { HidLink } from '../hid/link'
import { createCodec, type EngineCodec } from './engine'

export const raven61Codec: EngineCodec = createCodec(raven61Spec)

export { raven61Spec }

/** Enters analog test mode, and leaves it when the returned function runs. */
export const armAnalogStream = (link: HidLink, opts?: { keepAlive?: boolean }) =>
  raven61Codec.armAnalogStream!(link, opts)

/** The board's calibration table. */
export const readCalTable = (link: HidLink) => raven61Codec.readCalTable(link)

/** Which key sits in which slot, read off the board. */
export const readSlotMap = (link: HidLink) => raven61Codec.readSlotMap(link)

export const readFirmware = (link: HidLink) => raven61Codec.readFirmware!(link)

export const readKeymapLayer = (link: HidLink, layer: number) =>
  raven61Codec.readKeymap!(link, layer)

export const writeKeymapLayer = (
  link: HidLink,
  layer: number,
  entries: Parameters<NonNullable<EngineCodec['writeKeymap']>>[2],
) => raven61Codec.writeKeymap!(link, layer, entries)

/** The three advanced-key tables, plus the keymap entries that name a record. */
export const readAdvancedKeys = (link: HidLink) => raven61Codec.readAdvancedKeys!(link)

export const writeAdvancedKey = (
  link: HidLink,
  record: number,
  rec: Parameters<NonNullable<EngineCodec['writeAdvancedKey']>>[2],
) => raven61Codec.writeAdvancedKey!(link, record, rec)

/** The stored per-key colour layer. */
export const readKeyColors = (link: HidLink) => raven61Codec.readKeyColors!(link)

export const writeKeyColors = (
  link: HidLink,
  colors: Parameters<NonNullable<EngineCodec['writeKeyColors']>>[1],
) => raven61Codec.writeKeyColors!(link, colors)

/** What the LEDs are showing right now — a RAM buffer, not the stored layer. */
export const readLightFrame = (link: HidLink) => raven61Codec.readLightFrame!(link)

/** The same, polled — what the stock driver does with its idle time. */
export const watchLightFrame = (
  link: HidLink,
  onFrame: Parameters<NonNullable<EngineCodec['watchLightFrame']>>[1],
  opts?: Parameters<NonNullable<EngineCodec['watchLightFrame']>>[2],
) => raven61Codec.watchLightFrame!(link, onFrame, opts)

export const writeKeyPerfConfigs = (
  link: HidLink,
  configs: Parameters<NonNullable<EngineCodec['writeKeyPerf']>>[1],
) => raven61Codec.writeKeyPerf!(link, configs)

export const readGlobalSettings = (link: HidLink) => raven61Codec.readGlobalSettings!(link)

export const writeGlobalSettings = (
  link: HidLink,
  patch: Parameters<NonNullable<EngineCodec['writeGlobalSettings']>>[1],
) => raven61Codec.writeGlobalSettings!(link, patch)

/** ⚠⚠ Throws the board's settings away. See `factoryReset` in engine.ts. */
export const factoryReset = (
  link: HidLink,
  onStage?: Parameters<NonNullable<EngineCodec['factoryReset']>>[1],
) => raven61Codec.factoryReset!(link, onStage)

/**
 * Re-exports of what moved, so an old import path still resolves to the same
 * value rather than to a subtly different one.
 */
export { decodeFirmwareIdentity, FACTORY_RESET_DEFAULTS as FACTORY_RESET } from './engine'
export {
  ANALOG_REPORT,
  FACTORY_GLOBAL,
  GLOBAL,
  GLOBAL_FLAGS,
  decodeGlobalSettings,
  globalWriteRequest,
  patchGlobalFlags,
  patchGlobalRate,
  type GlobalPatch,
  type GlobalWriteResult,
} from './global'
export type {
  FactoryResetResult,
  FactoryResetStage,
  KeymapWriteResult,
  KeyPerfWriteResult,
  KeyRgbWriteResult,
} from './engine'

/** The Raven61's analog-mode commands, for a panel that shows what it sends. */
export const MONITOR = {
  arm: raven61Spec.commands.analogTestOn!,
  disarm: raven61Spec.commands.analogTestOff!,
  rearmMs: raven61Spec.monitor.rearmMs,
  ackMs: raven61Spec.monitor.ackMs,
} as const
