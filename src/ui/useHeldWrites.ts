import { useEffect, useRef } from 'react'
import { boardSync } from '../state/sync'

/**
 * Keys that repeat while held, and so move a control continuously.
 *
 * A range input moves by one step per arrow press, and the browser repeats the
 * press about thirty times a second when the key is held — the same problem as
 * dragging, without a pointer involved.
 */
const REPEATS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/**
 * Props for a control whose value moves continuously while it is being worked.
 *
 * Settings are written to the board as soon as they change, which is right for
 * a checkbox and wrong for a slider: a drag emits a change per pixel and each
 * one would be a block rewrite — seventy packets for the per-key block, or a
 * read-modify-write with a settle delay in the middle for the board-wide one.
 * Rather than making everything wait — the first attempt, which put a 400 ms
 * pause in front of every checkbox — the controls that actually move
 * continuously hold the write and let it go on release.
 *
 * The hold covers **both** blocks. It used to gate only the per-key path, on
 * the reasoning that the board-wide block held nothing draggable; the lighting
 * effect put two sliders and a colour in it, and the writes queued up. See
 * `BoardSync.applyGlobal`.
 *
 * Spread onto the input:
 *
 *     const held = useHeldWrites()
 *     <input type="range" {...held} onChange={…} />
 *
 * The release is on `window`, not on the element: a fast drag ends wherever the
 * pointer happens to be, which is very often not over the slider, and a hold
 * that is never released would stop the board being written to at all.
 */
export function useHeldWrites(): {
  onPointerDown: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onKeyUp: () => void
  onBlur: () => void
} {
  const holding = useRef(false)

  const hold = () => {
    if (holding.current) return
    holding.current = true
    boardSync.hold()
  }
  const release = () => {
    if (!holding.current) return
    holding.current = false
    boardSync.release()
  }

  // Unmounting mid-drag — switching section while dragging — must not leave the
  // hold behind, or nothing would ever be written again.
  useEffect(() => release, [])

  return {
    onPointerDown: () => {
      hold()
      const up = () => {
        release()
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (REPEATS.has(e.key)) hold()
    },
    onKeyUp: release,
    // Focus can leave while a key is still down — alt-tab during a repeat —
    // and the keyup then never arrives here.
    onBlur: release,
  }
}
