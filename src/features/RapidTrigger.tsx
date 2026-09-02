import { MM_PER_COUNT, quantizeMm } from '../protocol/encoding'
import { configStore, useKeyConfigs } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { NotDecoded, Notice, Panel } from '../ui/Panel'
import { SelectionBar } from '../ui/SelectionBar'

export function RapidTrigger() {
  const configs = useKeyConfigs()
  const sel = useSelection()
  const lead = configs[targetKeys(sel)[0] ?? 0]!
  const first = lead.rapidTrigger
  const dz = lead.deadZone

  // Read the selection at event time — see the note in Actuation.
  const patch = (p: Partial<typeof first>) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      rapidTrigger: { ...c.rapidTrigger, ...p },
    }))

  const patchDz = (p: Partial<typeof dz>) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      deadZone: { ...c.deadZone, ...p },
    }))

  /** With "separate" off the board uses one sensitivity for both directions. */
  const setSensitivity = (mm: number) => {
    const v = quantizeMm(mm)
    patch(first.separate ? { pressMm: v } : { pressMm: v, releaseMm: v })
  }

  return (
    <>
      <Panel title="래피드 트리거">
        <SelectionBar />
        <KeyGrid
          selected={sel}
          onSelect={(i, additive) => selection.toggle(i, additive)}
          sub={(k) => (configs[k.index]!.rapidTrigger.enabled ? 'RT' : undefined)}
        />

        <label className="row" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={first.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>선택한 키에 래피드 트리거 사용</span>
        </label>

        <div className="row" style={{ marginTop: 12, opacity: first.enabled ? 1 : 0.5 }}>
          <label className="small dim">
            {first.separate ? '누름 민감도 (mm)' : '민감도 (mm)'}
            <input
              type="number"
              min={MM_PER_COUNT}
              max={2}
              step={MM_PER_COUNT}
              value={first.pressMm}
              disabled={!first.enabled}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              style={{ width: 90, display: 'block', marginTop: 4 }}
            />
          </label>
          {first.separate && (
            <label className="small dim">
              뗌 민감도 (mm)
              <input
                type="number"
                min={MM_PER_COUNT}
                max={2}
                step={MM_PER_COUNT}
                value={first.releaseMm}
                disabled={!first.enabled}
                onChange={(e) => patch({ releaseMm: quantizeMm(Number(e.target.value)) })}
                style={{ width: 90, display: 'block', marginTop: 4 }}
              />
            </label>
          )}
          <label className="small" style={{ alignSelf: 'end' }}>
            <input
              type="checkbox"
              checked={first.separate}
              disabled={!first.enabled}
              onChange={(e) => patch({ separate: e.target.checked })}
            />{' '}
            누름/뗌 분리
          </label>
          <label className="small" style={{ alignSelf: 'end' }}>
            <input
              type="checkbox"
              checked={first.continuous}
              disabled={!first.enabled}
              onChange={(e) => patch({ continuous: e.target.checked })}
            />{' '}
            연속 모드 (액추에이션 위에서도 동작)
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <Notice>
            <span className="small">
              보드의 최소 단위는 0.02mm 이고 공장 기본값은 누름·뗌 모두 0.10mm 입니다. 이보다 낮추면 센서
              노이즈가 그대로 입력으로 새어 나올 수 있으니, <b>모니터</b> 탭에서 정지 상태의 흔들림 폭을 먼저
              확인하세요.
            </span>
          </Notice>
        </div>
      </Panel>

      <Panel title="데드존">
        <div className="small dim" style={{ marginBottom: 10 }}>
          스트로크 위·아래 끝에서 무시할 구간입니다. 순정 드라이버의 Top / Bottom dead zone 과 같습니다.
        </div>
        <label className="row">
          <input type="checkbox" checked={dz.enabled} onChange={(e) => patchDz({ enabled: e.target.checked })} />
          <span>선택한 키에 데드존 사용</span>
        </label>
        <div className="row" style={{ marginTop: 12, opacity: dz.enabled ? 1 : 0.5 }}>
          <label className="small dim">
            위쪽 (mm)
            <input
              type="number"
              min={0}
              max={1}
              step={MM_PER_COUNT}
              value={dz.topMm}
              disabled={!dz.enabled}
              onChange={(e) => patchDz({ topMm: quantizeMm(Number(e.target.value)) })}
              style={{ width: 90, display: 'block', marginTop: 4 }}
            />
          </label>
          <label className="small dim">
            아래쪽 (mm)
            <input
              type="number"
              min={0}
              max={1}
              step={MM_PER_COUNT}
              value={dz.bottomMm}
              disabled={!dz.enabled}
              onChange={(e) => patchDz({ bottomMm: quantizeMm(Number(e.target.value)) })}
              style={{ width: 90, display: 'block', marginTop: 4 }}
            />
          </label>
        </div>
      </Panel>

      <Panel title="고급 키 (DKS · MT · TGL · RS · SOCD · OKS)">
        <NotDecoded what="고급 키" />
        <div className="small dim" style={{ marginTop: 8 }}>
          순정 드라이버는 프로파일당 40개까지 고급 키를 저장하며, 종류는{' '}
          <span className="mono">t_magnetic_key_data.macro_type</span> 로 구분합니다. DKS는 4단계 깊이별
          동작을 <span className="mono">t_key_item_data.trigger_state1..4</span> 에 담습니다.
        </div>
      </Panel>

    </>
  )
}
