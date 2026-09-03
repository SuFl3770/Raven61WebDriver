import { useState, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { Events } from './Events'
import { HidExplorer } from './HidExplorer'
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
 * moment you switch to another.
 */
interface Tool {
  id: string
  labelKey: MessageKey
  hintKey: MessageKey
  render: () => ReactNode
}

const TOOLS: Tool[] = [
  {
    id: 'explorer',
    labelKey: 'debug.tool.explorer.label',
    hintKey: 'debug.tool.explorer.hint',
    render: () => <HidExplorer />,
  },
  {
    id: 'console',
    labelKey: 'debug.tool.console.label',
    hintKey: 'debug.tool.console.hint',
    render: () => <ReportConsole />,
  },
  {
    id: 'prober',
    labelKey: 'debug.tool.prober.label',
    hintKey: 'debug.tool.prober.hint',
    render: () => <Prober />,
  },
  {
    id: 'events',
    labelKey: 'debug.tool.events.label',
    hintKey: 'debug.tool.events.hint',
    render: () => <Events />,
  },
  {
    id: 'log',
    labelKey: 'debug.tool.log.label',
    hintKey: 'debug.tool.log.hint',
    render: () => <TrafficLogView />,
  },
]

export function Debug() {
  const [active, setActive] = useState(TOOLS[0]!.id)
  const t = useT()
  const tool = TOOLS.find((tl) => tl.id === active) ?? TOOLS[0]!

  return (
    <>
      <Sensors analysis />

      <nav className="tabs subtabs" role="tablist" aria-label={t('debug.tools')}>
        {TOOLS.map((tl) => (
          <button
            key={tl.id}
            role="tab"
            aria-selected={tl.id === active}
            onClick={() => setActive(tl.id)}
          >
            {t(tl.labelKey)}
          </button>
        ))}
      </nav>
      <div className="small dim" style={{ padding: '6px 2px 10px' }}>
        {t(tool.hintKey)}
      </div>

      {tool.render()}
    </>
  )
}
