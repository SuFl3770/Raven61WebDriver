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
import { link, refreshCodec } from '../state/link'
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
      <div className="connect-card">
        <svg className="connect-art" viewBox="0 0 64 34" aria-hidden="true">
          <rect x="1" y="1" width="62" height="32" rx="5" />
          <path d="M9 10h6M20 10h6M31 10h6M42 10h6M53 10h2M9 17h6M20 17h6M31 17h6M42 17h6M53 17h2M9 24h6M20 24h24M49 24h6" />
        </svg>

        <h2>{t('connect.title')}</h2>

        {supported ? (
          <>
            {/* Blank in the bundle until there is something worth saying; an
                empty string must not leave an empty paragraph's margin behind. */}
            {t('connect.body') && (
              <p className="dim">
                <T k="connect.body" />
              </p>
            )}

            <div className="connect-actions">
              <button className="primary" disabled={busy} onClick={run(() => link.pickDevice(preset.filters, pickConfigInterface))}>
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

        <div className="connect-foot">
          <LanguageSelect />
        </div>
      </div>
    </div>
  )
}
