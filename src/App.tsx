import { useState, type ReactNode } from 'react'
import { Monitor } from './features/Monitor'
import { DevicePanel } from './tools/DevicePanel'
import { useCodec, useCodecAutoSelect, useConnection } from './state/link'

interface Tab {
  id: string
  label: string
  render: () => ReactNode
}

const TABS: Tab[] = [
  { id: 'device', label: '장치', render: () => <DevicePanel /> },
  { id: 'monitor', label: '모니터', render: () => <Monitor /> },
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
          <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}>
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
