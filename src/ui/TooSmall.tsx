import { useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { MIN_VIEWPORT, useTooSmall, useViewport } from '../state/viewport'

/**
 * The warning for a window too small to lay the app out in — see MIN_VIEWPORT
 * in state/viewport.ts for where the line is and why.
 *
 * It covers the window rather than sitting in the flow, because the point is
 * that what is behind it does not fit. It is not a wall, though: "carry on"
 * dismisses it, and the app is left to be used as best it can. The dismissal
 * lasts as long as the tab is open and is not persisted — someone who waved it
 * away once should not have to argue with it while they work, and someone
 * coming back later should be told again.
 *
 * Rendered from main.tsx and never unmounted, which is what lets a plain
 * `useState` hold the dismissal: it has to survive the window growing and
 * shrinking again.
 */
export function TooSmall() {
  const [dismissed, setDismissed] = useState(false)
  const tooSmall = useTooSmall()
  const { width, height } = useViewport()
  const t = useT()

  if (!tooSmall || dismissed) return null

  return (
    <div className="too-small" role="alertdialog" aria-labelledby="too-small-title">
      <div className="too-small-card">
        <svg className="too-small-art" viewBox="0 0 48 40" aria-hidden="true">
          <path d="M24 6v18M24 30v2" />
          <path d="M24 2 2 38h44z" />
        </svg>

        <h2 id="too-small-title">{t('viewport.tooSmall.title')}</h2>
        <p>
          <T k="viewport.tooSmall.body" />
        </p>

        {/* The numbers, so it is clear what was measured and what it is being
            measured against — a warning that only says "too small" leaves the
            reader guessing how much bigger is big enough. */}
        <p className="small dim mono">
          {t('viewport.tooSmall.size', {
            width,
            height,
            minWidth: MIN_VIEWPORT.width,
            minHeight: MIN_VIEWPORT.height,
          })}
        </p>

        <button onClick={() => setDismissed(true)}>{t('viewport.tooSmall.dismiss')}</button>
      </div>
    </div>
  )
}
