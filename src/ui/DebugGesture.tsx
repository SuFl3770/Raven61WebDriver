import { useT } from '../i18n'
import { DEBUG_GESTURE, useDebugGesture } from '../state/debugGesture'
import { useExitValue } from './useExit'

/**
 * How long the confirmation takes to leave. Must match `.toast.closing` in
 * styles.css — see ui/useExit.ts on why the two are written twice.
 */
const EXIT_MS = 160

/**
 * Listens for the Shift gesture and says what it did.
 *
 * Rendered once inside the app shell — on the connect screen as well as behind
 * the tabs, since the gesture is not about a connected board. It draws nothing
 * until a toggle happens, so it costs a listener and no layout.
 */
export function DebugGesture() {
  // Held for the length of its exit after the gesture store drops it, with the
  // wording of the toggle it is reporting — see ui/useExit.ts.
  const { shown: toggle, closing } = useExitValue(useDebugGesture(), EXIT_MS)
  const t = useT()
  if (!toggle) return null
  return (
    // Announced politely: the tab strip changing under someone using a screen
    // reader is worth a word, but not worth interrupting them for. Keyed by the
    // toggle, so five more taps during the first one's exit replay the arrival
    // rather than swapping the words under a fading box.
    <div key={toggle.at} className={`toast${closing ? ' closing' : ''}`} role="status" aria-live="polite">
      <strong>{toggle.on ? t('gesture.debug.on') : t('gesture.debug.off')}</strong>
      <span className="small dim">
        {t('gesture.debug.hint', { presses: DEBUG_GESTURE.presses })}
      </span>
    </div>
  )
}
