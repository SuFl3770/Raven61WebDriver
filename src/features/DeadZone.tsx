import { useT } from '../i18n'
import { T } from '../i18n/T'
import { MM_PER_COUNT, countsToMm, quantizeMm } from '../protocol/encoding'
import { KEY_PERF_LIMITS } from '../protocol/keyPerf'
import { configStore, useKeyConfigs } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { Panel } from '../ui/Panel'
import { useHeldWrites } from '../ui/useHeldWrites'

/**
 * Dead zones: travel at the top and bottom of the stroke the board ignores.
 *
 * Its own section rather than a panel under rapid trigger. The two share a
 * wire byte — `deadzone_state` has no bit of its own and is derived from these
 * fields being non-zero (see keyPerf) — but that is an encoding detail, not a
 * reason for a user to look for them together.
 */

/** 5 bits on the wire, so 31 counts. */
const DZ_MAX_MM = countsToMm(KEY_PERF_LIMITS.deadZoneMax)

export function DeadZone() {
  const configs = useKeyConfigs()
  const sel = useSelection()
  const t = useT()
  // The slider and the spinners move while held; see useHeldWrites.
  const held = useHeldWrites()

  const targets = targetKeys(sel)
  /** Nothing selected: the controls stay put but do nothing — see Actuation. */
  const none = targets.length === 0
  const dz = configs[targets[0] ?? 0]!.deadZone

  // Targets are read at event time, not render time — see the note in Actuation.
  const patch = (p: Partial<typeof dz>) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      deadZone: { ...c.deadZone, ...p },
    }))

  return (
    <Panel title={t('deadzone.title')}>
      <div className="small dim" style={{ marginBottom: 10 }}>
        {t('deadzone.hint')}
      </div>
      <label className="row">
        <input
          type="checkbox"
          disabled={none}
          checked={dz.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span>{t('deadzone.enable')}</span>
      </label>
      <div className="row" style={{ marginTop: 12, opacity: dz.enabled ? 1 : 0.5 }}>
        <label className="small dim">
          {t('deadzone.top')}
          <input
            type="number"
            {...held}
            min={0}
            // 5 bits. The old cap of 1 mm was past the field: 50 counts would
            // have gone on the wire as 18, i.e. 0.36 mm, with no complaint.
            max={DZ_MAX_MM}
            step={MM_PER_COUNT}
            value={dz.topMm}
            disabled={none || !dz.enabled}
            onChange={(e) => patch({ topMm: quantizeMm(Number(e.target.value)) })}
            style={{ width: 90, display: 'block', marginTop: 4 }}
          />
        </label>
        <label className="small dim">
          {t('deadzone.bottom')}
          <input
            type="number"
            {...held}
            min={0}
            max={DZ_MAX_MM}
            step={MM_PER_COUNT}
            value={dz.bottomMm}
            disabled={none || !dz.enabled}
            onChange={(e) => patch({ bottomMm: quantizeMm(Number(e.target.value)) })}
            style={{ width: 90, display: 'block', marginTop: 4 }}
          />
        </label>
        <span className="small dim" style={{ alignSelf: 'end' }}>
          <T
            k="deadzone.limit"
            params={{ mm: DZ_MAX_MM.toFixed(2), counts: KEY_PERF_LIMITS.deadZoneMax }}
          />
        </span>
      </div>
    </Panel>
  )
}
