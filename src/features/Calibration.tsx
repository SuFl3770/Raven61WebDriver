import { useEffect, useRef, useState } from 'react'
import { t as translate, useT } from '../i18n'
import { T } from '../i18n/T'
import { activeLayout, useLayout } from '../device/active'
import {
  CAL,
  CAL_LED,
  CAL_STATE,
  gradeRecord,
  isBottomedOut,
  ledColor,
  scaleHeadroom,
  type CalHealth,
  type CalRecord,
} from '../protocol/calibration'
import { parseActiveEvent } from '../protocol/events'
import { sensorMap } from '../state/sensorMap'
import { useSettings } from '../state/settings'
import { armActiveStream, currentCodec, link, useConnection } from '../state/link'
import { Notice, Panel } from '../ui/Panel'

/**
 * Bottom-out calibration: the board relearns where each key's travel ends.
 *
 * There is no command for it. Calibration *is* holding the analog test mode
 * open — 0xa8 repeated on MONITOR.rearmMs — and pressing each key to the
 * bottom while it is held. See docs/protocol.md §3.2.
 *
 * The run is a hook rather than a self-contained panel because its progress
 * belongs on the tab's shared key grid, which lives above the sections. A panel
 * that drew its own grid put a second keyboard on a page that already had one.
 *
 * ## Two answers on screen at once, on purpose
 *
 * The firmware lights a key red or amber while it considers it uncalibrated,
 * and the stock driver mirrors those colours. Both are reading one byte —
 * `state` in the calibration record — and that byte is a counter of how many
 * times the learned scale has grown, not a measure of anything. It ships at 0,
 * so a board fresh from a firmware update lights every key red however well
 * calibrated it is; it latches after two growth events, so two half-presses can
 * turn a key "green" without it ever having bottomed out; and the boot check
 * forces it to "calibrated" for exactly the records it has decided to throw
 * away. protocol/calibration.ts has the full state machine and the addresses.
 *
 * The grid shows that byte anyway, as a red / amber / green border. Someone
 * running a pass is looking at the keyboard as much as at the screen, and a
 * grid that contradicted the LEDs in front of them would be read as a bug in
 * this app rather than as a fault in the board.
 *
 * The honest answer sits on the same cap as a number: the scale, which is what
 * the pass actually changes and what every reported depth is computed through.
 * `gradeRecord` grades on that, and the grade drives the text dump — and, in
 * debug mode, `LedComparison`, which lists the keys the two answers disagree
 * about. That list is the evidence; the border is the thing that has to match
 * the desk.
 */

/** Keys that have reached the depth the firmware counts as bottomed out. */
export function countBottomedOut(deepestRaw: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < deepestRaw.length; i++) {
    if (isBottomedOut(deepestRaw[i] ?? 0)) n++
  }
  return n
}

/**
 * The pass as text, one line per key.
 *
 * Here for the same reason the performance panel has a byte dump: this is the
 * evidence for the grade, and it is what a bug report about a key the board and
 * this screen disagree about should carry.
 */
export function calibrationDump(run: {
  deepestRaw: Uint16Array
  deepest: Float32Array
  bottomAdc: Int32Array
  records: readonly (CalRecord | undefined)[]
  health: readonly CalHealth[]
}): string {
  const lines = [
    `# calibration pass — bottom-out at travelRaw ${CAL.bottomOutRaw}/${CAL.travelRawFull}`,
    `# scale floor ${CAL.scaleFloor}, ceiling ${CAL.scaleCeiling};` +
      ` firmware calls a key calibrated above ${CAL.scaleCalibrated}`,
    '# key         idx  deepRaw  deepest  bottomAdc   scale  fwState  health',
  ]
  for (const key of activeLayout().keys) {
    const i = key.index
    const rec = run.records[i]
    lines.push(
      `${key.label.padEnd(12)}${String(i).padStart(3)}  ` +
        `${String(run.deepestRaw[i] ?? 0).padStart(7)}  ` +
        `${(run.deepest[i] ?? 0).toFixed(2).padStart(7)}  ` +
        `${String(run.bottomAdc[i] ?? 0).padStart(9)}  ` +
        `${(rec ? rec.scale.toFixed(2) : '—').padStart(6)}  ` +
        `${(rec ? `0x${rec.state.toString(16).padStart(2, '0')}` : '—').padStart(7)}  ` +
        `${run.health[i] ?? '-'}`,
    )
  }
  return lines.join('\n')
}

const RENDER_MS = 120

/** Whether the board's stored table could be read at the start of the pass. */
export type TableRead = 'idle' | 'loading' | 'ok' | 'failed'

export interface CalibrationRun {
  running: boolean
  error: string | null
  /**
   * Deepest linearised travel seen per key this pass, 0 … 800.
   *
   * The firmware's own unit, and the one its bottom-out test uses. Millimetres
   * cannot do this job: depth in mm is the linearised travel bent through the
   * switch's stroke curve, so a fixed mm threshold means a different fraction
   * of the stroke on every switch type — which is why the previous threshold
   * here had to be lowered to 3.00 mm to be reachable at all, and then could
   * not tell a bottomed-out short switch from a hard press on a long one.
   */
  deepestRaw: Uint16Array
  /** The same press in mm, for the grid fill and for reading. */
  deepest: Float32Array
  /**
   * Raw sensor reading at that deepest press, per key. 0 for a key not yet
   * seen. The measurement itself, rather than the board's interpretation of it.
   */
  bottomAdc: Int32Array
  /**
   * Per-key calibration record: read off the board when the pass starts, then
   * kept current from the event stream, which carries both fields in every
   * event.
   */
  records: (CalRecord | undefined)[]
  /** Per-key verdict, in this project's key order. */
  health: CalHealth[]
  tableRead: TableRead
  /** Why the table read failed, when it did. */
  tableFailure: string | null
  /** Keys that have reached the bottom. */
  done: number
  start(): Promise<void>
  stop(): Promise<void>
}

export function useCalibrationRun(): CalibrationRun {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tableRead, setTableRead] = useState<TableRead>('idle')
  const [tableFailure, setTableFailure] = useState<string | null>(null)
  const [, forceRender] = useState(0)

  // Sized for the board that is attached. A different keyboard has a different
  // key count, so `start` resizes before a pass rather than silently dropping
  // writes past the end of a typed array.
  const keyCount = useLayout().count
  const deepestRaw = useRef<Uint16Array>(new Uint16Array(keyCount))
  const deepest = useRef<Float32Array>(new Float32Array(keyCount))
  const bottomAdc = useRef<Int32Array>(new Int32Array(keyCount))
  const records = useRef<(CalRecord | undefined)[]>(new Array(keyCount).fill(undefined))
  const release = useRef<(() => Promise<void>) | null>(null)
  const offInput = useRef<(() => void) | null>(null)

  const stop = async () => {
    const fn = release.current
    release.current = null
    offInput.current?.()
    offInput.current = null
    setRunning(false)
    await fn?.()
  }

  /**
   * The board's stored table, mapped from sensor slots into key indices.
   *
   * Worth doing even though the stream carries the same two fields: the stream
   * only reports a key once it moves, so without this a key nobody has touched
   * yet is blank rather than "never calibrated" — and "never calibrated" is
   * precisely the state a pass exists to find.
   */
  const loadTable = async () => {
    setTableRead('loading')
    setTableFailure(null)
    try {
      // Sequential, not Promise.all. Both of these are multi-packet reads, and
      // running them together is what broke this: the 0xaa request and the
      // keymap's 0x01 were written in the same millisecond, the board — which
      // has one packet buffer — answered only the second, and the calibration
      // read timed out beside fourteen keymap chunks that all went through.
      // The link queue now serialises them anyway; ordering them here is what
      // makes that obvious to the next reader.
      const codec = currentCodec()
      if (!codec.readCalibration || !codec.readSlotMap) {
        // Not an error worth a banner: the pass still works off the stream, it
        // just starts with nothing to say about keys nobody has pressed.
        setTableRead('failed')
        setTableFailure(translate('calibration.tableUnsupported'))
        return
      }
      const table = await codec.readCalibration(link)
      const { map } = await codec.readSlotMap(link)
      for (const [slot, key] of map.keyBySlot) {
        const rec = table[slot]
        if (rec) records.current[key.index] = rec
      }
      setTableRead('ok')
    } catch (e) {
      // Not fatal, and not worth an error banner: the pass still works off the
      // stream, it just starts with nothing to say about untouched keys. The
      // reason is kept though — it was thrown away here once, and finding out
      // why the read failed then needed a wire capture.
      setTableFailure(e instanceof Error ? e.message : String(e))
      setTableRead('failed')
    }
  }

  const start = async () => {
    setError(null)
    // Cleared in place rather than reallocated. Replacing the arrays leaves
    // anything that captured them before this point holding a set that stays at
    // zero for ever — which is exactly what happened while chasing the grading
    // bug, and cost an hour of looking at the wrong layer.
    // Reallocating here rather than in place *only* when the board changed:
    // the arrays are handed out on every render, and replacing them mid-pass is
    // what the fill() below avoids.
    if (deepestRaw.current.length !== keyCount) {
      deepestRaw.current = new Uint16Array(keyCount)
      deepest.current = new Float32Array(keyCount)
      bottomAdc.current = new Int32Array(keyCount)
      records.current = new Array(keyCount).fill(undefined)
    }
    deepestRaw.current.fill(0)
    deepest.current.fill(0)
    bottomAdc.current.fill(0)
    records.current.fill(undefined)
    offInput.current = link.onInput((_reportId, data) => {
      const e = parseActiveEvent(data)
      if (!e || !e.identifiable) return
      const index = sensorMap.resolve(e)
      if (index === undefined) return
      // The ADC is recorded at the new deepest point rather than as a running
      // minimum: tying it to the travel already being tracked keeps the two
      // numbers describing the same press, so a stray low reading cannot leave
      // an ADC that belongs to no observed depth.
      if (e.travelRaw > (deepestRaw.current[index] ?? 0)) {
        deepestRaw.current[index] = e.travelRaw
        deepest.current[index] = e.depthMm
        bottomAdc.current[index] = e.adc
      }
      // Every event carries the current record, so the live values replace
      // whatever the table read put here — including mid-pass, which is what
      // makes a key visibly improve as it is pressed.
      records.current[index] = { scale: e.calScale, state: e.calState, valid: true }
    })
    try {
      release.current = await armActiveStream({ keepAlive: true })
      setRunning(true)
      // After the mode opens, not before: 0xa8 makes the board sweep every slot
      // three times, and a block read racing that sweep spends its timeouts
      // rejecting events. Failure here is swallowed by loadTable.
      await loadTable()
    } catch (e) {
      offInput.current?.()
      offInput.current = null
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => forceRender((n) => n + 1), RENDER_MS)
    return () => clearInterval(timer)
  }, [running])

  // Leaving the tab while the mode is held would strand a keyboard that cannot
  // type, so the release runs on unmount whatever the reason.
  useEffect(
    () => () => {
      void release.current?.()
      release.current = null
      offInput.current?.()
    },
    [],
  )

  return {
    running,
    error,
    deepestRaw: deepestRaw.current,
    deepest: deepest.current,
    bottomAdc: bottomAdc.current,
    records: records.current,
    health: records.current.map(gradeRecord),
    tableRead,
    tableFailure,
    done: countBottomedOut(deepestRaw.current),
    start,
    stop,
  }
}

/**
 * How far the pass has got, for the column beside the grid.
 *
 * It sits under the button that leaves the mode rather than in the panel, next
 * to the grid it is counting. The panel is where the procedure is explained;
 * this is a readout of the thing on screen, and it belongs with it.
 */
export function CalibrationProgress({ run }: { run: CalibrationRun }) {
  const total = useLayout().count
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <T k="calibration.progress" params={{ done: run.done, total: total }} />
    </div>
  )
}

/**
 * What replaces the sections while calibration mode is on: the control that
 * ends the mode, what the grid is showing, and the procedure itself.
 *
 * The procedure is a locale string, not markup — `calibration.guide` in
 * `src/i18n/locales/*.json`. It is the part that gets rewritten as the
 * procedure settles, and rewording it should not need a code change. It ships
 * blank; whatever is put there renders here.
 */
export function CalibrationGuide({ run }: { run: CalibrationRun }) {
  const { connected } = useConnection()
  const { debug } = useSettings()
  const t = useT()
  const lit = run.records.filter((r) => r && ledColor(r.state) !== undefined).length

  return (
    <Panel title={t('calibration.title')}>
      {run.error && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="err">{run.error}</Notice>
        </div>
      )}

      {run.tableRead === 'failed' && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="warn">
            <span className="small">
              <T k="calibration.tableFailed" />
              {/*
                The reason, verbatim. It used to be swallowed, and answering
                "why did this fail" then took a wire capture — the answer being
                that nothing was wrong with the board at all.
              */}
              {run.tableFailure && <div className="dim mono">{run.tableFailure}</div>}
            </span>
          </Notice>
        </div>
      )}

      {/*
        Two controls, and between them they are the panel's whole button row —
        so the row itself goes when neither is showing, rather than leaving a
        gap where they were.
      */}
      {(debug || !run.running) && (
        <div className="row">
          {/*
            The mode starts the run on entry, so this is not the way in. It is
            "stop" while running, and "start again" after — a second pass wants
            a cleared progress grid, which is what start() gives.

            Stopping is the half that is only offered with debug mode on:
            interrupting a pass leaves the board half-relearned, with no sign of
            it afterwards except keys that read differently from their
            neighbours. The way out of the mode for everyone else is the button
            in the title row, which ends the run cleanly. "Start again" is not
            gated — it is offered once a pass is over, and running one is the
            entire point of the tab.
          */}
          <button
            className={run.running ? 'danger' : 'primary'}
            onClick={() => void (run.running ? run.stop() : run.start())}
            disabled={!connected}
          >
            {run.running ? t('calibration.stop') : t('calibration.restart')}
          </button>
          {/*
            The dump is every record the pass collected, as text for a bug
            report. Nothing on this screen is read back from it and nothing in
            the app consumes it — it exists to be pasted somewhere else, which
            is the definition of the tools half of this app.
          */}
          {debug && (
            <button onClick={() => void navigator.clipboard?.writeText(calibrationDump(run))}>
              {t('calibration.copyDump')}
            </button>
          )}
        </div>
      )}

      {/* Nothing rendered while the string is blank, so the empty slot costs no
          vertical space in the panel until someone writes into it. */}
      {t('calibration.guide') !== '' && (
        <div className="small" style={{ marginTop: 12, lineHeight: 1.7 }}>
          <T k="calibration.guide" />
        </div>
      )}

      {/*
        The grid's legend. It used to sit in the column beside the grid, which
        put a paragraph of caveats where a control column should be — and left
        no room to say what the border and the number on each cap actually are.
      */}
      <div className="small dim" style={{ marginTop: 12 }}>
        <div style={{ marginTop: 6 }}>
          <T k="calibration.gridNote" />
        </div>
        <div style={{ marginTop: 6 }}>
          <span className="swatch bad" /> <T k="calibration.ledState.red" />
        </div>
        <div style={{ marginTop: 2 }}>
          <span className="swatch marginal" /> <T k="calibration.ledState.amber" />
        </div>
        <div style={{ marginTop: 2 }}>
          <span className="swatch done" /> <T k="calibration.ledState.green" />
        </div>
        <div style={{ marginTop: 6 }}>
          <T k="calibration.ledMirror" params={{ lit }} />
        </div>
      </div>

      <LedComparison run={run} />
    </Panel>
  )
}

/**
 * Where the board's LEDs and the scale disagree, listed key by key.
 *
 * Debug-only, like the rest of the reverse-engineering surface. The grid now
 * mirrors the board's own state byte, so during an ordinary pass what is on
 * screen and what is on the desk match, and a table explaining that the
 * keyboard is lying about itself is a distraction from pressing keys.
 *
 * It stays because it is the evidence for the claim: a key in here is one where
 * the LED is wrong, either lit on a key whose calibration is fine or dark on a
 * key that has never been calibrated at all. That is worth being able to
 * produce on demand — see protocol/calibration.ts and docs/protocol.md §3.3.
 */
function LedComparison({ run }: { run: CalibrationRun }) {
  const t = useT()
  const { debug } = useSettings()
  const rows = useLayout().keys.map((key) => {
    const rec = run.records[key.index]
    const health = run.health[key.index]
    // A key with nothing known about it cannot disagree with anything.
    if (!rec || !health || health === 'unknown') return null
    const lit = ledColor(rec.state) !== undefined
    const bad = health === 'uncalibrated' || health === 'weak'
    if (lit === bad) return null
    return { key, rec, health, lit }
  }).filter((r): r is NonNullable<typeof r> => r !== null)

  if (!debug || rows.length === 0) return null

  return (
    <div style={{ marginTop: 14 }}>
      <div className="small">
        <b>{t('calibration.ledDisagreeTitle')}</b>{' '}
        <T k="calibration.ledDisagree" params={{ count: rows.length }} />
      </div>
      <table className="small" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>{t('calibration.col.key')}</th>
            <th>{t('calibration.col.led')}</th>
            <th>{t('calibration.col.scale')}</th>
            <th>{t('calibration.col.verdict')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, rec, health, lit }) => (
            <tr key={key.index}>
              <td>{key.label}</td>
              <td>
                {lit ? (
                  <>
                    <span
                      className="swatch"
                      style={{
                        borderColor: ledColor(rec.state),
                        background: ledColor(rec.state),
                      }}
                    />{' '}
                    {rec.state === CAL_STATE.fresh
                      ? t('calibration.led.red')
                      : t('calibration.led.amber')}
                  </>
                ) : (
                  <span className="dim">{t('calibration.led.off')}</span>
                )}
              </td>
              <td className="mono">
                {rec.scale.toFixed(2)}
                <span className="dim"> ({Math.round(scaleHeadroom(rec.scale) * 100)}%)</span>
              </td>
              <td>{t(`calibration.health.${health}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small dim" style={{ marginTop: 6 }}>
        <T k="calibration.ledDisagreeNote" params={{ red: CAL_LED.fresh, amber: CAL_LED.learning }} />
      </div>
    </div>
  )
}
