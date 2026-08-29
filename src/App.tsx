import { useState, type ReactNode } from 'react'
import { Actuation } from './features/Actuation'
import { Keymap } from './features/Keymap'
import { Monitor } from './features/Monitor'
import { RapidTrigger } from './features/RapidTrigger'
import { DevicePanel } from './tools/DevicePanel'
import { Events } from './tools/Events'
import { HidExplorer } from './tools/HidExplorer'
import { Prober } from './tools/Prober'
import { ReportConsole } from './tools/ReportConsole'
import { TrafficLogView } from './tools/TrafficLogView'
import { useCodec, useCodecAutoSelect, useConnection } from './state/link'

interface Tab {
  id: string
  label: string
  render: () => ReactNode
}

const TABS: Tab[] = [
  { id: 'device', label: '장치', render: () => <DevicePanel /> },
  { id: 'actuation', label: '액추에이션', render: () => <Actuation /> },
  { id: 'rt', label: '래피드 트리거', render: () => <RapidTrigger /> },
  { id: 'monitor', label: '모니터', render: () => <Monitor /> },
  { id: 'keymap', label: '키맵', render: () => <Keymap /> },
  { id: 'explorer', label: '탐색기', render: () => <HidExplorer /> },
  { id: 'console', label: '콘솔', render: () => <ReportConsole /> },
  { id: 'prober', label: '프로버', render: () => <Prober /> },
  { id: 'events', label: '이벤트', render: () => <Events /> },
  { id: 'log', label: '로그', render: () => <TrafficLogView /> },
]

export default function App() {
  useCodecAutoSelect()
  const [active, setActive] = useState('device')
  const { device, connected } = useConnection()
  const codec = useCodec()
  const tab = TABS.find((t) => t.id === active) ?? TABS[0]!

  return (
    <div className="app">
      <header className="topbar">
        <h1>Raven61 Web Driver</h1>
        <span className="badge">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? device?.productName || '연결됨' : '미연결'}
        </span>
        <span className="spacer" />
        <span className="small dim">코덱 {codec.label}</span>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {active !== 'device' && !connected && (
          <div className="panel">
            <div className="notice">
              장치가 연결되어 있지 않습니다. <b>장치</b> 탭에서 먼저 연결하세요.
            </div>
          </div>
        )}
        {tab.render()}
      </main>
    </div>
  )
}
