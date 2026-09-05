import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useSyncState } from '../state/sync'

/** How long the confirmation stays on screen. */
const TOAST_MS = 2400

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

  if (!shown) return null

  return (
    <div className="toast" role="status" aria-live="polite">
      {t('apply.applied', { count: shown.count })}
    </div>
  )
}
