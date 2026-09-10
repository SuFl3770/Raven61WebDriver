import { useT } from '../i18n'
import { codecLabel, supports } from '../protocol/codec'
import { useDemo } from '../state/demo'
import { useCodec, useConnection } from '../state/link'
import { boardSync, useSyncState } from '../state/sync'

/**
 * Whether the app and the board hold the same thing, in the corner.
 *
 * Nobody presses "apply" — a change is written on its own (state/sync.ts) — so
 * there is nothing to put a status panel next to. What cannot go away is the
 * reporting: the write reply is the request echoed back, so a board that
 * ignored a write answers exactly like one that applied it, and the codec reads
 * the block back and compares bytes. This is where that comparison surfaces.
 *
 * A dot and a word, because that is all the steady state needs to say. Green
 * and "connected" is the claim that the board holds what is on screen — the two
 * are the same statement here, since a connection this app is not writing to
 * has nothing else to be. Amber is a write in flight.
 *
 * Red is the one state that is also a control. Failed keys stay dirty, so the
 * retry is not a second "apply": it is the only way out of a state the user
 * cannot otherwise leave, and the detail the panel used to list goes in the
 * tooltip.
 *
 * The demo board takes over the steady state, and only that one. "In step with
 * the board" is still true when the board is software — it holds every byte
 * that has been written to it — but "connected", said in a corner about a
 * keyboard that is not there, is not. The states either side of it are about an
 * exchange in flight and say something this cannot: replacing those would hide
 * a read or a failed write behind a label that never changes. Which board it is
 * is on the device card in the rail throughout.
 */
export function SyncBadge() {
  const { connected } = useConnection()
  const codec = useCodec()
  const demo = useDemo()
  const { phase, error, appliedAt, mismatch } = useSyncState()
  const t = useT()

  if (!connected) return null

  // A codec that cannot write is not a failure, but it does mean every edit on
  // every tab quietly goes nowhere, which is worth a permanent amber.
  if (!supports(codec, 'writeKeyPerf')) {
    return (
      <div className="sync-badge" title={t('apply.noWrite', { codec: codecLabel(codec) })}>
        <span className="dot busy" />
        {t('apply.readOnly')}
      </div>
    )
  }

  if (error !== null || mismatch.length > 0) {
    const detail = error ?? t('apply.mismatch', { count: mismatch.length })
    return (
      <button
        className="sync-badge failed"
        title={[detail, ...mismatch].join('\n')}
        onClick={() => void boardSync.flush()}
      >
        <span className="dot off" />
        {t('apply.failed')}
        <span className="dim">{t('apply.retry')}</span>
      </button>
    )
  }

  if (phase !== 'idle') {
    const label =
      phase === 'writing'
        ? t('apply.writing')
        : phase === 'reading'
          ? t('apply.reading')
          : t('apply.pending')
    return (
      <div className="sync-badge" title={label}>
        <span className="dot busy" />
        {label}
      </div>
    )
  }

  const applied = appliedAt
    ? t('apply.appliedAt', { time: appliedAt.toLocaleTimeString() })
    : t('apply.upToDate')

  return (
    <div
      className="sync-badge"
      // Both halves for the demo: what the badge would have said, and what it
      // is saying instead. A tooltip that dropped the first would take away the
      // only place the last write is timestamped.
      title={demo ? `${t('demo.tooltip')}\n${applied}` : applied}
    >
      <span className={demo ? 'dot demo' : 'dot on'} />
      {demo ? t('demo.badge') : t('app.connected')}
    </div>
  )
}
