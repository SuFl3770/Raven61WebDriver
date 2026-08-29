import { useEffect, useState } from 'react'
import { FILTER_PRESETS, describeDevice, scoreDevice } from '../hid/filters'
import { HidLink } from '../hid/link'
import { isVendorPage } from '../hid/reportInfo'
import { Notice, Panel } from '../ui/Panel'
import { link, refreshCodec, useCodec, useConnection } from '../state/link'

export function DevicePanel() {
  const { device, connected } = useConnection()
  const codec = useCodec()
  const [presetId, setPresetId] = useState(FILTER_PRESETS[0]!.id)
  const [known, setKnown] = useState<HIDDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  const reloadKnown = async () => setKnown(await link.knownDevices())
  useEffect(() => {
    void reloadKnown()
  }, [])

  if (!HidLink.supported()) {
    return (
      <Panel title="장치">
        <Notice kind="err">
          <strong>이 브라우저는 WebHID를 지원하지 않습니다.</strong>
          <div className="small" style={{ marginTop: 4 }}>
            Chrome, Edge 또는 Opera 데스크톱 버전에서 열어 주세요. HTTPS 또는 localhost 여야 합니다.
          </div>
        </Notice>
      </Panel>
    )
  }

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null)
    try {
      await fn()
      await reloadKnown()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const preset = FILTER_PRESETS.find((p) => p.id === presetId)!

  return (
    <Panel title="장치">
      <div className="row">
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {FILTER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="primary" onClick={run(() => link.pickDevice(preset.filters))}>
          장치 선택…
        </button>
        <button onClick={run(() => link.close())} disabled={!connected}>
          연결 해제
        </button>
        <span className="badge">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? '연결됨' : '미연결'}
        </span>
        <span className="dim small">코덱: {codec.label}</span>
      </div>
      <div className="small dim" style={{ marginTop: 6 }}>
        {preset.hint}
      </div>

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      {device && (
        <div style={{ marginTop: 12 }} className="small">
          <div className="mono">{describeDevice(device)}</div>
          <div className="dim">
            컬렉션 {device.collections.length}개 · 벤더 정의{' '}
            {device.collections.filter((c) => isVendorPage(c.usagePage ?? 0)).length}개
          </div>
        </div>
      )}

      {known.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="small dim" style={{ marginBottom: 6 }}>
            이미 권한을 허용한 장치 (점수가 높을수록 설정용 인터페이스일 가능성이 큼)
          </div>
          <table>
            <thead>
              <tr>
                <th>장치</th>
                <th style={{ width: 70 }}>점수</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {[...known]
                .sort((a, b) => scoreDevice(b) - scoreDevice(a))
                .map((d, i) => (
                  <tr key={`${d.vendorId}-${d.productId}-${i}`}>
                    <td className="mono">{describeDevice(d)}</td>
                    <td>{scoreDevice(d)}</td>
                    <td>
                      <button
                        onClick={run(async () => {
                          await link.open(d)
                          await refreshCodec()
                        })}
                        disabled={d === device && connected}
                      >
                        {d === device && connected ? '사용 중' : '열기'}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
