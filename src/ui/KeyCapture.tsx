import { useEffect, useRef } from 'react'
import { useT } from '../i18n'
import { usageForCode } from '../keyboard/hostKeys'

/**
 * A button that answers "which key?" with the next one pressed.
 *
 * A hundred and some entries is a long way to scroll for a key the reader is
 * already resting a finger on, so this takes the next keystroke and hands back
 * its HID usage. Pressed and not typed: what it captures is the key itself,
 * and a name to type matched against the list is slower than the list it would
 * be shortcutting.
 *
 * It sits *beside* a picker rather than replacing one. The keyboard cannot
 * reach a usage the board has and the host does not — a 61-key keyboard has no
 * F13 and browsers never report Fn — and the list is also how a choice already
 * made is read back.
 *
 * ### It takes the window while it waits
 *
 * Listeners on the window under capture, `preventDefault` on everything. A key
 * pressed while this is waiting is an answer to a question the page asked, not
 * input — so Ctrl+W must not close the tab, Tab must not move the focus, and
 * the letter must not land in whatever field was last touched.
 * `stopPropagation` as well, so it does not reach a handler of the app's own on
 * the way down.
 *
 * The release is swallowed too. It has no default worth stopping by itself,
 * but Space activates the focused button on *keyup* — and the button that
 * started this is the one with the focus, so letting that through would re-arm
 * the picker the moment it had answered.
 *
 * A key this app has no usage for changes nothing and the wait goes on: the
 * alternative is closing on a key the picker cannot show, which reads as having
 * captured something. Auto-repeat is dropped for the same reason — one press is
 * one answer.
 *
 * ### Armed from outside
 *
 * The flag is the caller's, not this component's, because a panel with two of
 * these must never have both waiting: one press would then answer two questions
 * at once. A caller holding "which field is armed" can only ever arm one. It is
 * also what lets picking from the list beside it count as the answer.
 *
 * Clicking it again is the way out, because there is no key that is not an
 * answer: Esc is a usage like any other and binding it is an ordinary thing to
 * want, so it cannot also be the cancel.
 */
export function KeyCapture({
  armed,
  onArmed,
  onCapture,
  disabled = false,
}: {
  armed: boolean
  onArmed: (armed: boolean) => void
  onCapture: (usage: number) => void
  disabled?: boolean
}) {
  const t = useT()
  /*
   * Disabled beats armed. The flag belongs to the caller and can outlive the
   * moment it was set in — a write starting under it, say — and a disabled
   * button that is still swallowing every keystroke is a page that has stopped
   * answering the keyboard for no reason the reader can see.
   */
  const waiting = armed && !disabled

  /*
   * The callbacks through a ref, so the listeners are attached once per wait
   * rather than once per render. Call sites pass lambdas; in the deps they
   * would tear the window's listeners down and put them back on every keystroke
   * the rest of the page caused.
   */
  const latest = useRef({ onArmed, onCapture })
  useEffect(() => {
    latest.current = { onArmed, onCapture }
  })

  useEffect(() => {
    if (!waiting) return
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const usage = usageForCode(e.code)
      if (usage === undefined) return
      latest.current.onCapture(usage)
      latest.current.onArmed(false)
    }
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onDown, { capture: true })
    window.addEventListener('keyup', onUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true })
      window.removeEventListener('keyup', onUp, { capture: true })
    }
  }, [waiting])

  return (
    <button
      type="button"
      className={waiting ? 'primary' : 'ghost'}
      disabled={disabled}
      onClick={() => onArmed(!armed)}
    >
      {waiting ? t('keyCapture.waiting') : t('keyCapture.press')}
    </button>
  )
}
