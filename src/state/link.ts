import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { activeSpec, setActiveDevice, subscribeActiveSpec } from '../device/active'
import { forcedCodecFor, forcedSpecFor } from '../device/forced'
import { defaultSpec, specForDevice } from '../device/registry'
import { HidLink } from '../hid/link'
import { t } from '../i18n'
import type { TrafficEntry } from '../hid/log'
import { codecLabel, type KeyboardCodec } from '../protocol/codec'
import { selectCodec } from '../protocol/registry'
import { unknownCodec } from '../protocol/unknown'
import { configStore } from './config'
import { firmwareStore } from './firmware'
import { globalStore } from './global'
import { macroSnapshotStore } from './macroSnapshot'
import { forcedProtocol, setForcedProtocol, subscribeForcedProtocol } from './forcedProtocol'
import { selection } from './selection'

/** One link per page: WebHID hands out a single handle per device anyway. */
export const link = new HidLink()

// A disconnect invalidates everything read off the board. Leaving the global
// block or the firmware identity behind would show one device's settings while
// another is attached.
link.onChange(() => {
  if (link.connected) return
  globalStore.clear()
  firmwareStore.clear()
  macroSnapshotStore.clear()
})

/**
 * A different board means a different key table, so everything keyed by a key
 * index is now about a keyboard that is not attached. Clearing is the only
 * honest option: a selection or a working set carried across would name keys of
 * the old layout.
 */
let lastSpec = activeSpec()
subscribeActiveSpec(() => {
  // Only when the *board* changed. The same board being recognised or not does
  // not move a key index, and clearing then would throw away a working set for
  // nothing.
  if (activeSpec() === lastSpec) return
  lastSpec = activeSpec()
  configStore.clear()
  selection.clear()
  // Kept by key index and by slot, both of which are the old board's.
  macroSnapshotStore.clear()
})

let codec: KeyboardCodec = unknownCodec
const codecListeners = new Set<() => void>()

function setCodec(next: KeyboardCodec): void {
  codec = next
  for (const fn of codecListeners) fn()
}

/**
 * Re-probes, and points the UI at the board that answered.
 *
 * A device no spec claims gets `unknownCodec` — which implements nothing — and
 * `matched: false`. That is the separation this app relies on: one protocol has
 * been decoded, on one board, and an unrecognised keyboard is never driven with
 * it on the theory that it is probably a sibling. The layout still falls back to
 * a placeholder because the grid needs a shape, and `matched` is what stops the
 * UI presenting that shape as the user's keyboard.
 */
export async function refreshCodec(): Promise<void> {
  if (!link.connected) {
    setActiveDevice(defaultSpec(), { matched: false })
    setCodec(unknownCodec)
    return
  }
  const next = await selectCodec(link)
  const spec = next.spec ?? specForDevice(link.device)
  if (spec) {
    setActiveDevice(spec, { matched: true })
    setCodec(next)
    return
  }
  // ⚠ Nothing claimed this device. Normally that is the end of it — see the
  // note on this function — but the debug switch says to send the default
  // protocol anyway and watch what comes back.
  if (forcedProtocol() && link.device) {
    setActiveDevice(forcedSpecFor(link.device), { matched: false, forced: true })
    setCodec(forcedCodecFor(link.device))
    return
  }
  setActiveDevice(defaultSpec(), { matched: false })
  setCodec(next)
}

// Arming the switch re-probes, so the codec changes under the panels the moment
// it is flipped rather than on the next reconnect.
subscribeForcedProtocol(() => void refreshCodec())

// Unplugging ends the experiment: see state/forcedProtocol.ts.
link.onChange(() => {
  if (!link.connected) setForcedProtocol(false)
})

/** The active codec outside React — for the sync engine, which is not a view. */
export function currentCodec(): KeyboardCodec {
  return codec
}

/**
 * Puts the attached board into analog test mode, whichever board it is.
 *
 * The three panels that need the raw stream — events, sensors, calibration —
 * used to call the Raven61's own `armAnalogStream`. This asks the active codec
 * instead, and says so plainly when the board's spec names no such command
 * rather than sending a byte that means something else there.
 */
export async function armActiveStream(opts?: {
  keepAlive?: boolean
}): Promise<() => Promise<void>> {
  const active = currentCodec()
  if (!active.armAnalogStream) {
    throw new Error(t('protocol.noAnalogMode', { board: codecLabel(active) }))
  }
  return active.armAnalogStream(link, opts)
}

/** The command bytes that enter and leave that mode, for a panel to show. */
export function analogModeCommands(): { arm: number | null; disarm: number | null } {
  const spec = currentCodec().spec
  return {
    arm: spec?.commands.analogTestOn ?? null,
    disarm: spec?.commands.analogTestOff ?? null,
  }
}

/** `0xa8`, or an em dash for a board whose spec names no such command. */
export function commandHex(command: number | null): string {
  return command === null ? '—' : `0x${command.toString(16).padStart(2, '0')}`
}

export function useCodec(): KeyboardCodec {
  return useSyncExternalStore(
    (fn) => {
      codecListeners.add(fn)
      return () => codecListeners.delete(fn)
    },
    () => codec,
  )
}

export function useConnection(): { device: HIDDevice | null; connected: boolean } {
  const connected = useSyncExternalStore(
    (fn) => link.onChange(fn),
    () => link.connected,
  )
  const device = useSyncExternalStore(
    (fn) => link.onChange(fn),
    () => link.device,
  )
  return { device, connected }
}

export function useTraffic(): readonly TrafficEntry[] {
  const subscribe = useCallback((fn: () => void) => link.log.subscribe(() => fn()), [])
  return useSyncExternalStore(subscribe, () => link.log.all())
}

/** Re-probes the codec whenever a device is opened or closed. */
export function useCodecAutoSelect(): void {
  useEffect(() => link.onChange(() => void refreshCodec()), [])
}
