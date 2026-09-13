import { useCallback, useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { MM_PER_COUNT, countsToMm, quantizeMm } from '../protocol/encoding'
import { KEY_PERF_LIMITS } from '../protocol/keyPerf'
import { configStore, useKeyConfigs } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { Dialog, DialogActions } from '../ui/Dialog'
import { Panel } from '../ui/Panel'
import { SliderRow, SliderRows } from '../ui/Slider'
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

  /**
   * Whether the "you are about to turn it off" question is on screen.
   *
   * Asked every time rather than once per run: unlike the switch-type caution
   * this is not a thing to learn, it is a thing to mean. The box is one click
   * from the sliders and the two values it clears are not recoverable from the
   * board once the write lands, so the second click is the whole point.
   */
  const [confirmingOff, setConfirmingOff] = useState(false)

  // Targets are read at event time, not render time — see the note in Actuation.
  const patch = (p: Partial<typeof dz>) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      deadZone: { ...c.deadZone, ...p },
    }))

  // Backing out is the default: Escape and the backdrop both land here, and
  // neither of them is an answer of "yes".
  const keepOn = useCallback(() => setConfirmingOff(false), [])

  const turnOff = () => {
    setConfirmingOff(false)
    patch({ enabled: false })
  }

  return (
    <Panel title={t('deadzone.title')}>
      <label className="row row-center">
        <span>{t('deadzone.enable')}</span>
        <input
          type="checkbox"
          disabled={none}
          checked={dz.enabled}
          // Only the off direction asks. Turning it on costs nothing — the two
          // values are still there and the sliders are one click away — so a
          // dialog in front of it would be a dialog in front of nothing.
          onChange={(e) => (e.target.checked ? patch({ enabled: true }) : setConfirmingOff(true))}
        />
      </label>
      {/* Laid out like the rapid-trigger sensitivities: a track each, stacked,
          because these two are read against each other the same way. The max
          is 5 bits — the old cap of 1 mm was past the field, and 50 counts
          would have gone on the wire as 18, i.e. 0.36 mm, with no complaint. */}
      <div className="fields-center" style={{ marginTop: 12, opacity: dz.enabled ? 1 : 0.5 }}>
        <SliderRows>
          <SliderRow
            held={held}
            label={t('deadzone.top')}
            min={0}
            max={DZ_MAX_MM}
            step={MM_PER_COUNT}
            value={dz.topMm}
            disabled={none || !dz.enabled}
            onValue={(mm) => patch({ topMm: quantizeMm(mm) })}
          />
          <SliderRow
            held={held}
            label={t('deadzone.bottom')}
            min={0}
            max={DZ_MAX_MM}
            step={MM_PER_COUNT}
            value={dz.bottomMm}
            disabled={none || !dz.enabled}
            onValue={(mm) => patch({ bottomMm: quantizeMm(mm) })}
          />
        </SliderRows>
        <div className="small dim" style={{ marginTop: 6 }}>
          <T
            k="deadzone.limit"
            params={{ mm: DZ_MAX_MM.toFixed(2), counts: KEY_PERF_LIMITS.deadZoneMax }}
          />
        </div>
      </div>

      <Dialog
        open={confirmingOff}
        onClose={keepOn}
        title={t('deadzone.offConfirm.title')}
        tone="warn"
      >
        <div className="small">{t('deadzone.offConfirm.body', { count: targets.length })}</div>
        <DialogActions>
          {/* First in the source, so the dialog opens with the keyboard on the
              button that changes nothing — the same order the report-rate
              confirmation uses. */}
          <button onClick={keepOn}>{t('apply.cancel')}</button>
          <button className="primary" onClick={turnOff}>
            {t('deadzone.offConfirm.continue')}
          </button>
        </DialogActions>
      </Dialog>
    </Panel>
  )
}
