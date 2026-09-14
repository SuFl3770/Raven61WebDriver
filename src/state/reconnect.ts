import { useSyncExternalStore } from 'react'
import { pickConfigInterface } from '../hid/filters'
import { HidLink } from '../hid/link'
import { suppressNextAttach } from './attach'
import { link, refreshCodec } from './link'

/**
 * The ten seconds a pulled cable is given before the session is over.
 *
 * A board that goes away used to end the session in the same frame: the window
 * was the app, and then it was the connect screen, with whichever tab had been
 * open and whatever had been read off the board gone with it. Most of the time
 * that is not what happened — a knocked cable, a hub that blinked, a firmware
 * reset that re-enumerates — and the board is back before anyone has read the
 * screen that replaced the one they were using.
 *
 * So the window is held. The dialog over it says the board is gone and counts
 * the wait down (ui/Reconnect.tsx); the same keyboard arriving inside it is
 * opened again and the session carries on, tab and all. Nothing arriving is the
 * old behaviour, ten seconds later.
 *
 * ## What "the same keyboard" can mean here
 *
 * Vendor id, product id and the name the firmware introduces itself with. That
 * is everything WebHID exposes about a device it has not opened — there is no
 * serial number — so two identical boards are, from here, one board that went
 * away and came back. The alternative is to reopen nothing automatically, which
 * would cost every real reconnect to guard against a case that needs two of the
 * same keyboard and a swap inside ten seconds.
 *
 * Which *interface* to open is not guessed: the arriving device brings all of
 * them, and `pickConfigInterface` ranks them exactly as it does for a device
 * picked by hand.
 *
 * ## Why it polls as well as listens
 *
 * `connect` is the event for this and it is listened for. The sweep on every
 * tick is what covers the rest: an interface that enumerates a beat after the
 * one that fired the event, and a device that came back between the disconnect
 * and this store hearing about it. Both are a call to `getDevices` and a
 * comparison of three fields.
 */
export const WAIT_MS = 10_000

/** How often the window is re-measured, and the board looked for. */
const TICK_MS = 250

/** What is known about the board that left, which is all that can be matched. */
interface Target {
  vendorId: number
  productId: number
  productName: string
}

export interface ReconnectState {
  /** Whether the session is being held open for a board to come back. */
  waiting: boolean
  /** Milliseconds left of the window, for the rail that drains. */
  left: number
  /** The board's name, as it introduced itself before it went. */
  device: string
}

const IDLE: ReconnectState = { waiting: false, left: 0, device: '' }

/**
 * `waiting` is the state the window is rendered on; `resuming` is the moment
 * between finding the board and having it open, which is not a third screen —
 * it exists so that a second tick does not start a second open.
 */
type Phase = 'idle' | 'waiting' | 'resuming'

let phase: Phase = 'idle'
let target: Target | null = null
let deadline = 0
let timer: ReturnType<typeof setInterval> | undefined
/** A sweep is in flight. Its `await`s are long enough for a tick to land inside. */
let busy = false

let state: ReconnectState = IDLE
const listeners = new Set<() => void>()

function publish(next: ReconnectState): void {
  state = next
  for (const fn of listeners) fn()
}

function sameBoard(device: HIDDevice, want: Target): boolean {
  return (
    device.vendorId === want.vendorId &&
    device.productId === want.productId &&
    (device.productName ?? '') === want.productName
  )
}

const onHidConnect = (): void => {
  void attempt()
}

/** Ends the wait, whichever way it ended. The link is left exactly as it is. */
function stop(): void {
  clearInterval(timer)
  timer = undefined
  phase = 'idle'
  target = null
  if (HidLink.supported()) navigator.hid.removeEventListener('connect', onHidConnect)
  publish(IDLE)
}

/**
 * Gives up on the board and lets the window go — the countdown running out,
 * and the dialog's own button.
 *
 * There is nothing to undo: the link emptied when the device went, and every
 * store that was keyed to it was cleared then (see state/link.ts). This only
 * stops holding the screen over it.
 */
export function cancelReconnect(): void {
  stop()
}

/**
 * Looks for the board, and opens it if it is there.
 *
 * A device that is enumerated but not yet openable is not a failure worth
 * reporting — the driver on the other side may still be settling — so a throw
 * puts the wait back and the next tick asks again, until the window is out.
 */
async function attempt(): Promise<void> {
  if (busy || phase !== 'waiting' || !target) return
  const want = target
  busy = true
  try {
    const devices = await link.knownDevices()
    const pick = pickConfigInterface(devices.filter((d) => sameBoard(d, want)))
    // `phase` is re-read: the wait may have run out or been cancelled while
    // `getDevices` was in flight, and neither should be reopened behind.
    if (!pick || phase !== 'waiting') return
    phase = 'resuming'
    const release = suppressNextAttach()
    try {
      await link.open(pick)
    } catch {
      release()
      if (phase === 'resuming') phase = 'waiting'
      return
    }
    await refreshCodec()
    // The link is open and the window never left: `stop` puts the dialog away
    // and the app is where it was, reading the board it was reading before.
    stop()
  } catch {
    if (phase === 'resuming') phase = 'waiting'
  } finally {
    busy = false
  }
}

function tick(): void {
  if (phase !== 'waiting') return
  const left = Math.max(0, deadline - Date.now())
  publish({ waiting: true, left, device: target?.productName ?? '' })
  // Measured against a deadline rather than counted down, so a throttled
  // background tab ends the wait at ten seconds rather than whenever its
  // timers happened to run.
  if (left === 0) {
    stop()
    return
  }
  void attempt()
}

link.onLost((device) => {
  if (!HidLink.supported()) return
  // A second disconnect inside a wait is a new wait, for whatever went this
  // time. Nothing carries over.
  stop()
  target = {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? '',
  }
  phase = 'waiting'
  deadline = Date.now() + WAIT_MS
  publish({ waiting: true, left: WAIT_MS, device: target.productName })
  navigator.hid.addEventListener('connect', onHidConnect)
  timer = setInterval(tick, TICK_MS)
})

export function useReconnect(): ReconnectState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
    () => IDLE,
  )
}
