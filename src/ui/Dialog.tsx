import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useExit } from './useExit'

/** Has to agree with the `.modal` animations in styles.css. */
const EXIT_MS = 160

/**
 * A modal, built on the element the platform already has.
 *
 * `<dialog>` opened with `showModal()` brings the things a hand-rolled overlay
 * has to reinvent and usually gets wrong: the top layer, so nothing in the
 * page can stack over it, and a focus trap with a focus restore, so the
 * keyboard cannot wander behind it and comes back where it started. What is
 * left here is the part the platform has no opinion about — when it is open,
 * and how it arrives.
 *
 * ## Why it is unmounted rather than closed
 *
 * `close()` takes the element out of the top layer in the same frame, so an
 * exit animation on a natively-closed dialog plays somewhere behind the page.
 * Instead `open` drives `useExit`, the element stays mounted — and open — for
 * the length of the leaving animation, and React removes it at the end. The
 * price is the focus restore, which `close()` can only do while the dialog is
 * still in the document — so that part is done here by hand.
 *
 * Escape is intercepted for the same reason: the platform's own close request
 * would close it natively, which is the one path that skips the animation.
 *
 * ## Why Escape is listened for as well as intercepted
 *
 * `cancel` is the right event and it is still handled — but it only fires if
 * the key reaches the platform's close request, and there are environments
 * where a perfectly ordinary Escape does not get that far. This is the
 * confirmation in front of the one thing in the app that cannot be undone, so
 * the key that backs out of it is not left to a behaviour that can be missing:
 * the listener closes the dialog either way, and both paths arriving at once
 * is a second `onClose` for a dialog that is already going.
 */
export function Dialog({
  open,
  onClose,
  title,
  tone,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /**
   * What the edge is drawn in, for a dialog whose answer costs something:
   * `danger` for one that destroys, `warn` for one that only cautions. Left
   * off for a question that is simply a question.
   */
  tone?: 'danger' | 'warn'
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  /** Whatever had the keyboard when this opened, to give it back to. */
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const { mounted, closing } = useExit(open, EXIT_MS)

  useEffect(() => {
    const el = ref.current
    if (!mounted || !el) return
    if (!el.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      el.showModal()
    }
    return () => {
      if (el.open) el.close()
      /*
       * The focus restore, by hand. `close()` does it itself, but only for a
       * dialog that is still in the document — and this one is closed on its
       * way out of it, which is late enough that the browser has nothing left
       * to hand the focus back from. Without this, Escape drops the keyboard
       * on the body and the button that opened the dialog has to be found
       * again from the top of the page.
       */
      const back = opener.current
      opener.current = null
      if (back?.isConnected) back.focus()
    }
  }, [mounted])

  // Bound only while the question stands: during the exit there is nothing
  // left to back out of, and a second Escape should reach whatever is under it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!mounted) return null

  return (
    <dialog
      ref={ref}
      className={`modal${tone ? ` ${tone}` : ''}${closing ? ' closing' : ''}`}
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
