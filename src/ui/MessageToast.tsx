import { useEffect } from 'react'
import { useExitValue } from './useExit'

/** How long a confirmation stays on screen. */
const TOAST_MS = 2400

/**
 * And how long it takes to leave once it has. Must match `.toast.closing` in
 * styles.css — see ui/useExit.ts on why the two are written twice.
 */
const EXIT_MS = 160

/**
 * A message a panel wants to say once and then stop saying.
 *
 * A notice is the right shape for a *state* — the draft does not fit, the
 * board holds something else — because it is true until something changes it
 * and it should sit there until it is. "The write landed" is not a state: it
 * is over the moment it is read, and a panel that keeps it grows a line every
 * time it is used, moving everything under it down, until the next edit
 * quietly takes the line away again.
 *
 * So it goes where the app already puts the news of a write: the toast under
 * the top bar that per-key applies use (ui/ApplyToast.tsx). Failures are not
 * moved — a mismatch or an error is a state, it is what the reader has to act
 * on, and a message that removed itself after two seconds would be the wrong
 * half of that pair.
 *
 * `onDone` rather than an internal timer alone: the message lives in the
 * panel's state, and the panel is what has to forget it so the same message
 * re-fires next time instead of being a value that never changed.
 */
export function MessageToast({
  message,
  onDone,
}: {
  message: string | null
  onDone: () => void
}) {
  useEffect(() => {
    if (message === null) return
    const id = setTimeout(onDone, TOAST_MS)
    return () => clearTimeout(id)
  }, [message, onDone])

  // Held with its text for the length of its exit, so it withdraws rather than
  // blanking halfway out — see ui/useExit.ts.
  const { shown, closing } = useExitValue(message, EXIT_MS)
  if (shown === null) return null
  return (
    <div className={`toast${closing ? ' closing' : ''}`} role="status" aria-live="polite">
      {shown}
    </div>
  )
}
