import { useT } from '../i18n'
import { useConnection } from '../state/link'

/**
 * What is plugged in, at the top of the rail.
 *
 * The name is the board as its firmware introduces itself, and the two numbers
 * under it are how the machine tells one board from another: the USB vendor and
 * product ids, in hex, the form every other tool prints them in. They are here
 * rather than only on the settings tab because they are the first thing worth
 * quoting when something is wrong — a board that reports an unexpected pair is
 * the explanation for half of what can go strange in this app.
 *
 * Firmware build and the board's own settings deliberately stay on the settings
 * tab: those are read over the wire and can fail, and a card in the chrome is
 * the wrong place for something that has to explain itself.
 */
export function DeviceCard() {
  const { device } = useConnection()
  const t = useT()
  if (!device) return null

  const hex = (n: number) => n.toString(16).padStart(4, '0')

  return (
    <section className="devicecard">
      <h2 title={device.productName || undefined}>{device.productName || t('device.unnamed')}</h2>
      <div className="ids">
        {hex(device.vendorId)}:{hex(device.productId)}
      </div>
    </section>
  )
}
