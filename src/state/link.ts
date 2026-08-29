import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { HidLink } from '../hid/link'
import type { TrafficEntry } from '../hid/log'
import type { Raven61Codec } from '../protocol/codec'
import { selectCodec } from '../protocol/registry'
import { unknownCodec } from '../protocol/unknown'

/** One link per page: WebHID hands out a single handle per device anyway. */
export const link = new HidLink()

let codec: Raven61Codec = unknownCodec
const codecListeners = new Set<() => void>()

function setCodec(next: Raven61Codec): void {
  codec = next
  for (const fn of codecListeners) fn()
}

export async function refreshCodec(): Promise<void> {
  setCodec(link.connected ? await selectCodec(link) : unknownCodec)
}

export function useCodec(): Raven61Codec {
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
