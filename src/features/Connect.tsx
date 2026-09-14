import { useEffect, useState } from 'react'
import {
  filterPresets,
  describeDevice,
  pickConfigInterface,
  scoreDevice,
} from '../hid/filters'
import { HidLink } from '../hid/link'
import { useT } from '../i18n'
import { LanguageSelect } from '../i18n/LanguageSelect'
import { T } from '../i18n/T'
import { startDemo } from '../state/demo'
import { useAttaching } from '../state/attach'
import { link, refreshCodec, useConnection } from '../state/link'
import { BoardArt } from '../ui/BoardArt'
import { Notice } from '../ui/Panel'

/**
 * The whole app until a board is attached.
 *
 * Everything else on screen — actuation points, rapid trigger, the monitor —
 * is a view onto a device, so with nothing connected the tab strip was five
 * tabs of empty panels behind one "not connected" notice. This replaces them
 * until there is something to configure, and the interface-picking controls
 * that used to share the device tab move to the debug-only interface tab
 * (see App.tsx): picking one by hand is a protocol-debugging job, since a
 * normal connect already opens the highest-ranked interface.
 */
export function Connect() {
  const t = useT()
  /*
   * A board has answered and its picture is lighting up — see state/attach.ts,
   * which holds this screen for exactly as long as that takes. The line under
   * the board says which keyboard it was for that moment, and the device card
   * in the rail carries the same name from there on.
   */
  const attaching = useAttaching()
  const { device } = useConnection()
  const [known, setKnown] = useState<HIDDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = HidLink.supported()

  useEffect(() => {
    if (supported) void link.knownDevices().then(setKnown)
  }, [supported])

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null)
    setBusy(true)
    try {
      await fn()
      setKnown(await link.knownDevices())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // The Raven filter, so the chooser is not a list of every HID device in the
  // machine. The other presets exist for the debug tab, where a board that
  // reports an unexpected VID can still be reached.
  const preset = filterPresets()[0]!
  // Chrome remembers granted devices across reloads, so a second visit should
  // not need the chooser again. Only offer one that actually looks like a
  // configurator interface: an unrelated device the user once allowed would
  // otherwise be presented as the thing to reconnect to.
  const remembered = pickConfigInterface(known)
  const offer = remembered && scoreDevice(remembered) > 0 ? remembered : null

  return (
    <div className="connect">
      {/*
        The board is placed across the middle of the window and everything else
        below it — see `.connect` in styles.css for how. Nothing is framed:
        with a keyboard drawn across the middle of the screen there is no
        second thing up here for a card to tell it apart from.
      */}
      <BoardArt />

      <div className="connect-stage">
        {/*
          Above the branch, because a board attached in demo mode is a board
          attached whether or not this browser has WebHID — see startDemo. The
          key is what replays the fade: the two are different things to say, so
          they have to be different elements.

          Blank in the bundle until there is something worth saying; an empty
          string must not leave an empty paragraph's margin behind.
        */}
        {attaching && device ? (
          <p key="attached" className="dim connect-said" style={{fontSize: 16}}>
            {device.productName || t('device.unnamed')}
          </p>
        ) : (
          t('connect.body') && (
            <p key="waiting" className="dim connect-said" style={{fontSize: 16}}>
              <T k="connect.body" />
            </p>
          )
        )}

        {supported ? (
          <>
            <div className="connect-actions">
              <button disabled={busy} onClick={run(() => link.pickDevice(preset.filters, pickConfigInterface))}>
                {busy ? t('connect.connecting') : t('device.pick')}
              </button>

              {offer && (
                <button
                  disabled={busy}
                  onClick={run(async () => {
                    await link.open(offer)
                    await refreshCodec()
                  })}
                >
                  {t('connect.remembered', { device: describeDevice(offer) })}
                </button>
              )}
            </div>

            {error && <Notice kind="err">{error}</Notice>}

            <p className="small dim">{t('connect.requirements')}</p>
          </>
        ) : (
          <Notice kind="err">
            <strong>{t('device.unsupported.title')}</strong>
            <div className="small" style={{ marginTop: 4 }}>
              {t('device.unsupported.body')}
            </div>
          </Notice>
        )}

        {/*
          The foot of the window, not of the board. Neither of these is about
          the keyboard above them — the demo is the way in without one (a
          browser that cannot open a keyboard can still run the whole app
          against the simulated board, see src/demo/board.ts), and the language
          picker is chrome this window would carry on any screen. Both sit out
          of the way, under everything, centred.
        */}
        <div className="connect-foot">
          <button disabled={busy} onClick={run(startDemo)}>
            {t('connect.demo.action')}
          </button>
          <LanguageSelect />
        </div>
      </div>
    </div>
  )
}
