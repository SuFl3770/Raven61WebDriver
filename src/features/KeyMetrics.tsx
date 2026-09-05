import type { ReactNode } from 'react'
import type { MessageKey } from '../i18n'
import { DEFAULT_TRAVEL_MM } from '../keyboard/raven61'
import { switchTypeInfo, type KeyConfig } from '../protocol/types'
import { CAL_STATE, type CalRecord } from '../protocol/calibration'
import { useKeyConfigs } from '../state/config'
import { selection, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { Marquee } from '../ui/Marquee'
import { SelectionBar } from '../ui/SelectionBar'

/**
 * The one key grid the input-point tab uses, and the metrics it can show.
 *
 * Every section used to draw its own grid with its own values, so switching
 * section redrew the keyboard in a different place on the page and the
 * selection you had just made scrolled away. There is one board, so there is
 * one grid: it sits above the section strip, and the metric it shows follows
 * whichever section is open.
 *
 * There is no metric picker any more. It was a second way to choose the same
 * thing the section strip already chooses, and the two could disagree — you
 * could be editing dead zones while the caps showed switch types. The section
 * decides, so METRICS is now only the list the `Metric` type comes from.
 */
export const METRICS = [
  { id: 'actuation', labelKey: 'perf.metric.actuation' },
  { id: 'rt', labelKey: 'perf.metric.rt' },
  { id: 'deadzone', labelKey: 'perf.metric.deadzone' },
  { id: 'switch', labelKey: 'perf.metric.switch' },
] as const satisfies readonly { id: string; labelKey: MessageKey }[]

export type Metric = (typeof METRICS)[number]['id']

/**
 * The board's own LED, as a cap border.
 *
 * This mirrors the firmware's state byte rather than this project's grade of
 * the calibration scale, so the grid and the keyboard on the desk always agree:
 * `--err` where the board lights the key red, `--warn` where it lights amber.
 *
 * Green is the one addition. The board has no green — a calibrated key is one
 * the overlay stops painting, and the lighting effect shows through instead
 * (see protocol/calibration.ts). "Nothing drawn" reads the same as "no record
 * yet" on a grid, and during a pass those are the two states that most need
 * telling apart, so a finished key gets a border of its own.
 *
 * ⚠ This is the board's opinion, and the board is not a good judge of its own
 * calibration — a fresh firmware lights every key red however good it is, and
 * two shallow presses turn one green. The honest number is on the cap: the
 * scale, which the legend explains. Debug mode adds the list of keys where the
 * two disagree.
 */
function capStatus(record: CalRecord | undefined): 'done' | 'marginal' | 'bad' | undefined {
  if (!record) return undefined
  if (record.state === CAL_STATE.fresh) return 'bad'
  if (record.state === CAL_STATE.learning) return 'marginal'
  return 'done'
}

/** Full travel depends on the switch fitted — see SWITCH_TYPES. */
function travelOf(config: KeyConfig | undefined): number {
  return switchTypeInfo(config?.switchType)?.travelMm ?? DEFAULT_TRAVEL_MM
}

/**
 * Cap label for a metric. Undefined leaves the cap showing its key name only.
 *
 * The label is all a setting gets. There used to be a blue fill scaled to the
 * value as well, which turned a keyboard of settings into a bar chart nobody
 * was reading — and for a switch type or a rapid-trigger toggle it was encoding
 * a category as a quantity. The fill is now kept for the two places it means
 * something physical: how far a key has actually travelled (sensors) and how
 * far it has been pressed this calibration pass.
 */
export function metricSub(metric: Metric, c: KeyConfig | undefined): ReactNode {
  if (!c) return undefined
  if (metric === 'actuation') return c.actuationMm.toFixed(2)
  /*
   * Both halves, side by side, in the two colours the panel's own inputs are
   * labelled with. It used to be the press value alone — or the word FULL,
   * which said the mode but hid both numbers — and a key whose release
   * sensitivity differed from its press looked identical to one where they
   * matched. Whether the mode is continuous is still on the panel below; on a
   * cap, the two numbers are what the grid is for.
   */
  if (metric === 'rt') {
    if (!c.rapidTrigger.enabled) return undefined
    return (
      <>
        <span className="press">{c.rapidTrigger.pressMm.toFixed(2)}</span>{' '}
        <span className="release">{c.rapidTrigger.releaseMm.toFixed(2)}</span>
      </>
    )
  }
  if (metric === 'deadzone') {
    if (!c.deadZone.enabled) return undefined
    return `${c.deadZone.topMm.toFixed(2)} ${c.deadZone.bottomMm.toFixed(2)}`
  }
  return c.switchType === undefined ? undefined : `S${c.switchType}`
}

/** Which metrics put two numbers on a cap, and so need the tighter type. */
function isPair(metric: Metric): boolean {
  return metric === 'rt' || metric === 'deadzone'
}

export function KeyMetrics({
  metric,
  calibration,
  side,
}: {
  metric: Metric
  /**
   * A calibration pass in progress. When given, the grid shows the pass instead
   * of a setting; the calibration panel below says what it is showing.
   *
   * The cap label is the key's calibration scale, not the depth in millimetres.
   * Depth is the board's reading of the sensor *through* the very number being
   * relearned, so during a pass it is the least trustworthy figure on screen;
   * the scale is the thing that is actually changing, and watching it climb as
   * a key is pressed is the feedback the pass needs. The fill still uses depth,
   * because "how far down is this key" is what a progress bar should mean.
   */
  calibration?: {
    /** Deepest press this pass, in mm, for the cap fill. */
    deepest: Float32Array
    /**
     * The board's own record per key. Both halves are on screen: the state
     * byte becomes the cap border, the scale becomes the cap label.
     */
    records: readonly (CalRecord | undefined)[]
  }
  /** Controls for the column beside the grid — see SelectionBar. */
  side?: ReactNode
}) {
  const configs = useKeyConfigs()
  const sel = useSelection()

  // A calibration pass owns the grid: the caps mirror the board's own LEDs and
  // there is nothing to edit, so the selection goes away rather than sitting
  // there colouring caps for a panel that is not on screen. It is only hidden —
  // the store keeps it, and leaving the mode brings it back.
  const picking = calibration === undefined

  return (
    <Marquee className="gridband" disabled={!picking}>
      <div className="gridrow">
        <KeyGrid
          selected={picking ? sel : undefined}
          onToggle={picking ? (i, on) => selection.setSelected(i, on) : undefined}
          subClass={calibration ? undefined : isPair(metric) ? 'pair' : undefined}
          sub={(k) => {
            if (calibration) {
              const rec = calibration.records[k.index]
              return rec ? rec.scale.toFixed(2) : undefined
            }
            return metricSub(metric, configs[k.index])
          }}
          status={calibration ? (k) => capStatus(calibration.records[k.index]) : undefined}
          // Only calibration fills the caps here — see metricSub.
          fill={
            calibration
              ? (k) => (calibration.deepest[k.index] ?? 0) / travelOf(configs[k.index])
              : undefined
          }
        />

        {/*
          Just the caller's controls. The calibration legend used to sit here as
          well, which put a paragraph of caveats in a control column — it lives
          in the calibration panel now, where there is room to say what the cap
          border and the cap number are.
        */}
        <SelectionBar selectable={picking}>{side}</SelectionBar>
      </div>
    </Marquee>
  )
}
