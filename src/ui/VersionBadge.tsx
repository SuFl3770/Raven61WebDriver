import { useT } from '../i18n'
import { BUILD } from '../version'

/**
 * Build identity, at the foot of the rail.
 *
 * The commit alone, because the column it sits in is thirteen characters wide
 * and the channel, the date and the dirty marker do not fit beside it. None of
 * them is lost: the tooltip has always carried all of it, line by line, and
 * that is where the answer to "which build is this" is actually read from.
 */
export function VersionBadge() {
  const t = useT()
  const title = [
    t('version.channel', { channel: BUILD.channel }),
    BUILD.branch && t('version.branch', { branch: BUILD.branch }),
    t('version.commit', { commit: BUILD.commit }),
    BUILD.date && t('version.date', { date: BUILD.date }),
    BUILD.dirty && t('version.dirty'),
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className={`version-badge ${BUILD.channel === 'stable' ? 'stable' : 'nightly'}`} title={title}>
      <span className="dot" />
      <span className="mono">
        {BUILD.commit}
        {BUILD.dirty && '+'}
      </span>
    </div>
  )
}
