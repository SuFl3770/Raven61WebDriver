import { useState } from 'react'
import { useT } from '../i18n'
import { BUILD } from '../version'

/**
 * Build identity, at the foot of the rail.
 *
 * Two faces, one click apart: the channel and the commit — which build this is
 * — and, when pressed, the date it is from. Both fit the thirteen-character
 * column, but not on one line beside each other, and the date is the half you
 * want occasionally rather than the half you want on screen. The tooltip still
 * carries all of it, line by line, including the branch and the dirty marker.
 *
 * With no git behind the build there is no date to show, and the badge stays
 * the plain element it always was rather than a button that does nothing.
 */
export function VersionBadge() {
  const t = useT()
  const [showDate, setShowDate] = useState(false)
  const title = [
    t('version.channel', { channel: BUILD.channel }),
    BUILD.branch && t('version.branch', { branch: BUILD.branch }),
    t('version.commit', { commit: BUILD.commit }),
    BUILD.date && t('version.date', { date: BUILD.date }),
    BUILD.dirty && t('version.dirty'),
    BUILD.date && t('version.hint'),
  ]
    .filter(Boolean)
    .join('\n')

  const className = `version-badge ${BUILD.channel === 'stable' ? 'stable' : 'nightly'}`
  const face = (
    <>
      <span className="dot" />
      <span className="mono">
        {showDate ? (
          BUILD.date
        ) : (
          <>
            {BUILD.channel} · {BUILD.commit}
            {BUILD.dirty && '+'}
          </>
        )}
      </span>
    </>
  )

  if (!BUILD.date) {
    return (
      <div className={className} title={title}>
        {face}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-pressed={showDate}
      onClick={() => setShowDate((on) => !on)}
    >
      {face}
    </button>
  )
}
