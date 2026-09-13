import { useCallback, useEffect, useState } from 'react'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { supports } from '../protocol/codec'
import { useDeviceSpec } from '../device/active'
import { reportRateName } from '../device/tables'
import type { FactoryResetResult, FactoryResetStage } from '../protocol/engine'
import { debounceLevelName } from '../protocol/types'
import { configStore } from '../state/config'
import { globalStore } from '../state/global'
import { macroSnapshotStore } from '../state/macroSnapshot'
import { link, useCodec, useConnection } from '../state/link'
import { Dialog, DialogActions } from './Dialog'
import { NotDecoded, Notice, Panel } from './Panel'

/** Seconds the dialog's confirm button is dead for after it opens. */
const HOLD_SECONDS = 3

/** Stage labels, spelled out so the keys stay checkable against the bundle. */
const STAGE_KEY: Record<FactoryResetStage, MessageKey> = {
  sending: 'reset.stage.sending',
  waiting: 'reset.stage.waiting',
  reading: 'reset.stage.reading',
}

/**
 * ⚠⚠ Factory reset — the one control in this app that destroys settings.
 *
 * ## A dialog, and three seconds inside it
 *
 * The button on the panel does not reset anything. It opens a modal that says
 * what is lost, and the reset is sent from a second button in there — so the
 * two presses are on two different controls, in two different places, and a
 * double-click on the first one cannot reach the second.
 *
 * The three seconds that second button spends disabled are kept anyway. A
 * dialog that can be answered the instant it appears is answered before it is
 * read; the countdown buys the time it takes to read the two paragraphs above
 * it, and it is a countdown rather than a mystery so the wait is watchable.
 *
 * Escape and a click on the veil both cancel, which is the safe direction.
 * Confirming is the one outcome that needs a deliberate press on a button
 * that says what it does.
 *
 * ## Clearing before sending, not after
 *
 * `configStore.clear()` runs before the packet, not once the reset is done. The
 * board spends about six seconds erasing flash, and for those six seconds the
 * input-point tab would otherwise still be holding the settings it read a
 * minute ago — with an apply button willing to write them into a board that is
 * mid-erase. Clearing first takes `lastRead` back to null, which is what that
 * button is gated on.
 */
export function FactoryReset() {
  const spec = useDeviceSpec()
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()
  const [armed, setArmed] = useState(false)
  /** Seconds the confirm button stays dead after arming. */
  const [hold, setHold] = useState(0)
  const [stage, setStage] = useState<FactoryResetStage | null>(null)
  const [result, setResult] = useState<FactoryResetResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = stage !== null

  const disarm = useCallback(() => {
    setArmed(false)
    setHold(0)
  }, [])

  // The countdown on the dialog's confirm button. It stops at zero and the
  // dialog stays open there: nothing times out, so a question left standing is
  // still the same question whenever it is come back to.
  useEffect(() => {
    if (!armed || running || hold === 0) return
    const tick = setTimeout(() => setHold((h) => h - 1), 1000)
    return () => clearTimeout(tick)
  }, [armed, running, hold])

  // Disarm on disconnect: a panel that was armed for one board must not stay
  // armed for whatever is plugged in next.
  useEffect(() => {
    if (!connected) disarm()
  }, [connected, disarm])

  const canReset = supports(codec, 'factoryReset')

  if (!canReset) {
    return (
      <Panel title={t('reset.title')}>
        <NotDecoded what="reset.what" />
      </Panel>
    )
  }

  const arm = () => {
    setResult(null)
    setError(null)
    setHold(HOLD_SECONDS)
    setArmed(true)
  }

  const run = async () => {
    setError(null)
    setResult(null)
    // Before the packet, not after — see the note above.
    configStore.clear()
    globalStore.clear()
    // The reset takes the macro store with it, so what is cached about it is
    // about to be wrong — and for the same reason, before the packet.
    macroSnapshotStore.clear()
    setStage('sending')
    try {
      const outcome = await codec.factoryReset!(link, setStage)
      if (outcome.after) globalStore.load(outcome.after)
      setResult(outcome)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
      disarm()
    }
  }

  return (
    <Panel title={t('reset.title')}>
      <div className="small dim" style={{ marginBottom: 12 }}>
        <T k="reset.hint" />
      </div>

      {!running && (
        <div className="row">
          <button className="danger" disabled={!connected} onClick={arm}>
            {t('reset.start')}
          </button>
          <span className="small dim">{t('reset.startNote')}</span>
        </div>
      )}

      {/*
        Open for exactly as long as the question stands. `running` closes it
        rather than `run` doing so itself: what happens next belongs to the
        panel — the stage notice and then the outcome — and a modal held over
        the top of that would be covering the answer it asked for.
      */}
      <Dialog open={armed && !running} onClose={disarm} title={t('reset.confirm.title')} tone="danger">
        <div className="small">
          <T k="reset.confirm.body" />
        </div>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="reset.confirm.kept" />
        </div>
        <DialogActions>
          {/*
            First in the source, so it is what the dialog puts the keyboard on
            when it opens — and it is the harmless one.
          */}
          <button onClick={disarm}>{t('reset.cancel')}</button>
          <button className="danger" disabled={!connected || hold > 0} onClick={() => void run()}>
            {hold > 0 ? t('reset.confirm.wait', { seconds: hold }) : t('reset.confirm.go')}
          </button>
        </DialogActions>
      </Dialog>

      {running && (
        <Notice kind="warn">
          <strong>{t(STAGE_KEY[stage])}</strong>
          <div className="small dim" style={{ marginTop: 4 }}>
            <T
              k="reset.stage.note"
              params={{
                seconds: (spec.factoryReset.firstWaitMs + spec.factoryReset.secondWaitMs) / 1000,
              }}
            />
          </div>
        </Notice>
      )}

      {result && <ResetOutcome result={result} />}

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}
    </Panel>
  )
}

/**
 * What came back, said three different ways depending on what is known.
 *
 * The distinction that matters is between "the board came back with the
 * firmware's own defaults" and "the board did not answer the read". The second
 * is not a failure — six seconds may not have been enough, and the board may
 * still be writing flash — so it says what it knows and nothing more.
 */
function ResetOutcome({ result }: { result: FactoryResetResult }) {
  const t = useT()

  if (!result.after) {
    return (
      <div style={{ marginTop: 10 }}>
        <Notice kind="warn">
          <strong>{t('reset.done.unread')}</strong>
          <div className="small dim" style={{ marginTop: 4 }}>
            <T k="reset.done.unreadNote" />
          </div>
        </Notice>
      </div>
    )
  }

  const after = result.after
  return (
    <div style={{ marginTop: 10 }}>
      <Notice kind={result.unexpected.length === 0 ? 'ok' : 'warn'}>
        <strong>
          {result.unexpected.length === 0 ? t('reset.done.ok') : t('reset.done.different')}
        </strong>
        <dl className="facts" style={{ marginTop: 8 }}>
          <dt>{t('board.rate.label')}</dt>
          <dd className="mono">{reportRateName(after.reportRate)}</dd>
          <dt>{t('board.debounce.label')}</dt>
          <dd className="mono">{debounceLevelName(after.debounceLevel)}</dd>
        </dl>
        {result.unexpected.length > 0 && (
          <div className="small dim mono" style={{ marginTop: 8 }}>
            {result.unexpected.map((u) => `${u.field} ${u.wanted} → ${u.got}`).join(' · ')}
          </div>
        )}
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="reset.done.reread" />
        </div>
      </Notice>
    </div>
  )
}
