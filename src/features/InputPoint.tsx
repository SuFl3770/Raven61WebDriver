import { useT } from '../i18n'
import { supports } from '../protocol/codec'
import { useCodec } from '../state/link'
import { ApplyBar } from '../ui/ApplyBar'
import { NotDecoded, Panel } from '../ui/Panel'
import { Actuation } from './Actuation'
import { Calibration } from './Calibration'
import { PerfOverview } from './PerfOverview'
import { RapidTrigger } from './RapidTrigger'

/**
 * Everything that decides *where* in the stroke a key triggers.
 *
 * The overview comes first and reads the board on entry, so the tab opens on
 * what the hardware actually has rather than on this app's defaults — the stock
 * driver's performance tab shows board state, and a panel that looks the same
 * while showing invented values would be worse than showing nothing.
 *
 * Below it, actuation sets the trigger depth, rapid trigger sets how travel
 * re-triggers, and calibration sets the bottom those two are measured from.
 * They were three tabs, which hid the fact that recalibrating moves the ground
 * under the other two settings.
 *
 * One apply bar covers actuation and rapid trigger: both edit the same key
 * configs and write through the same command, so two bars were two buttons for
 * one action.
 */
export function InputPoint() {
  const codec = useCodec()
  const t = useT()
  return (
    <>
      <PerfOverview />
      <Actuation />
      <RapidTrigger />
      <Panel title={t('inputPoint.apply')}>
        {supports(codec, 'writeKeyConfigs') ? (
          <ApplyBar />
        ) : (
          <NotDecoded what="inputPoint.writeWhat" />
        )}
      </Panel>
      <Calibration />
    </>
  )
}
