import { useEffect, useState } from 'react'
import { windowHeld } from './windowHold'
import { settings } from './settings'

/**
 * Five quick taps of Shift toggle debug mode.
 *
 * It used to be a checkbox on the settings tab, which is a strange thing to
 * show everyone: nobody configuring a keyboard needs a protocol lab, and the
 * one person who does knows the gesture. So the control is gone and this is
 * what turns the tabs on and off.
 *
 * ## Why bare taps, counted from scratch on any other key
 *
 * Shift is not an idle key — it is held down to type capitals. Typing `HELLO`
 * by tapping Shift before each letter is five Shift presses inside a second,
 * which is exactly the gesture. What separates the two is what happens *in
 * between*: typing puts a letter there. So any keydown that is not Shift takes
 * the count back to zero, and the gesture only completes on five Shift presses
 * with nothing at all between them.
 *
 * Auto-repeat is ignored for the same reason from the other direction: holding
 * Shift down fires a stream of keydowns, and counting those would arm the
 * gesture by leaning on the key.
 */
export const DEBUG_GESTURE = {
  /** Taps needed. */
  presses: 5,
  /** Longest gap between two taps that still counts as "quickly". */
  gapMs: 500,
} as const

/** How long the confirmation stays on screen. */
const TOAST_MS = 2600

/**
 * Where the run of taps has got to. `last` is null until the first tap, and
 * deliberately not 0: `KeyboardEvent.timeStamp` counts from page load, so a 0
 * would put the very first tap of a freshly loaded page within `gapMs` of it
 * and count that tap as the second.
 */
export interface GestureRun {
  count: number
  last: number | null
}

export const GESTURE_START: GestureRun = { count: 0, last: null }

/** The parts of a keydown the counter looks at. */
export interface GestureKey {
  key: string
  repeat: boolean
  /** Milliseconds on any monotonic clock; `KeyboardEvent.timeStamp` in the app. */
  timeStamp: number
}

/**
 * Folds one keydown into the run, and says whether that completed the gesture.
 *
 * Pure, and separate from the hook, so the three rules that make this safe to
 * put on Shift can be checked without a browser — see
 * `tools/check/debug-gesture.ts`. They are easy to get subtly wrong and the
 * failure mode is bad in both directions: a gesture that will not fire is
 * merely annoying, but one that fires while somebody types in capitals moves
 * the tab strip under them.
 */
export function advanceGesture(
  run: GestureRun,
  event: GestureKey,
): { next: GestureRun; fire: boolean } {
  // Anything else, including another modifier, means this was typing.
  if (event.key !== 'Shift') return { next: GESTURE_START, fire: false }
  // Held down, not tapped: counting auto-repeat would arm the gesture by
  // leaning on the key.
  if (event.repeat) return { next: run, fire: false }

  const quick = run.last !== null && event.timeStamp - run.last <= DEBUG_GESTURE.gapMs
  const count = quick ? run.count + 1 : 1
  if (count < DEBUG_GESTURE.presses) return { next: { count, last: event.timeStamp }, fire: false }
  // Start the next run from scratch rather than leaving it one tap short of
  // firing again.
  return { next: { count: 0, last: event.timeStamp }, fire: true }
}

/**
 * How many things on screen are reading bare keypresses as something other than
 * typing.
 *
 * The overview tab is the case: its key-info section answers "which key is
 * this" by taking the next keystroke, and Shift is one of the keys it can be
 * asked about. Five taps there are a reader inspecting the Shift key five
 * times, not a request for a protocol lab — and a tab strip that grew two tabs
 * while somebody was doing that would be answering a question nobody asked.
 *
 * A count rather than a flag, so two overlapping claims cannot put it back
 * before the second one has finished with it. Read inside the listener, so it
 * is the state at the moment of the press that decides.
 */
let suppressing = 0

/**
 * Turn the gesture off for as long as the caller is on screen, and back on
 * when it goes. The return value is the release, which is what makes it an
 * effect body: `useEffect(() => suppressDebugGesture(), [])`.
 */
export function suppressDebugGesture(): () => void {
  suppressing++
  let released = false
  return () => {
    // Guarded, because a release called twice would take somebody else's claim
    // with it — the count is shared.
    if (released) return
    released = true
    suppressing--
  }
}

/** The last toggle the gesture made, so something on screen can say it happened. */
export interface DebugToggle {
  on: boolean
  /** Distinguishes two toggles in a row, which are otherwise equal. */
  at: number
}

/**
 * Watches for the gesture and returns the toggle it just made, or null.
 *
 * A hidden control needs feedback more than a visible one does: with no
 * checkbox to look at, five taps that quietly did nothing and five taps that
 * worked look identical. The return value is what the toast renders.
 */
export function useDebugGesture(): DebugToggle | null {
  const [toggle, setToggle] = useState<DebugToggle | null>(null)

  useEffect(() => {
    let run = GESTURE_START

    const onKeyDown = (event: KeyboardEvent) => {
      // Calibration and macro recording each hold the whole window still on
      // purpose — see state/windowHold.ts. Changing which tabs exist under one
      // of them is not something a keypress should do, and during a recording
      // the keys are the thing being recorded.
      if (windowHeld()) return
      // Something on screen is asking about keys — see `suppressing`.
      if (suppressing > 0) return

      const { next, fire } = advanceGesture(run, {
        key: event.key,
        repeat: event.repeat,
        // Synthetic events can carry a 0; the wall clock is a fine stand-in
        // since only differences are ever used.
        timeStamp: event.timeStamp || Date.now(),
      })
      run = next
      if (!fire) return

      const on = !settings.current().debug
      settings.set('debug', on)
      setToggle({ on, at: Date.now() })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!toggle) return
    const id = setTimeout(() => setToggle(null), TOAST_MS)
    return () => clearTimeout(id)
  }, [toggle])

  return toggle
}
