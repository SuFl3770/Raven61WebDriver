import { useT } from '../i18n'
import { useLayout } from '../device/active'
import { travelMmFor } from '../device/tables'
import { FACTORY_DEFAULTS, MM_PER_COUNT, countsToMm, quantizeMm } from '../protocol/encoding'
import { KEY_PERF_LIMITS } from '../protocol/keyPerf'
import type { KeyConfig, RapidTrigger as RT } from '../protocol/types'
import { configStore, useKeyConfigs, useLastRead } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { BottomOutToggle } from '../ui/BottomOutTrigger'
import { Hint } from '../ui/Hint'
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
      Two panels, even halves: the numbers on the left, the switches on the
      right.

      Split by what a control *is* rather than by what it belongs to. All three
      switches read as one list — is it on, does it run above actuation, does
      bottoming out always fire — while the sensitivities are a different kind
      of question and have tracks that want the width. Mixed into one column
      the switches were three separate lines with sliders between them, and the
      global one, which had to sit apart from the per-key pair, ended up in a
      panel of its own saying almost nothing.

      The odd one out is still odd, and says so: `BottomOutToggle` is global and
      writes immediately, which its own label and readout carry.
    */
    <div className="split-two">
      <Panel title={t('rt.title')} hintKey="inputPoint.hint.rt">

        {lastRead === null && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">{t('actuation.unread')}</Notice>
          </div>
        )}


        {/*
          One line each, stacked, so the two tracks share a left edge and a
          length: with press above release, which of the pair is the wider is
          visible without reading either number. The spinners are still there
          for the exact count.
        */}
        {/* 12, not 16: it collapses against the header's own 12 below, so this
            is what puts the first track level with the first switch across the
            split rather than 4px under it. */}
        <div
          className="fields-center"
          style={{ marginTop: 12, opacity: enabledCommon === false ? 0.5 : 1 }}
        >
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

      {/*
        No heading of its own: the three rows say what they are, and a word
        over them — "modes" — only repeated that at a larger size. It carries
        the left panel's heading as a ghost instead, so its first switch starts
        level with the left panel's first track. See `ghostHead`.
      */}
      <Panel title={t('rt.title')} hintKey="inputPoint.hint.rt" ghostHead>
        <div className="switch-rows">
          <label className="row switch-row">
            <span className="switch-label">{t('rt.enable')}</span>
            {/* Before the switch, not after it. The switch has to be the last
                thing in every one of these rows or the one with a note beside it
                sits a word to the left of the others. */}
            {enabledCommon === null && <span className="small dim">({t('actuation.mixed')})</span>}
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
          </label>
          <Hint k="rt.hint.enable" />

          {/* Under the switch it depends on: continuous mode is not a thing you
              can have with rapid trigger off — one wire field holds both, and 2
              cannot be set without 1. See the note at the top. */}
          <div style={{ marginTop: 12, opacity: enabledCommon === false ? 0.5 : 1 }}>
            <label className="row switch-row">
              <span className="switch-label">{t('rt.continuous')}</span>
              <input
                type="checkbox"
                checked={first.continuous}
                disabled={none || enabledCommon === false}
                onChange={(e) => patch({ continuous: e.target.checked })}
              />
            </label>
            <Hint k="rt.hint.continuous" />
        </div>

        <div style={{ marginTop: 12 }}>
          <BottomOutToggle />
        </div>
        </div>
      </Panel>
    </div>
  )
}
