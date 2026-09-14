import { useSyncExternalStore } from 'react'
import { link } from './link'

/**
 * The moment a board answers, held on screen.
 *
 * Attaching a keyboard used to be a cut: the connect screen was there, and
 * then the app was, with nothing in between saying that the thing this whole
 * program is about had just turned up. So the board already drawn on the
 * connect screen lights up — a wave out from the middle of its top row, key
 * by key, ending with the whole board lit — and only then does the window
 * change hands.
 *
 * That last part is why this is a store rather than something inside the
 * connect screen: `App` swaps its entire tree the instant `link.connected`
 * goes true, which would take the board off screen before the first cap had
 * lit. This is the one thing that says "not yet".
 *
 * ## The durations
 *
 * `SPREAD_MS` is how long the wave takes to reach the furthest cap and
 * `CAP_MS` how long one takes to come up; both have to agree with
 * `board-attach` in styles.css, which is the rule that draws it. `TAIL_MS` is
 * the beat after the last cap, so the board is seen lit rather than switched
 * away from at the exact frame it finishes.
 *
 * The same seam `ui/useExit.ts` has, for the same reason: the alternative is
 * measuring an animation, in a callback, for two numbers that are written once
 * and change about never. They are named in each other's comments instead.
 */
const SPREAD_MS = 700
const CAP_MS = 520
const TAIL_MS = 180

/** How long the connect screen is held after a board answers. */
export const ATTACH_MS = SPREAD_MS + CAP_MS + TAIL_MS

let playing = false
let timer: ReturnType<typeof setTimeout> | undefined
/** Set while a reconnect is putting the *same* board back — see `suppressNextAttach`. */
let suppressed = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

function set(next: boolean): void {
  if (playing === next) return
  playing = next
  emit()
}

/**
 * Sits out the next attach, and hands back the way to change its mind.
 *
 * The wave is what says a board has arrived, and it is drawn on the connect
 * screen — which is the one place a resumed session is not. A board that came
 * back inside its ten seconds never left as far as the window is concerned
 * (see state/reconnect.ts), so lighting it up would mean leaving the app,
 * playing an arrival, and coming back to where the user already was.
 *
 * The release is for an open that never happened: without it a failed attempt
 * would leave the flag set, and the next board to actually arrive — after the
 * wait had been given up on — would slip in without its wave.
 */
export function suppressNextAttach(): () => void {
  suppressed = true
  return () => {
    suppressed = false
  }
}

link.onChange(() => {
  clearTimeout(timer)
  if (!link.connected) {
    // A board taken away mid-wave leaves nothing to light up, and the connect
    // screen is where the app is going anyway.
    set(false)
    return
  }
  if (suppressed) {
    suppressed = false
    set(false)
    return
  }
  /*
   * Someone who has asked for less motion has asked to get where they are
   * going, not to wait out an animation the stylesheet will not draw for them.
   * Read here rather than watched: a preference that changes during the one
   * second this lasts is not a case worth a listener.
   */
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    set(false)
    return
  }
  set(true)
  timer = setTimeout(() => set(false), ATTACH_MS)
})

/**
 * Whether the board is lighting up.
 *
 * True from the moment a device is opened until the wave has crossed it. `App`
 * keeps the connect screen while it is, and `ui/BoardArt.tsx` is what draws
 * it — nothing else should have an opinion, least of all the panels, which are
 * not on screen yet.
 */
export function useAttaching(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => playing,
    () => false,
  )
}
