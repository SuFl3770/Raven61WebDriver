import { useRef, useState, type ReactNode } from 'react'
import { selection } from '../state/selection'

/**
 * Rubber-band selection over the band the key grid sits in.
 *
 * Dragging *on* the caps already paints them one by one (see KeyGrid). This is
 * the other half: a drag that starts anywhere else in the band — the space
 * beside the grid, the gaps between caps, above or below a row — draws a box
 * and selects everything it touches. Grabbing the bottom two rows should not
 * require landing the first pixel exactly on a cap.
 *
 * The surface is the whole band rather than the grid element, so there is
 * somewhere to start a drag that is not already a key. Excluded are the caps,
 * which have their own gesture; the line of readouts below; and anything the
 * band holds in the React tree but not on screen — see `begin`.
 */
interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Capture keeps the moves coming once the pointer leaves the element, and
 * guarantees the release that ends the drag. It is an improvement on the
 * gesture, not a precondition for it — and it throws if the pointer is already
 * gone — so a failure here must not take the drag down with it.
 */
function capture(el: Element | null, pointerId: number): void {
  try {
    el?.setPointerCapture(pointerId)
  } catch {
    // Without capture the drag still works inside the element.
  }
}

/** Client-space overlap, which is all a hit test needs. */
function intersects(a: DOMRect, b: Rect & { right: number; bottom: number }): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export function Marquee({
  disabled,
  className,
  children,
}: {
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  /**
   * The selection as it stood when the drag began.
   *
   * The band adds to it rather than replacing it, and every move recomputes
   * from this snapshot instead of accumulating — so shrinking the box gives
   * back the keys that leave it, while keys that were already selected stay
   * selected. Accumulating would make the gesture impossible to correct without
   * starting over.
   */
  const base = useRef<ReadonlySet<number>>(new Set())
  const [box, setBox] = useState<Rect | null>(null)

  const begin = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return
    const target = e.target as HTMLElement
    /*
     * Anything not physically inside the band is not part of this gesture,
     * whatever the React tree says about it.
     *
     * The tab's controls are the case that needs saying: they are declared in
     * here (ui/GridFrame.tsx) but drawn up in the title row through a portal,
     * and React bubbles their events through the tree they were *declared* in
     * — so without this a press on "select all" starts a rubber band, captures
     * the pointer on the band, and the button never sees the release that
     * would have made it a click. The gesture is spatial; so is the test.
     */
    if (!host.current?.contains(target)) return
    // The caps paint, and the readouts below are not a place to drag from.
    if (target.closest('.keycap') || target.closest('.gridfoot')) return
    origin.current = { x: e.clientX, y: e.clientY }
    base.current = new Set(selection.current())
    setBox({ left: e.clientX, top: e.clientY, width: 0, height: 0 })
    capture(host.current, e.pointerId)
  }

  const move = (e: React.PointerEvent) => {
    const from = origin.current
    if (!from || !host.current) return
    const left = Math.min(from.x, e.clientX)
    const top = Math.min(from.y, e.clientY)
    const right = Math.max(from.x, e.clientX)
    const bottom = Math.max(from.y, e.clientY)
    setBox({ left, top, width: right - left, height: bottom - top })

    const next = new Set(base.current)
    for (const cap of host.current.querySelectorAll<HTMLElement>('.keycap[data-key]')) {
      if (intersects(cap.getBoundingClientRect(), { left, top, right, bottom, width: 0, height: 0 })) {
        next.add(Number(cap.dataset.key))
      }
    }
    selection.replace(next)
  }

  const end = (e: React.PointerEvent) => {
    origin.current = null
    setBox(null)
    if (host.current?.hasPointerCapture(e.pointerId)) {
      host.current.releasePointerCapture(e.pointerId)
    }
  }

  // The box is drawn in client coordinates, so it is positioned against the
  // host's own box rather than the page — the host scrolls with the content.
  const frame = host.current?.getBoundingClientRect()
  return (
    <div
      ref={host}
      className={className}
      style={{ position: 'relative' }}
      onPointerDown={disabled ? undefined : begin}
      onPointerMove={disabled ? undefined : move}
      onPointerUp={disabled ? undefined : end}
      onPointerCancel={disabled ? undefined : end}
    >
      {children}
      {box && frame && (
        <div
          className="marquee"
          style={{
            left: box.left - frame.left,
            top: box.top - frame.top,
            width: box.width,
            height: box.height,
          }}
        />
      )}
    </div>
  )
}
