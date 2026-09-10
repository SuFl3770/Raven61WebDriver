import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useSyncState } from '../state/sync'
import { useExitValue } from './useExit'

/** How long the confirmation stays on screen. */
const TOAST_MS = 2400

/**
 * And how long it takes to leave once it has. Must match `.toast.closing` in
 * styles.css — see ui/useExit.ts on why the two are written twice.
 */
const EXIT_MS = 160

/**
 * Says how many keys just reached the board, then gets out of the way.
 *
 * The corner badge (ui/SyncBadge.tsx) carries the steady state; this carries
 * the event. They are different jobs: a badge that says "connected" is still
 * saying it a minute later, and cannot tell you that the four keys you just
 * changed are the ones that landed.
 *
 * Only per-key writes are announced. A board-wide switch reports zero keys and
 * says nothing, because "0 keys applied" is worse than silence and the control
 * that was just flipped is its own confirmation.
 */
export function ApplyToast() {
  const { appliedAt, appliedKeys } = useSyncState()
  const [shown, setShown] = useState<{ at: number; count: number } | null>(null)
  const t = useT()

  // `appliedAt` is a fresh Date per write, so two writes of the same size still
  // re-fire this rather than looking like no change at all.
  useEffect(() => {
    if (!appliedAt || appliedKeys === 0) return
    setShown({ at: appliedAt.getTime(), count: appliedKeys })
  }, [appliedAt, appliedKeys])

  useEffect(() => {
    if (!shown) return
    const id = setTimeout(() => setShown(null), TOAST_MS)
    return () => clearTimeout(id)
  }, [shown])

  // Held for the length of its exit after the timer drops it, with its text —
  // a toast that blanked halfway through leaving would be worse than one that
  // disappeared. See ui/useExit.ts.
  const { shown: toast, closing } = useExitValue(shown, EXIT_MS)
  if (!toast) return null

  return (
    <div
      /*
       * Keyed by the moment it announces, so a second write during the first
       * one's exit remounts this and plays the arrival again. Without a key
       * React would reuse the element mid-fade, and the new count would fade
       * out on the old one's animation.
       */
      key={toast.at}
      className={`toast${closing ? ' closing' : ''}`}
      role="status"
      aria-live="polite"
    >
      {t('apply.applied', { count: toast.count })}
    </div>
  )
}
