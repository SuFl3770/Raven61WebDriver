import { useT } from '../i18n'
import { BUILD, versionLine } from '../version'

/**
 * Build identity, pinned to the bottom-right corner of the viewport.
 *
 * Rendered next to the app rather than inside it so it stays put while the
 * content area scrolls, and so the layout does not have to make room for it.
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
      <span className="mono">{versionLine()}</span>
    </div>
  )
}
