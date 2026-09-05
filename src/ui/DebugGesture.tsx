import { useT } from '../i18n'
import { DEBUG_GESTURE, useDebugGesture } from '../state/debugGesture'

/**
 * Listens for the Shift gesture and says what it did.
 *
 * Rendered once inside the app shell — on the connect screen as well as behind
 * the tabs, since the gesture is not about a connected board. It draws nothing
 * until a toggle happens, so it costs a listener and no layout.
 */
export function DebugGesture() {
  const toggle = useDebugGesture()
  const t = useT()
  if (!toggle) return null
  return (
    // Announced politely: the tab strip changing under someone using a screen
    // reader is worth a word, but not worth interrupting them for.
    <div className="toast" role="status" aria-live="polite">
      <strong>{toggle.on ? t('gesture.debug.on') : t('gesture.debug.off')}</strong>
      <span className="small dim">
        {t('gesture.debug.hint', { presses: DEBUG_GESTURE.presses })}
      </span>
    </div>
  )
}
