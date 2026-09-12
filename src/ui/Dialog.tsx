import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useExit } from './useExit'

/** Has to agree with the `.modal` animations in styles.css. */
const EXIT_MS = 160

/**
 * A modal, built on the element the platform already has.
 *
 * `<dialog>` opened with `showModal()` brings the three things a hand-rolled
 * overlay has to reinvent and usually gets wrong: the top layer, so nothing in
 * the page can stack over it; a focus trap and a focus restore, so the
 * keyboard cannot wander behind it and comes back where it started; and
 * Escape, without a listener on the window. What is left here is the part the
 * platform has no opinion about — when it is open, and how it arrives.
 *
 * ## Why it is unmounted rather than closed
 *
 * `close()` takes the element out of the top layer in the same frame, so an
 * exit animation on a natively-closed dialog plays somewhere behind the page.
 * Instead `open` drives `useExit`, the element stays mounted — and open — for
 * the length of the leaving animation, and React removes it at the end. The
 * effect's cleanup still calls `close()`, which is what hands focus back to
 * whatever opened it.
 *
 * Escape is intercepted for the same reason: the default action would close it
 * natively, which is the one path that skips the animation.
 */
export function Dialog({
  open,
  onClose,
  title,
  danger = false,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** Draws the edge in the error colour — for a dialog that destroys something. */
  danger?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const { mounted, closing } = useExit(open, EXIT_MS)

  useEffect(() => {
    const el = ref.current
    if (!mounted || !el) return
    if (!el.open) el.showModal()
    return () => {
      if (el.open) el.close()
    }
  }, [mounted])

  if (!mounted) return null

  return (
    <dialog
      ref={ref}
      className={`modal${danger ? ' danger' : ''}${closing ? ' closing' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // A click on the backdrop is reported against the dialog element
      // itself, so that is what "outside" looks like from here. Anything in
      // the card is a descendant and arrives as its own target, which is why
      // this does not need to ask whether the click was inside.
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  )
}

/** The row a dialog ends with: its buttons, against the right edge. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="modal-actions">{children}</div>
}
