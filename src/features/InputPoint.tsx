import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { calibrationMode, useCalibrationMode } from '../state/calibration'
import { useConnection } from '../state/link'
import { boardSync } from '../state/sync'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { Actuation } from './Actuation'
import { DeadZone } from './DeadZone'
import { CalibrationGuide, CalibrationProgress, useCalibrationRun } from './Calibration'
import { KeyMetrics, type Metric } from './KeyMetrics'
import { PerfOverview } from './PerfOverview'
import { RapidTrigger } from './RapidTrigger'
import { SwitchType } from './SwitchType'

/**
 * Everything that decides *where* in the stroke a key triggers.
 *
 * The switch type says how long the stroke is, actuation sets the trigger depth
 * within that stroke, rapid trigger sets how travel re-triggers, and
 * calibration sets the bottom all of them are measured from. Actuation and
 * rapid trigger were separate tabs, which hid the fact that the switch type
 * rescales both and that recalibrating moves the ground under them.
 *
 * Putting them in one tab made that visible but left nine panels stacked, so
 * they are split into sections. The key grid stays out of those sections and
 * above them: there is one board, so one grid, and switching section no longer
 * redraws the keyboard somewhere else on the page or scrolls away the selection
 * that was just made. What the caps show is decided by the open section, with
 * no separate picker — two ways to choose the same thing could disagree, and a
 * grid labelled with switch types while you edit dead zones is worse than no
 * choice at all.
 *
 * The apply bar sits below the sections rather than inside one. Edits from any
 * section land in the same pending set and go out in the same write, so a bar
 * that appeared only under one section would hide pending changes behind a
 * section the user is not looking at.
 *
 * Calibration is not a section either. It is a mode the board enters — typing
 * stops while it runs — so it takes over the tab instead of sitting inside it:
 * the shared grid switches to showing which keys have been bottomed out, and
 * the sections give way to the procedure. One grid, and no page where a live
 * progress view and a settings view compete for the same keyboard. Its toggle
 * sits in the grid's own control column, next to the selection buttons, since
 * everything there acts on the grid.
 */
const SECTIONS: SubTab[] = [
  {
    id: 'overview',
    labelKey: 'inputPoint.section.overview',
    hintKey: 'inputPoint.section.overviewHint',
    render: () => <PerfOverview />,
  },
  {
    id: 'trigger',
    labelKey: 'inputPoint.section.trigger',
    hintKey: 'inputPoint.section.triggerHint',
    render: () => <Actuation />,
  },
  {
    id: 'rt',
    labelKey: 'inputPoint.section.rt',
    hintKey: 'inputPoint.section.rtHint',
    render: () => <RapidTrigger />,
  },
  {
    id: 'deadzone',
    labelKey: 'inputPoint.section.deadzone',
    hintKey: 'inputPoint.section.deadzoneHint',
    render: () => <DeadZone />,
  },
  {
    id: 'switch',
    labelKey: 'inputPoint.section.switch',
    hintKey: 'inputPoint.section.switchHint',
    render: () => <SwitchType />,
  },
]

/** What the shared grid shows for each section. */
const SECTION_METRIC: Record<string, Metric> = {
  overview: 'actuation',
  trigger: 'actuation',
  rt: 'rt',
  deadzone: 'deadzone',
  switch: 'switch',
}

export function InputPoint() {
  const { connected } = useConnection()
  const t = useT()
  const [active, setActive] = useState(SECTIONS[0]!.id)
  // Shared, not local: App dims and blocks its own chrome while this is on —
  // see state/calibration.ts for why the rest of the window has to go away.
  const calibrating = useCalibrationMode()
  const run = useCalibrationRun()

  // The flag outlives this component, so a disconnect — which swaps the whole
  // app for the connect screen — must not leave the next session blocked.
  useEffect(() => () => calibrationMode.set(false), [])

  // Derived, not state: the section is the only thing that chooses it.
  const metric = SECTION_METRIC[active] ?? 'actuation'

  /*
   * Opening a section reads the board.
   *
   * There is no "read from board" button any more, so this is the refresh: the
   * values a section shows are the ones the board had a moment ago rather than
   * whatever was cached when the tab was first opened. The read is skipped
   * while edits are still on their way out — see boardSync.read.
   */
  useEffect(() => {
    if (!connected || calibrating) return
    void boardSync.read()
  }, [active, connected, calibrating])

  /**
   * One press, one mode. Entering starts the run rather than waiting for a
   * second button: the mode exists to calibrate, and a screen that had switched
   * to a calibration grid but was not calibrating yet read as broken.
   *
   * Leaving stops it. Otherwise the board would stay in the analog test mode
   * with nothing on screen saying so, and the keyboard would not type.
   */
  const leaveOrEnter = async () => {
    if (!calibrating) {
      calibrationMode.set(true)
      // Entering while disconnected is still allowed — the guide explains what
      // the mode is, and its own button covers the retry once a board is there.
      if (connected) await run.start()
      return
    }
    calibrationMode.set(false)
    if (run.running) await run.stop()
  }

  return (
    <>
      <KeyMetrics
        metric={metric}
        calibration={
          calibrating ? { deepest: run.deepest, records: run.records } : undefined
        }
        // Accent in both states, not only on the way out: it is the one control
        // up here that changes what the grid *is* rather than what is picked in
        // it, and that is as true before the mode starts as during it — see the
        // rule that separates it from the other three.
        top={
          <button className="primary" onClick={() => void leaveOrEnter()}>
            {calibrating ? t('calibration.exit') : t('calibration.enter')}
          </button>
        }
        // Under the grid, beside the selection count it replaces during a
        // pass: the panel is where the procedure is explained, this is a
        // readout of what is on screen, so it belongs with what it counts.
        foot={calibrating ? <CalibrationProgress run={run} /> : undefined}
      />

      {calibrating ? (
        <CalibrationGuide run={run} />
      ) : (
        <SubTabs
          tabs={SECTIONS}
          label={t('inputPoint.sections')}
          active={active}
          onActive={setActive}
        />
      )}
    </>
  )
}
