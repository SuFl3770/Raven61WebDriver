import { useT } from '../i18n'
import { useConnection } from '../state/link'
import { Panel } from './Panel'

/**
 * Which board the rest of this tab is talking to.
 *
 * Only what the USB descriptor already says: the product name and the two ids
 * that pick the device out of everything else attached. Nothing here is read
 * off the board, so there is no read to fail and no retry to offer.
 */
export function DeviceInfo() {
  const { device } = useConnection()
  const t = useT()

  return (
    <Panel title={t('deviceInfo.title')}>
      <dl className="facts">
        <dt>{t('deviceInfo.device')}</dt>
        <dd className="mono">{device?.productName || '—'}</dd>

        <dt>{t('deviceInfo.ids')}</dt>
        <dd className="mono">
          {device
            ? `0x${device.vendorId.toString(16).padStart(4, '0')} : 0x${device.productId
                .toString(16)
                .padStart(4, '0')}`
            : '—'}
        </dd>
      </dl>
    </Panel>
  )
}
