import { useEffect } from 'react'
import { supports } from '../protocol/codec'
import { currentCodec, link, useCodec, useConnection } from './link'
import { macroSnapshotStore } from './macroSnapshot'
import { boardSync } from './sync'

/**
 * Reads the board once, up front, while the key grid is lighting up.
 *
 * Every tab in this app reads on entry, on purpose: what a panel shows is what
 * the board had a moment ago rather than whatever was cached when it was last
 * open. That rule costs nothing while a session runs — the read is behind a
 * tab you asked for — but it is paid four times over in the first minute of
 * one, because the first visit to each tab is a wait in front of an empty
 * panel.
 *
 * This is that first read, moved to the moment a board is attached. The grid
 * has a reveal to play through (see `cap-reveal` in styles.css), the user is
 * watching it rather than a panel, and the link is otherwise idle — so the
 * blocks the tabs will ask for are fetched into here, and the first visit to
 * each tab takes the answer instead of sending the request.
 *
 * ## One at a time
 *
 * A link is one pipe and a block read is a run of packets, so these are
 * chained rather than fired together: `queue` hangs each read off the end of
 * the one before. Every key is in the map *synchronously* though, before any
 * of them has run, which is what lets a reader that arrives early wait on the
 * right promise rather than start a second read of the same block.
 *
 * ## Once, and only to the first asker
 *
 * `take` hands over the promise and drops it. A tab opened a second time reads
 * for itself, which is the rule this is an exception to and not a repeal of:
 * the exception is only sound while "a moment ago" is still true, and that is
 * the length of the reveal, not the length of the session.
 *
 * A read that fails leaves nothing behind — the key is dropped and the tab
 * sends its own request, arriving exactly where it would have without any of
 * this.
 */

/** What is worth fetching ahead, named for the tab that will come for it. */
export type PrefetchKey = 'keymap0' | 'advancedKeys' | 'keyColors'

const cache = new Map<PrefetchKey, Promise<unknown>>()

/**
 * Which connection the entries belong to.
 *
 * A board going away and another arriving while a read is still in flight
 * would otherwise land one keyboard's blocks in the other's cache.
 */
let generation = 0

/** The promise, and the entry with it. For the one reader that asked first. */
export function take<T>(key: PrefetchKey): Promise<T> | undefined {
  const found = cache.get(key) as Promise<T> | undefined
  cache.delete(key)
  return found
}

/**
 * The promise, left where it is — for a reader that is not the only one.
 *
 * The base layer has two: `state/legends.ts` publishes it for every grid's
 * caps, and the remap tab shows the layer itself. One read, both told.
 */
export function peek<T>(key: PrefetchKey): Promise<T> | undefined {
  return cache.get(key) as Promise<T> | undefined
}

export function clearPrefetch(): void {
  generation += 1
  cache.clear()
}

function start(): void {
  clearPrefetch()
  const gen = generation
  const codec = currentCodec()
  let chain: Promise<unknown> = Promise.resolve()

  const queue = <T>(key: PrefetchKey | null, read: () => Promise<T>): void => {
    const run = chain.then(() => (gen === generation ? read() : Promise.reject()))
    // The chain must not stop at the first board that answers nothing, and an
    // entry nobody ever takes must not be an unhandled rejection.
    chain = run.catch(() => undefined)
    if (key === null) return
    cache.set(key, run)
    run.catch(() => {
      if (cache.get(key) === run) cache.delete(key)
    })
  }

  // The per-key block and the board-wide one, which are stores rather than
  // anyone's local state — so these need no taker. Through the sync queue,
  // which is the only thing allowed to touch those two.
  queue(null, () => boardSync.read())

  /*
   * Each read is taken off the codec first, the way state/legends.ts does it:
   * `supports` narrows the codec, and a call written inside the closure would
   * be made against the codec of whenever the closure runs rather than the one
   * that was checked.
   */
  const keymap = supports(codec, 'readKeymap') ? codec.readKeymap : undefined
  const advanced = supports(codec, 'readAdvancedKeys') ? codec.readAdvancedKeys : undefined
  const colors = supports(codec, 'readKeyColors') ? codec.readKeyColors : undefined
  const macros = supports(codec, 'readMacros') ? codec.readMacros : undefined

  if (keymap) queue('keymap0', () => keymap(link, 0))
  if (advanced) queue('advancedKeys', () => advanced(link))
  if (colors) queue('keyColors', () => colors(link))
  /*
   * Macros land in their own store, which the tab seeds its state from — see
   * state/macroSnapshot.ts — so there is nothing here for a taker either.
   * Without the keymap sweep: that is two thirds of the packets and the only
   * thing that wants it is behind the debug gate, which asks for itself.
   */
  if (macros) {
    queue(null, async () => macroSnapshotStore.load(await macros(link, { uses: false })))
  }
}

/**
 * Starts the run when a board is attached, and drops what is left of it when
 * one goes away.
 *
 * Called from `App` ahead of `useLegendSync`, so that by the time anything
 * else asks, the keys are in the map.
 */
export function usePrefetch(): void {
  const codec = useCodec()
  const { connected } = useConnection()

  useEffect(() => {
    if (!connected) {
      clearPrefetch()
      return
    }
    start()
  }, [codec, connected])
}
