import { useT } from '../i18n'
import { useLayout } from '../device/active'
import { travelMmFor } from '../device/tables'
import { FACTORY_DEFAULTS, MM_PER_COUNT, countsToMm, mmToCounts, quantizeMm } from '../protocol/encoding'
import { KEY_PERF_LIMITS } from '../protocol/keyPerf'
import type { KeyConfig, RapidTrigger as RT } from '../protocol/types'
import { configStore, useKeyConfigs, useLastRead } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { BottomOutTrigger } from '../ui/BottomOutTrigger'
import { Notice, Panel } from '../ui/Panel'
import { SliderRow, SliderRows } from '../ui/Slider'
import { useHeldWrites } from '../ui/useHeldWrites'

/**
 * Rapid trigger: `key_mode` plus the two sensitivity fields.
 *
 * Three controls map onto one wire field. `key_mode` is 0 off, 1 rapid trigger,
 * 2 rapid trigger with full-stroke quick trigger — the stock driver folds its
 * two toggles into that single value at 0x43aa13, where the rapid-trigger
 * toggle sets 1 and the full-stroke toggle overrides it with 2. So "continuous"
 * is not a separate bit and cannot be set with rapid trigger off.
 *
 * The board always stores two sensitivities, so this edits two. The stock
 * driver has a "separate" checkbox and, with it off, feeds one control's value
 * to both fields (0x43a9e7); this app had the same checkbox, inferred from the
 * two values being equal. It is gone. The checkbox could only ever destroy
 * information — the field it hid was a real field on the wire, and unticking it
 * silently overwrote one value with the other — and inferring its state from
 * the data meant a board with the two set equally came back with the release
 * control missing.
 */

/** The board's factory default sensitivity: 5 counts, 0.10 mm. */
const FACTORY_RT_MM = countsToMm(FACTORY_DEFAULTS.rapidTriggerPress)

/** Smallest and largest the 9-bit field can hold, in mm. */
const RT_MIN_MM = countsToMm(KEY_PERF_LIMITS.rtMin)
/** The 5-bit dead-zone field: 31 counts, 0.62 mm. Past this a write would wrap. */

function travelOf(config: KeyConfig | undefined): number {
  return travelMmFor(config?.switchType)
}

/** One value if every target agrees, null if they do not. */
function common<T>(
  configs: readonly KeyConfig[],
  targets: readonly number[],
  pick: (c: KeyConfig) => T,
): T | null {
  const first = configs[targets[0] ?? 0]
  if (!first) return null
  const value = pick(first)
  return targets.every((i) => {
    const c = configs[i]
    return c !== undefined && pick(c) === value
  })
    ? value
    : null
}

export function RapidTrigger() {
  const { keys } = useLayout()
  const configs = useKeyConfigs()
  const lastRead = useLastRead()
  const sel = useSelection()
  const t = useT()
  // The slider and the spinners move while held; see useHeldWrites.
  const held = useHeldWrites()

  const targets = targetKeys(sel)
  const lead = configs[targets[0] ?? 0]!
  const first = lead.rapidTrigger
  /** Nothing selected: the controls stay put but do nothing — see Actuation. */
  const none = targets.length === 0
  // The deepest sensitivity every target can express — bounded by the
  // shallowest switch among them, not by a nominal 4 mm. With no targets
  // `Math.min` would be Infinity, which is not a number an input can take.
  const limit = none
    ? travelMmFor(undefined)
    : Math.min(...targets.map((i) => travelOf(configs[i])))

  const enabledCommon = common(configs, targets, (c) => c.rapidTrigger.enabled)

  // Read the selection at event time — see the note in Actuation.
  const patch = (p: Partial<RT>) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      rapidTrigger: { ...c.rapidTrigger, ...p },
    }))

  /**
   * Enabling has to seed a sensitivity.
   *
   * A key the board marked `ff ff ff ff` — never set — decodes to zero, and
   * zero encodes to the smallest value the field holds: 1 count, 0.02 mm. That
   * is a hair trigger built out of sensor noise, and nobody asked for it. Seed
   * the board's own factory default instead, per key, since the targets can be
   * in different states.
   */
  const setEnabled = (enabled: boolean) =>
    configStore.update(targetKeys(selection.current()), (c) => {
      const rt = c.rapidTrigger
      if (!enabled) return { ...c, rapidTrigger: { ...rt, enabled: false } }
      const pressMm = rt.pressMm >= RT_MIN_MM ? rt.pressMm : FACTORY_RT_MM
      const releaseMm = rt.releaseMm >= RT_MIN_MM ? rt.releaseMm : pressMm
      return {
        ...c,
        rapidTrigger: { ...rt, enabled: true, pressMm, releaseMm },
        // The values are no longer "never set", so a later write must not put
        // the marker back over them.
        rtUnset: false,
      }
    })

  const setSensitivity = (mm: number) => patch({ pressMm: quantizeMm(mm) })

  /**
   * Keys whose rapid trigger can never fire.
   *
   * With continuous off, rapid trigger works between the actuation point and
   * the bottom — so a sensitivity wider than what is left of the stroke below
   * actuation leaves no room to re-trigger in. A warning rather than a clamp:
   * this is read off the stock UI's own description, not off the firmware.
   */
  const noRoom = keys.filter((k) => {
    const c = configs[k.index]
    if (!c || !c.rapidTrigger.enabled || c.rapidTrigger.continuous) return false
    return c.rapidTrigger.pressMm > travelOf(c) - c.actuationMm
  })

  const belowFactory = keys.filter((k) => {
    const c = configs[k.index]
    return (
      c !== undefined &&
      c.rapidTrigger.enabled &&
      Math.min(c.rapidTrigger.pressMm, c.rapidTrigger.releaseMm) < FACTORY_RT_MM
    )
  })

  return (
    /*
      The global switch sits beside this panel rather than under it. It is the
      one rapid-trigger setting that is not per key and does not wait for the
      apply bar — one checkbox in a panel of its own, which as a full-width
      band below read as another step in the same sequence. Off to the side it
      is plainly a separate thing about the same subject, and the column it
      leaves frees the space the sliders now take.
    */
    <div className="rt-split">
      <Panel title={t('rt.title')}>

        {lastRead === null && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">{t('actuation.unread')}</Notice>
          </div>
        )}


        <label className="row" style={{ marginTop: 16 }}>
          <span>{t('rt.enable')}</span>
          <input
            type="checkbox"
            disabled={none}
            checked={enabledCommon === true}
            // Targets that disagree get the third state, so the checkbox does
            // not claim they are all off.
            ref={(el) => {
              if (el) el.indeterminate = enabledCommon === null
            }}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {enabledCommon === null && <span className="small dim">({t('actuation.mixed')})</span>}
        </label>

        {/*
          One line each, stacked, so the two tracks share a left edge and a
          length: with press above release, which of the pair is the wider is
          visible without reading either number. The spinners are still there
          for the exact count.
        */}
        <div style={{ marginTop: 12, opacity: enabledCommon === false ? 0.5 : 1 }}>
          <SliderRows>
            <SliderRow
              held={held}
              label={t('rt.pressSensitivity')}
              min={RT_MIN_MM}
              max={limit}
              step={MM_PER_COUNT}
              value={first.pressMm}
              disabled={none || enabledCommon === false}
              onValue={setSensitivity}
            />
            <SliderRow
              held={held}
              label={t('rt.releaseSensitivity')}
              min={RT_MIN_MM}
              max={limit}
              step={MM_PER_COUNT}
              value={first.releaseMm}
              disabled={none || enabledCommon === false}
              onValue={(mm) => patch({ releaseMm: quantizeMm(mm) })}
            />
          </SliderRows>
          <div className="small dim" style={{ marginTop: 6 }}>
            {t('rt.counts', {
              press: mmToCounts(first.pressMm),
              release: mmToCounts(first.releaseMm),
              max: KEY_PERF_LIMITS.rtMax,
            })}
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, opacity: enabledCommon === false ? 0.5 : 1 }}>
          <label className="small">
            {t('rt.continuous')}{' '}
            <input
              type="checkbox"
              checked={first.continuous}
              disabled={none || enabledCommon === false}
              onChange={(e) => patch({ continuous: e.target.checked })}
            />
          </label>
        </div>

        {belowFactory.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              {t('rt.belowFactory', {
                count: belowFactory.length,
                mm: FACTORY_RT_MM.toFixed(2),
              })}
              <div className="small dim" style={{ marginTop: 4 }}>
                {belowFactory.map((k) => k.label).join(', ')}
              </div>
            </Notice>
          </div>
        )}

        {noRoom.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">
              {t('rt.noRoom', { count: noRoom.length })}
              <div className="small dim" style={{ marginTop: 4 }}>
                {noRoom
                  .map(
                    (k) =>
                      `${k.label} (${configs[k.index]!.rapidTrigger.pressMm.toFixed(2)} > ${(
                        travelOf(configs[k.index]) - configs[k.index]!.actuationMm
                      ).toFixed(2)})`,
                  )
                  .join(', ')}
              </div>
            </Notice>
          </div>
        )}
      </Panel>

      <BottomOutTrigger />
    </div>
  )
}
