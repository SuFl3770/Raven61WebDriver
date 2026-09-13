import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { supports } from '../protocol/codec'
import { firmwareStore, useFirmware } from '../state/firmware'
import { link, useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from './Panel'

/**
 * Which firmware the board is running — command `0x03`.
 *
 * Deliberately labelled a build, not a version. The board has no version
 * number to give: what comes back is the firmware's own name and the date and
 * time it was compiled, so that is what is shown. See FirmwareIdentity.
 *
 * The read happens on its own rather than through the settings block, because
 * the two have nothing to do with each other and one failing should not take
 * the other's panel down with it.
 *
 * There is no read button. Opening the tab reads, the answer cannot change
 * while the same board stays attached, and a button that always says the same
 * thing back is furniture. A retry does appear if that automatic read fails —
 * without one, a single timeout would leave the panel permanently blank.
 */
export function FirmwareInfo() {
  const codec = useCodec()
  const { device, connected } = useConnection()
  const t = useT()
  const firmware = useFirmware()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tried = useRef(false)

  const canRead = supports(codec, 'readFirmware')

  const read = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      firmwareStore.load(await codec.readFirmware!(link))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [codec])

  useEffect(() => {
    // Once per connection: the store outlives this panel and is emptied when
    // the device goes away.
    if (!connected || !canRead || tried.current || firmwareStore.current() !== null) return
    tried.current = true
    void read()
  }, [connected, canRead, read])

  if (!canRead) {
    return (
      <Panel title={t('firmware.title')}>
        <NotDecoded what="firmware.what" />
      </Panel>
    )
  }

  return (
    <Panel title={t('firmware.title')}>
      <dl className="facts">
        <dt>{t('firmware.device')}</dt>
        <dd className="mono">{device?.productName || '—'}</dd>

        <dt>{t('firmware.ids')}</dt>
        <dd className="mono">
          {device
            ? `0x${device.vendorId.toString(16).padStart(4, '0')} : 0x${device.productId
                .toString(16)
                .padStart(4, '0')}`
            : '—'}
        </dd>

        <dt>{t('firmware.build')}</dt>
        <dd className="mono">{firmware?.name ?? (busy ? t('apply.reading') : '—')}</dd>

        <dt>{t('firmware.built')}</dt>
        <dd className="mono">
          {firmware?.buildDate
            ? `${firmware.buildDate} ${firmware.buildTime ?? ''}`.trim()
            : busy
              ? t('apply.reading')
              : '—'}
        </dd>
      </dl>

      {error && (
        <div className="row" style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
          <button disabled={!connected || busy} onClick={() => void read()}>
            {busy ? t('apply.reading') : t('apply.retry')}
          </button>
        </div>
      )}
    </Panel>
  )
}
