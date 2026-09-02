import { useEffect, useState } from 'react'
import { FILTER_PRESETS, describeDevice, pickConfigInterface, rankDevice } from '../hid/filters'
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
  const ranked = known
    .map((d) => ({ d, rank: rankDevice(d) }))
    .sort((a, b) => b.rank.score - a.rank.score)
  const recommended = ranked[0]?.d ?? null
  // Opening the typing interface looks like a successful connection but no
  // analog events ever arrive, so say so instead of leaving the monitor blank.
  const wrongInterface = connected && recommended !== null && device !== recommended

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
        <button className="primary" onClick={run(() => link.pickDevice(preset.filters, pickConfigInterface))}>
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

      {wrongInterface && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">
            지금 열린 인터페이스는 설정 채널이 아닌 것으로 보입니다. 아래 목록에서 <b>권장</b> 표시가 붙은
            것을 열어야 모니터에 키 깊이가 들어옵니다.
          </Notice>
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
            이미 권한을 허용한 인터페이스. 키보드 하나가 여러 개로 나뉘어 보이는 것이 정상이며,
            설정·모니터가 흐르는 것은 그중 하나뿐입니다 — 점수가 가장 높은 <b>권장</b> 인터페이스입니다.
          </div>
          <table>
            <thead>
              <tr>
                <th>인터페이스</th>
                <th style={{ width: 70 }}>점수</th>
                <th>근거</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ d, rank }, i) => (
                <tr key={`${d.vendorId}-${d.productId}-${i}`}>
                  <td className="mono">
                    {describeDevice(d)}
                    {d === recommended && (
                      <span className="small" style={{ color: 'var(--accent)' }}> ← 권장</span>
                    )}
                  </td>
                  <td>{rank.score}</td>
                  <td className="small dim">{rank.reasons.join(', ') || '—'}</td>
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
