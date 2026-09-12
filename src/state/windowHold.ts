import { useSyncExternalStore } from 'react'

/**
 * The modes that hold the whole window, and whether one of them is running.
 *
 * Two things this app does are not panels, they are states something else is
 * in, and while one of them runs the rest of the window has to stop being
 * reachable:
 *
 * - **Calibration** is a state the *board* is in: 0xa8 is repeated to hold the
 *   analog test mode open, and while that mode is held the keyboard reports
 *   travel but types nothing. Switching tabs would unmount the run and end the
 *   mode with nothing on screen having said so, and disconnecting would strand
 *   the board: the release packet cannot be sent through a closed device, and
 *   the keyboard would stay unable to type until it was unplugged.
 *
 * - **Macro recording** is a state the *page* is in: the recorder takes
 *   `keydown` on the window under capture and calls `preventDefault` on every
 *   event, because recording Ctrl+W has to not close the tab. So while it runs
 *   the chrome cannot be reached by the keyboard at all, and a tab strip that
 *   answers the mouse but not the keys is a tab strip that is lying about
 *   being live. Stopping the recorder is what gives the window back — the same
 *   shape as leaving calibration, so it is drawn the same way.
 *
 * The flags live here rather than in either tab because the chrome that has to
 * be blocked — the tab strip, the disconnect button — belongs to App, which is
 * above both of them.
 */
class Hold {
  private active = false
  private listeners = new Set<() => void>()

  current(): boolean {
    return this.active
  }

  set(next: boolean): void {
    if (this.active === next) return
    this.active = next
    for (const fn of this.listeners) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const calibrationMode = new Hold()
export const macroRecording = new Hold()

/** Every hold, so that "is anything holding the window" is one place. */
const HOLDS = [calibrationMode, macroRecording]

/** For code outside React — see state/debugGesture.ts. */
export function windowHeld(): boolean {
  return HOLDS.some((hold) => hold.current())
}

function subscribeHolds(fn: () => void): () => void {
  const offs = HOLDS.map((hold) => hold.subscribe(fn))
  return () => {
    for (const off of offs) off()
  }
}

/** Whether any mode is holding the window, for the chrome that has to go away. */
export function useWindowHeld(): boolean {
  return useSyncExternalStore(subscribeHolds, windowHeld)
}

/** Calibration alone, for the tab that owns it. */
export function useCalibrationMode(): boolean {
  return useSyncExternalStore(
    (fn) => calibrationMode.subscribe(fn),
    () => calibrationMode.current(),
  )
}
