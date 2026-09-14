import { useT } from '../i18n'
import { cancelReconnect, useReconnect, WAIT_MS } from '../state/reconnect'
import { Dialog, DialogActions } from './Dialog'

/**
 * The board is gone, and the session is being held open for it.
 *
 * Over the app rather than instead of it: what is behind this dialog is the tab
 * the user was on, which is where they are put back the moment the keyboard
 * answers again. See state/reconnect.ts for the wait itself.
 *
 * The rail drains rather than fills. What it measures is the time left, and a
 * bar that grew would be reporting progress towards the outcome nobody in front
 * of it wants.
 *
 * Escape and the veil end the wait, the same as the button — this is a dialog
 * with nothing to lose by being dismissed, since the board has already gone and
 * everything read off it went with it.
 */
export function Reconnect() {
  const { waiting, left } = useReconnect()
  const t = useT()
  const seconds = Math.ceil(left / 1000)
  const pct = (left / WAIT_MS) * 100

  return (
    <Dialog open={waiting} onClose={cancelReconnect} title={t('reconnect.title')} tone="warn">
      <div className="reconnect">
        <div className="reconnect-line">
          <span className="small">{t('reconnect.waiting')}</span>
          <span className="small dim">{t('reconnect.seconds', { seconds })}</span>
        </div>

        <div
          className="progress"
          role="progressbar"
          aria-label={t('reconnect.waiting')}
          aria-valuemin={0}
          aria-valuemax={WAIT_MS / 1000}
          aria-valuenow={seconds}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <DialogActions>
        <button onClick={cancelReconnect}>{t('reconnect.stop')}</button>
      </DialogActions>
    </Dialog>
  )
}
