import { useState, type ReactNode } from 'react'
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
  label: string
  hint: string
  render: () => ReactNode
}

const TOOLS: Tool[] = [
  {
    id: 'explorer',
    label: '탐색기',
    hint: '리포트 디스크립터 트리, 사용 가능한 리포트 ID와 길이',
    render: () => <HidExplorer />,
  },
  {
    id: 'console',
    label: '콘솔',
    hint: '프레임·블록 형식으로 명령 송신, 반복 전송 후 변하는 바이트 표시',
    render: () => <ReportConsole />,
  },
  {
    id: 'prober',
    label: '프로버',
    hint: '실제 프레임(체크섬 자동)으로 명령을 스윕하고 응답 확인',
    render: () => <Prober />,
  },
  {
    id: 'events',
    label: '이벤트',
    hint: '보드가 올려보내는 리포트 수신 + 센서 주소 연결',
    render: () => <Events />,
  },
  {
    id: 'log',
    label: '로그',
    hint: '모든 송수신 기록, A/B 바이트 diff, TXT·JSON 내보내기',
    render: () => <TrafficLogView />,
  },
]

export function Debug() {
  const [active, setActive] = useState(TOOLS[0]!.id)
  const tool = TOOLS.find((t) => t.id === active) ?? TOOLS[0]!

  return (
    <>
      <Sensors analysis />

      <nav className="tabs subtabs" role="tablist" aria-label="분석 도구">
        {TOOLS.map((t) => (
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
      <div className="small dim" style={{ padding: '6px 2px 10px' }}>
        {tool.hint}
      </div>

      {tool.render()}
    </>
  )
}
