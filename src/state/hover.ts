import { useSyncExternalStore } from 'react'

/**
 * Which key the pointer is over, for the panel below the grid to read.
 *
 * A cap is about a centimetre square and already carries its legend and its
 * setting; the switch fitted to it is a *name*, and there is nowhere on a cap
 * to put "Light Breeze V2" that anyone could read. So the cap shows the colour
 * and the panel spells it out — which needs the grid and the panel, two
 * siblings with a section strip between them, to agree on one number.
 *
 * Deliberately not part of `selection`. Hover is a question ("what is this
 * one?") and selection is an instruction ("write to these"), and the moment
 * pointing at a key could change what a write lands on, reading the board
 * would be dangerous. Nothing here is ever read by a write path.
 *
 * Touch has no hover. Panels that use this must still say something sensible
 * when it is undefined, which is the normal state on a tablet and the resting
 * state everywhere else.
 */
class HoverStore {
  private key: number | undefined
  private listeners = new Set<() => void>()

  current = (): number | undefined => this.key

  /**
   * An arrow property, not a method: this is handed to the grid as
   * `onHover={hover.set}`, and a plain method passed that way arrives with no
   * `this` and throws on the first cap the pointer touches.
   */
  set = (index: number | undefined): void => {
    if (this.key === index) return
    this.key = index
    for (const fn of this.listeners) fn()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const hover = new HoverStore()

export function useHoverKey(): number | undefined {
  return useSyncExternalStore(hover.subscribe, () => hover.current(), () => undefined)
}
