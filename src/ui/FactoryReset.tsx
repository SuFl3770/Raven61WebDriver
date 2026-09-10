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
import { link, useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from './Panel'

/** Seconds the button is dead for after the first press. */
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
 * ## Two presses of one button, with three seconds between them
 *
 * The first press arms and explains: the button stays where it is, changes to
 * say what pressing it again will do, and the warning above it says what is
 * lost. The second press resets.
 *
 * The three seconds the button spends disabled in between are what makes one
 * button safe to use this way. A slip is a double-click, and a double-click
 * lands entirely inside that dead window — so the accident a two-press
 * confirmation is meant to prevent cannot get through it, while someone who
 * means it only has to wait out a countdown they can watch.
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

  // The countdown on the armed button. It stops at zero and stays armed there:
  // nothing times out, so a panel left open keeps whatever the user chose to
  // leave it at.
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

      {/*
        The warning goes above the button rather than around it, so that the
        button itself does not move between the two presses. A confirmation
        that relocates the thing being pressed is not the same button twice.
      */}
      {armed && !running && (
        <div style={{ marginBottom: 12 }}>
          <Notice kind="err">
            <strong>{t('reset.confirm.title')}</strong>
            <div className="small" style={{ marginTop: 6 }}>
              <T k="reset.confirm.body" />
            </div>
            <div className="small dim" style={{ marginTop: 6 }}>
              <T k="reset.confirm.kept" />
            </div>
          </Notice>
        </div>
      )}

      {!running && (
        <div className="row">
          <button
            className="danger"
            disabled={!connected || (armed && hold > 0)}
            onClick={armed ? () => void run() : arm}
          >
            {!armed
              ? t('reset.start')
              : hold > 0
                ? t('reset.confirm.wait', { seconds: hold })
                : t('reset.confirm.go')}
          </button>
          {armed ? (
            <button onClick={disarm}>{t('reset.cancel')}</button>
          ) : (
            <span className="small dim">{t('reset.startNote')}</span>
          )}
        </div>
      )}

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
