import { sensorMap, useSensorMap } from '../state/sensorMap'
import { settings, useSettings } from '../state/settings'
import { Notice, Panel } from '../ui/Panel'

export function Settings() {
  const { debug } = useSettings()
  // Subscribes so the built-in-table switch below reflects changes made
  // anywhere else.
  useSensorMap()

  return (
    <>
      <Panel title="표시">
        <label className="row">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => settings.set('debug', e.target.checked)}
          />
          <span>
            디버그 모드
            <div className="small dim" style={{ marginTop: 2 }}>
              <b>디버그</b> 탭을 표시합니다 — 최상단에 실시간 모니터링, 그 아래 분석 패널
              (관측된 식별자 · 키 주소 후보 · 기준 ADC 표류)과 도구(탐색기 · 콘솔 · 프로버 ·
              이벤트 · 로그). 프로토콜을 해독할 때 쓰는 것들이라 평소에는 필요하지 않습니다.
            </div>
          </span>
        </label>
      </Panel>

      <Panel title="키 식별">
        <label className="row">
          <input
            type="checkbox"
            checked={sensorMap.builtInIgnored}
            onChange={(e) => sensorMap.setIgnoreBuiltIn(e.target.checked)}
          />
          <span>
            내장 식별표 무시 — 직접 연결한 것만 사용
            <div className="small dim" style={{ marginTop: 2 }}>
              61키 전부는 이제 이벤트가 스스로 이름을 말하므로(수정자는{' '}
              <span className="mono">payload[2]</span> 의 HID 수정자 비트마스크) 이 표는 폴백일
              뿐입니다. 표는 센서값과 기준 ADC 로 키를 맞히는데 둘 다 캘리브레이션이 바꾸는
              값이어서, 어긋난 표는 <b>맞히지 못하는 대신 틀리게 맞힙니다.</b> 그럴 때 끄세요.
            </div>
          </span>
        </label>
      </Panel>

      <Panel title="저장되는 것">
        <Notice>
          <span className="small">
            위 설정과 <b>이벤트</b> 탭에서 연결한 센서 주소는 이 브라우저의{' '}
            <span className="mono">localStorage</span> 에만 저장됩니다. 보드에는 아무것도 쓰지
            않으므로, 다른 PC 에서 열면 기본값으로 시작합니다.
          </span>
        </Notice>
      </Panel>
    </>
  )
}
