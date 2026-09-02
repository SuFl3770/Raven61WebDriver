import { DEFAULT_TRAVEL_MM } from '../keyboard/raven61'
import { MM_PER_COUNT, mmToCounts, quantizeMm } from '../protocol/encoding'
import { configStore, useKeyConfigs } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { Panel } from '../ui/Panel'
import { SelectionBar } from '../ui/SelectionBar'

/** 1.5mm is the board's factory default (global_key_actuation = 75). */
const PRESETS = [
  { label: '빠름 0.5mm', value: 0.5 },
  { label: '기본 1.5mm', value: 1.5 },
  { label: '깊음 2.5mm', value: 2.5 },
]

export function Actuation() {
  const configs = useKeyConfigs()
  const sel = useSelection()
  const first = configs[targetKeys(sel)[0] ?? 0]!

  // Targets are read at event time, not render time: a click and the slider
  // move that follows must not disagree about what is selected.
  const setActuation = (mm: number) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      // The board stores whole 0.02 mm counts; snap so the UI cannot show a
      // value the hardware would silently round.
      actuationMm: quantizeMm(mm),
    }))

  return (
    <>
      <Panel title="액추에이션 포인트">
        <SelectionBar />
        <KeyGrid
          selected={sel}
          onSelect={(i, additive) => selection.toggle(i, additive)}
          sub={(k) => `${configs[k.index]!.actuationMm.toFixed(2)}`}
          fill={(k) => configs[k.index]!.actuationMm / DEFAULT_TRAVEL_MM}
        />

        <div className="row" style={{ marginTop: 16 }}>
          <input
            type="range"
            min={MM_PER_COUNT}
            max={DEFAULT_TRAVEL_MM}
            step={MM_PER_COUNT}
            value={first.actuationMm}
            onChange={(e) => setActuation(Number(e.target.value))}
            style={{ flex: '1 1 260px' }}
          />
          <input
            type="number"
            min={MM_PER_COUNT}
            max={DEFAULT_TRAVEL_MM}
            step={MM_PER_COUNT}
            value={first.actuationMm}
            onChange={(e) => setActuation(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <span className="dim small">
            mm = {mmToCounts(first.actuationMm)} counts (0.02mm 단위) · 총 스트로크 {DEFAULT_TRAVEL_MM}mm 기준
          </span>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          {PRESETS.map((p) => (
            <button key={p.value} onClick={() => setActuation(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
      </Panel>

    </>
  )
}
