import { useSyncExternalStore } from 'react'

/**
 * The size of the window, for the one decision that still needs to be made in
 * script rather than in CSS.
 *
 * How big to draw the interface is not that decision: it is a straight line
 * between two window sizes, and `html { font-size }` in styles.css draws it
 * with `clamp()` and `min()`. Doing it there rather than here means the browser
 * interpolates it as part of layout, continuously, instead of this file
 * sampling a resize and writing a number back — which is what made the scale
 * step rather than glide.
 *
 * What is left is whether the window is too small to lay the app out in at all
 * (ui/TooSmall.tsx), which is a threshold, not a curve, and has to reach React.
 */

/**
 * Below this the app is not usable as laid out: the key grid and its control
 * column no longer fit side by side, and the panels below them stop being
 * readable.
 *
 * These are viewport pixels rather than display pixels, and the two differ by
 * however much the browser's own chrome takes — vertically that is 100–150px,
 * so 620 is roughly what a 720-tall display leaves.
 */
export const MIN_VIEWPORT = { width: 1280, height: 620 } as const

export interface Viewport {
  width: number
  height: number
}

/**
 * Whether a window is small enough to be worth warning about.
 *
 * A zero dimension is not a small window, it is no measurement at all: a hidden
 * tab, a background render, a thumbnail capture. Warning about those would put
 * the notice up on a window nobody is looking at and, worse, have it already
 * showing or already dismissed by the time someone is.
 */
export function isTooSmall({ width, height }: Viewport): boolean {
  if (width === 0 || height === 0) return false
  return width < MIN_VIEWPORT.width || height < MIN_VIEWPORT.height
}

/**
 * Watched with a ResizeObserver on the root element rather than the window's
 * `resize` event. The two agree on an ordinary drag of a window edge, but the
 * observer also catches the cases the event misses — a viewport that changes
 * size without the window doing so, and the 0×0 → real transition when a tab
 * that was never painted becomes visible.
 */
class ViewportStore {
  private value: Viewport = read()
  private listeners = new Set<() => void>()

  constructor() {
    new ResizeObserver(() => this.sample()).observe(document.documentElement)
  }

  current(): Viewport {
    return this.value
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private sample(): void {
    const next = read()
    if (next.width === this.value.width && next.height === this.value.height) return
    this.value = next
    for (const fn of this.listeners) fn()
  }
}

/**
 * The root element's box rather than `window.inner*`: it is what the observer
 * watches, and it is the space the layout actually gets — `innerWidth` counts a
 * scrollbar the content cannot use.
 */
function read(): Viewport {
  const root = document.documentElement
  return { width: root.clientWidth, height: root.clientHeight }
}

export const viewport = new ViewportStore()

export function useViewport(): Viewport {
  return useSyncExternalStore(
    (fn) => viewport.subscribe(fn),
    () => viewport.current(),
  )
}

export function useTooSmall(): boolean {
  return isTooSmall(useViewport())
}
