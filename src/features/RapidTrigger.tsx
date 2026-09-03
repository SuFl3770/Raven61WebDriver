import { useT } from '../i18n'
import { T } from '../i18n/T'
import { MM_PER_COUNT, quantizeMm } from '../protocol/encoding'
import { configStore, useKeyConfigs } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { NotDecoded, Notice, Panel } from '../ui/Panel'
import { SelectionBar } from '../ui/SelectionBar'

export function RapidTrigger() {
  const configs = useKeyConfigs()
  const sel = useSelection()
  const t = useT()
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
      <Panel title={t('rt.title')}>
        <SelectionBar />
        <KeyGrid
          selected={sel}
          onSelect={(i, additive) => selection.toggle(i, additive)}
          sub={(k) => (configs[k.index]!.rapidTrigger.enabled ? 'RT' : undefined)}
        />

        <label className="row" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={first.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>{t('rt.enable')}</span>
        </label>

        <div className="row" style={{ marginTop: 12, opacity: first.enabled ? 1 : 0.5 }}>
          <label className="small dim">
            {first.separate ? t('rt.pressSensitivity') : t('rt.sensitivity')}
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
              {t('rt.releaseSensitivity')}
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
            {t('rt.separate')}
          </label>
          <label className="small" style={{ alignSelf: 'end' }}>
            <input
              type="checkbox"
              checked={first.continuous}
              disabled={!first.enabled}
              onChange={(e) => patch({ continuous: e.target.checked })}
            />{' '}
            {t('rt.continuous')}
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <Notice>
            <span className="small">
              <T k="rt.noise" params={{ step: MM_PER_COUNT }} />
            </span>
          </Notice>
        </div>
      </Panel>

      <Panel title={t('deadzone.title')}>
        <div className="small dim" style={{ marginBottom: 10 }}>
          {t('deadzone.hint')}
        </div>
        <label className="row">
          <input type="checkbox" checked={dz.enabled} onChange={(e) => patchDz({ enabled: e.target.checked })} />
          <span>{t('deadzone.enable')}</span>
        </label>
        <div className="row" style={{ marginTop: 12, opacity: dz.enabled ? 1 : 0.5 }}>
          <label className="small dim">
            {t('deadzone.top')}
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
            {t('deadzone.bottom')}
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

      <Panel title={t('advanced.title')}>
        <NotDecoded what="advanced.what" />
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="advanced.note" />
        </div>
      </Panel>

    </>
  )
}
