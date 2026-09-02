import { supports } from '../protocol/codec'
import { useCodec } from '../state/link'
import { ApplyBar } from '../ui/ApplyBar'
import { NotDecoded, Panel } from '../ui/Panel'
import { Actuation } from './Actuation'
import { Calibration } from './Calibration'
import { RapidTrigger } from './RapidTrigger'

/**
 * Everything that decides *where* in the stroke a key triggers.
 *
 * Actuation sets the trigger depth, rapid trigger sets how travel re-triggers,
 * and calibration sets the bottom those two are measured from. They were three
 * tabs, which hid the fact that recalibrating moves the ground under the other
 * two settings.
 *
 * One apply bar covers actuation and rapid trigger: both edit the same key
 * configs and write through the same command, so two bars were two buttons for
 * one action.
 */
export function InputPoint() {
  const codec = useCodec()
  return (
    <>
      <Actuation />
      <RapidTrigger />
      <Panel title="적용">
        {supports(codec, 'writeKeyConfigs') ? (
          <ApplyBar />
        ) : (
          <NotDecoded what="액추에이션 · 래피드 트리거 쓰기" />
        )}
      </Panel>
      <Calibration />
    </>
  )
}
