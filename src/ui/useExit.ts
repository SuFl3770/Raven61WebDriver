import { useEffect, useRef, useState } from 'react'

/**
 * Holds something in the DOM for a moment after it is told to go, so that it
 * can leave rather than vanish.
 *
 * An element removed from the tree stops existing between two frames, and CSS
 * has nothing left to animate — which is why everything in this app that
 * arrives with a movement used to disappear without one. The fix is not a
 * transition library: it is one boolean more than the caller already has, kept
 * true for exactly as long as the leaving animation lasts.
 *
 * `ms` has to agree with the rule in styles.css that draws the exit. That is a
 * seam, and there is no way to close it without reading the duration back off
 * the element — which would mean measuring, in a callback, on every close, for
 * a number that is written once and changes about never. The two are named in
 * each other's comments instead.
 */
export function useExit(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) return
    /*
     * Someone who has asked for less motion has asked for the thing to be
     * gone, not for it to sit there for the length of an animation they will
     * not see. The stylesheet turns the animation off for them; without this
     * the element would simply hang about, still fully drawn, for `ms`.
     *
     * Read at the moment of closing rather than watched: it is only ever
     * consulted here, and a preference that changes mid-fade is not a case
     * worth a listener.
     */
    const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ms
    const id = setTimeout(() => setMounted(false), delay)
    return () => clearTimeout(id)
  }, [open, mounted, ms])

  // `closing` rather than "not open": the element is on its way out only while
  // it is still there, and the caller wants one class name, not two questions.
  return { mounted, closing: mounted && !open }
}

/**
 * The same, for something whose content goes away with it.
 *
 * A toast is told to leave by the thing it was announcing turning null, which
 * takes its own text with it — so the last value is held for the length of the
 * exit. Written during render rather than in an effect on purpose: the frame
 * that starts the exit is the frame that has already lost the value, and an
 * effect would run one paint too late, with the toast blank on the way out.
 */
export function useExitValue<T>(value: T | null, ms: number): { shown: T | null; closing: boolean } {
  const last = useRef<T | null>(null)
  if (value !== null) last.current = value
  const { mounted, closing } = useExit(value !== null, ms)
  return { shown: mounted ? last.current : null, closing }
}
