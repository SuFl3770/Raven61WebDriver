import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { DEFAULT_TRAVEL_MM, KEY_COUNT } from '../keyboard/raven61'
import { parseKeyEvent } from '../protocol/frame'
import { MONITOR, armAnalogStream } from '../protocol/raven61'
import { sensorMap } from '../state/sensorMap'
import { link, useConnection } from '../state/link'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, Panel } from '../ui/Panel'

/**
 * Bottom-out calibration: the board relearns where each key's travel ends.
 *
 * There is no command for it. Calibration *is* holding the analog test mode
 * open — 0xa8 repeated on MONITOR.rearmMs — and pressing each key to the
 * bottom while it is held. See docs/protocol.md §3.2.
 *
 * It lives next to actuation and rapid trigger because all three decide where a
 * key triggers, and because a recalibration moves the ground those two are
 * measured from.
 */

/**
 * Depth that counts as bottomed out. Full travel is 200 counts of 0.02 mm, but
 * the last count is not always reported, so allow a hair of slack.
 */
const FULL_TRAVEL_MM = DEFAULT_TRAVEL_MM - 0.04
const RENDER_MS = 120

export function Calibration() {
  const { connected } = useConnection()
  const t = useT()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, forceRender] = useState(0)

  /** Deepest travel seen per key since this pass started. */
  const deepest = useRef<Float32Array>(new Float32Array(KEY_COUNT))
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

  const start = async () => {
    setError(null)
    deepest.current = new Float32Array(KEY_COUNT)
    offInput.current = link.onInput((_reportId, data) => {
      const e = parseKeyEvent(data)
      if (!e || !e.identifiable) return
      const index = sensorMap.resolve(e)
      if (index === undefined) return
      deepest.current[index] = Math.max(deepest.current[index] ?? 0, e.depthMm)
    })
    try {
      release.current = await armAnalogStream(link, { keepAlive: true })
      setRunning(true)
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

  const done = [...deepest.current].filter((mm) => mm >= FULL_TRAVEL_MM).length

  return (
    <Panel title={t('calibration.title')}>
      <Notice kind="warn">
        <span className="small">
          <T
            k="calibration.how"
            params={{ command: `0x${MONITOR.arm.toString(16)}`, rearmMs: MONITOR.rearmMs }}
          />
          <div style={{ marginTop: 4 }}>
            <T k="calibration.warning" />
          </div>
        </span>
      </Notice>

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button
          className={running ? 'danger' : 'primary'}
          onClick={() => void (running ? stop() : start())}
          disabled={!connected}
        >
          {running ? t('calibration.stop') : t('calibration.start')}
        </button>
        <span className="small">
          <T k="calibration.progress" params={{ done, total: KEY_COUNT }} />
        </span>
        <span className="small dim">
          {t('calibration.progressHint', { mm: FULL_TRAVEL_MM.toFixed(2) })}
        </span>
      </div>

      {running && (
        <>
          <div className="small dim" style={{ marginTop: 10, marginBottom: 8 }}>
            <T k="calibration.fillHint" />
          </div>
          <KeyGrid
            fill={(k) => (deepest.current[k.index] ?? 0) / DEFAULT_TRAVEL_MM}
            sub={(k) => {
              const mm = deepest.current[k.index] ?? 0
              return mm > 0 ? mm.toFixed(2) : undefined
            }}
          />
        </>
      )}
    </Panel>
  )
}
