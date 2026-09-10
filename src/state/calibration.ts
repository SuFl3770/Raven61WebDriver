import { useSyncExternalStore } from 'react'

/**
 * Whether calibration mode is holding the window.
 *
 * Calibration is not a panel, it is a state the *board* is in: 0xa8 is repeated
 * to hold the analog test mode open, and while that mode is held the keyboard
 * reports travel but types nothing. Leaving the mode is what gives typing back.
 *
 * So the rest of the app has to stop being reachable while it runs. Switching
 * tabs would unmount the run and end the mode with nothing on screen having
 * said so, and disconnecting would strand the board: the release packet cannot
 * be sent through a closed device, and the keyboard would stay unable to type
 * until it was unplugged.
 *
 * The flag lives here rather than in the input-point tab because the chrome
 * that has to be blocked — the tab strip, the disconnect button — belongs to
 * App, which is above that tab.
 */
class CalibrationMode {
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

export const calibrationMode = new CalibrationMode()

export function useCalibrationMode(): boolean {
  return useSyncExternalStore(
    (fn) => calibrationMode.subscribe(fn),
    () => calibrationMode.current(),
  )
}
