import { BUILD, versionLine } from '../version'

/**
 * Build identity, pinned to the bottom-right corner of the viewport.
 *
 * Rendered next to the app rather than inside it so it stays put while the
 * content area scrolls, and so the layout does not have to make room for it.
 */
export function VersionBadge() {
  const title = [
    `채널 ${BUILD.channel}`,
    BUILD.branch && `브랜치 ${BUILD.branch}`,
    `커밋 ${BUILD.commit}`,
    BUILD.date && `커밋 날짜 ${BUILD.date}`,
    BUILD.dirty && '커밋되지 않은 변경이 포함된 빌드',
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
