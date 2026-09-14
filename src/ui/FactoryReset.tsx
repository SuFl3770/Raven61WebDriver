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
import { MessageToast } from './MessageToast'
import { NotDecoded, Notice, PanelGroup } from './Panel'

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
 * ## The same dialog stays up for the erase
 *
 * Once the packet is out the dialog keeps its place and loses its buttons: the
 * stage line takes over the body, and there is nothing left to press. A reset
 * in flight cannot be answered — so Escape and the veil stop closing it too,
 * rather than putting the app back in reach of a board that is mid-erase.
 *
 * A clean result does not come back here. It is an event, not a state, so it
 * leaves as a toast and the dialog simply goes (ui/MessageToast.tsx). A
 * mismatch or an unread result *is* a state — it is what the reader has to act
 * on — so those stay in the panel where they can be read at leisure.
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
  /**
   * The last stage the reset reported, and what the dialog's body is chosen
   * by. Cleared when the question is asked again, *not* when the reset
   * finishes: the dialog stays mounted for the length of its exit animation,
   * and a stage that went back to null on the last line of `run` would put
   * the confirmation question back in the body for the fade — one frame of
   * "every setting will be erased", after it already has been.
   */
  const [stage, setStage] = useState<FactoryResetStage | null>(null)
  /** Whether a reset is in flight — which `stage` can no longer answer. */
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FactoryResetResult | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const disarm = useCallback(() => {
    setArmed(false)
    setHold(0)
  }, [])

  // What Escape and the veil do — which is nothing at all while the board is
  // erasing. There is no answer left to give, and closing the dialog would
  // only hand the app back with a reset still in flight.
  const requestClose = useCallback(() => {
    if (!busy) disarm()
  }, [busy, disarm])

  // The countdown on the dialog's confirm button. It stops at zero and the
  // dialog stays open there: nothing times out, so a question left standing is
  // still the same question whenever it is come back to.
  useEffect(() => {
    if (!armed || busy || hold === 0) return
    const tick = setTimeout(() => setHold((h) => h - 1), 1000)
    return () => clearTimeout(tick)
  }, [armed, busy, hold])

  // Disarm on disconnect: a panel that was armed for one board must not stay
  // armed for whatever is plugged in next.
  useEffect(() => {
    if (!connected) disarm()
  }, [connected, disarm])

  const canReset = supports(codec, 'factoryReset')

  if (!canReset) {
    return (
      <PanelGroup title={t('reset.title')}>
        <NotDecoded what="reset.what" />
      </PanelGroup>
    )
  }

  const arm = () => {
    setStage(null)
    setResult(null)
    setDone(null)
    setError(null)
    setHold(HOLD_SECONDS)
    setArmed(true)
  }

  const run = async () => {
    setError(null)
    setResult(null)
    setDone(null)
    // Before the packet, not after — see the note above.
    configStore.clear()
    globalStore.clear()
    // The reset takes the macro store with it, so what is cached about it is
    // about to be wrong — and for the same reason, before the packet.
    macroSnapshotStore.clear()
    setBusy(true)
    setStage('sending')
    try {
      const outcome = await codec.factoryReset!(link, setStage)
      if (outcome.after) globalStore.load(outcome.after)
      // A reset that came back with the firmware's own defaults has nothing
      // left to say, so it says it once and goes. Everything else is a state
      // and stays in the panel.
      if (outcome.after && outcome.unexpected.length === 0) setDone(t('reset.toast.ok'))
      else setResult(outcome)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      disarm()
    }
  }

  return (
    <PanelGroup>
      {/*
        Left in place, disabled, for as long as the reset runs. The dialog over
        the top is what is being read; a panel that emptied itself behind it
        would only be a gap that fills back in once the veil lifts.
      */}
      <div className="row">
        <span className="small dim" style={{ minWidth: 96 }}>
          {t('reset.title')}
        </span>
        <button className="danger" disabled={!connected || busy} onClick={arm}>
          {t('reset.button')}
        </button>
      </div>

      {/*
        One dialog for both halves: the question, and then the erase it started.
        `stage` is what swaps the body — asked through the state itself rather
        than through `busy`, which both narrows the label's type and keeps the
        stage in the body for the exit. See the note on `stage`.
      */}
      <Dialog open={armed} onClose={requestClose} title={t('reset.confirm.title')} tone="danger">
        {stage !== null ? (
          <>
            <div className="small">
              <strong>{t(STAGE_KEY[stage])}</strong>
            </div>
            <div className="small dim" style={{ marginTop: 4 }}>
              <T
                k="reset.stage.note"
                params={{
                  seconds: (spec.factoryReset.firstWaitMs + spec.factoryReset.secondWaitMs) / 1000,
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="small">
              <T k="reset.confirm.body" />
            </div>
            <DialogActions>
              {/*
                First in the source, so it is what the dialog puts the keyboard
                on when it opens — and it is the harmless one.
              */}
              <button onClick={disarm}>{t('reset.cancel')}</button>
              <button className="danger" disabled={!connected || hold > 0} onClick={() => void run()}>
                {hold > 0 ? t('reset.confirm.wait', { seconds: hold }) : t('reset.confirm.go')}
              </button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {result && <ResetOutcome result={result} />}

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      {/*
        Fixed to the window rather than laid out in the panel, so it lands
        where the eye already is once the dialog lifts. See `.toast` in
        styles.css.
      */}
      <MessageToast message={done} onDone={() => setDone(null)} />
    </PanelGroup>
  )
}

/**
 * What came back, when what came back needs acting on.
 *
 * Only the two outcomes that are states reach here. A clean reset left as a
 * toast, so the one distinction left is between "the board came back with
 * values that are not the defaults" and "the board did not answer the read" —
 * and the second is not a failure. Six seconds may not have been enough and
 * the board may still be writing flash, so it says what it knows and no more.
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
      <Notice kind="warn">
        <strong>{t('reset.done.different')}</strong>
        <dl className="facts" style={{ marginTop: 8 }}>
          <dt>{t('board.rate.label')}</dt>
          <dd className="mono">{reportRateName(after.reportRate)}</dd>
          <dt>{t('board.debounce.label')}</dt>
          <dd className="mono">{debounceLevelName(after.debounceLevel)}</dd>
        </dl>
        <div className="small dim mono" style={{ marginTop: 8 }}>
          {result.unexpected.map((u) => `${u.field} ${u.wanted} → ${u.got}`).join(' · ')}
        </div>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="reset.done.reread" />
        </div>
      </Notice>
    </div>
  )
}
