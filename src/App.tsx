import { useState, type ReactNode } from 'react'
import { InputPoint } from './features/InputPoint'
import { Keymap } from './features/Keymap'
import { Settings } from './features/Settings'
import { useT, type MessageKey } from './i18n'
import { T } from './i18n/T'
import { Debug } from './tools/Debug'
import { DevicePanel } from './tools/DevicePanel'
import { Sensors } from './tools/Sensors'
import { useCodec, useCodecAutoSelect, useConnection } from './state/link'
import { useSettings } from './state/settings'

interface Tab {
  id: string
  labelKey: MessageKey
  render: () => ReactNode
}

const TABS: Tab[] = [
  { id: 'device', labelKey: 'app.tab.device', render: () => <DevicePanel /> },
  { id: 'input', labelKey: 'app.tab.input', render: () => <InputPoint /> },
  { id: 'sensors', labelKey: 'app.tab.sensors', render: () => <Sensors /> },
  { id: 'keymap', labelKey: 'app.tab.keymap', render: () => <Keymap /> },
  { id: 'settings', labelKey: 'app.tab.settings', render: () => <Settings /> },
]

/** Shown only with debug mode on — see state/settings.ts. */
const DEBUG_TAB: Tab = { id: 'debug', labelKey: 'app.tab.debug', render: () => <Debug /> }

export default function App() {
  useCodecAutoSelect()
  const [active, setActive] = useState('device')
  const { device, connected } = useConnection()
  const { debug } = useSettings()
  const codec = useCodec()
  const t = useT()
  const tabs = debug ? [...TABS, DEBUG_TAB] : TABS
  // Turning debug mode off while its tab is open falls back to the first tab
  // rather than rendering nothing.
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]!

  return (
    <div className="app">
      <header className="topbar">
        <h1>Raven61 Web Driver</h1>
        <span className="badge">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? device?.productName || t('app.connected') : t('app.disconnected')}
        </span>
        <span className="spacer" />
        <span className="small dim">{t('app.codec', { codec: t(codec.labelKey) })}</span>
      </header>

      <nav className="tabs" role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tb.id === active}
            onClick={() => setActive(tb.id)}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </nav>

      <main className="content">
        {active !== 'device' && !connected && (
          <div className="panel">
            <div className="notice">
              <T k="app.notConnected" />
            </div>
          </div>
        )}
        {tab.render()}
      </main>
    </div>
  )
}
