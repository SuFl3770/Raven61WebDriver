import { useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { DEBUG_GESTURE } from '../state/debugGesture'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { Events } from './Events'
import { HidExplorer } from './HidExplorer'
import { KeyIdSetting } from './KeyIdSetting'
import { Prober } from './Prober'
import { ReportConsole } from './ReportConsole'
import { Sensors } from './Sensors'
import { TrafficLogView } from './TrafficLogView'

/**
 * The reverse-engineering tools, behind one tab.
 *
 * They were five tabs of equal standing with the settings panels, which made a
 * configurator look like a protocol lab. Stacking all five as panels would be a
 * very long page, so they keep their own sub-navigation.
 *
 * The live monitor sits above that navigation rather than inside it: probing a
 * command and watching what the board reports back are the same activity, and
 * putting the stream in one of the sub-tools would mean losing sight of it the
 * moment you switch to another. The identity-table switch is above it for the
 * same kind of reason — see KeyIdSetting.
 */
const TOOLS: SubTab[] = [
  {
    id: 'explorer',
    labelKey: 'debug.tool.explorer.label',
    render: () => <HidExplorer />,
  },
  {
    id: 'console',
    labelKey: 'debug.tool.console.label',
    render: () => <ReportConsole />,
  },
  {
    id: 'prober',
    labelKey: 'debug.tool.prober.label',
    render: () => <Prober />,
  },
  {
    id: 'events',
    labelKey: 'debug.tool.events.label',
    render: () => <Events />,
  },
  {
    id: 'log',
    labelKey: 'debug.tool.log.label',
    render: () => <TrafficLogView />,
  },
]

export function Debug() {
  const [active, setActive] = useState(TOOLS[0]!.id)
  const t = useT()
  return (
    <>
      {/*
        How to leave. The gesture that turns this tab on is the gesture that
        turns it off, and with the settings checkbox gone this line is the only
        place that says so — which matters most for whoever got here by
        accident.
      */}
      <div className="small dim" style={{ marginBottom: 12 }}>
        <T k="debug.gestureOff" params={{ presses: DEBUG_GESTURE.presses }} />
      </div>

      <Sensors analysis />
      {/*
        Directly under the analysis, because that is where the warning about a
        drifted identity table appears and this is the switch that answers it.
      */}
      <KeyIdSetting />
      <SubTabs tabs={TOOLS} label={t('debug.tools')} active={active} onActive={setActive} />
    </>
  )
}
