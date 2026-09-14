import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useT } from '../i18n'
import { activeLayout } from '../device/active'
import { supports } from '../protocol/codec'
import { parseActiveEvent } from '../protocol/events'
import { armActiveStream, link, useCodec, useConnection } from '../state/link'
import { sensorMap } from '../state/sensorMap'

/**
 * How far down the key you last pressed is, right now.
 *
 * Every number on this tab is a depth the board will *act* at, and until now
 * there was no way to see a depth the board is *reading*. So the actuation
 * slider was set against a mental model of where 1.5 mm is on a keycap, and
 * the only way to check the guess was to type somewhere else and see whether
 * it felt right. This is the other half: the same axis, at the same height,
 * beside the control that sets the line the reading crosses.
 *
 * ## Why this does not stop the keyboard typing
 *
 * Analog reporting has to be turned on, and the command that turns it on —
 * `0xa8` — also enters a test mode in which the board does not type. The two
 * come apart: reporting latches and the mode does not, so `armActiveStream`
 * without `keepAlive` sends `0xa8` and then `0xa9` straight after, which
 * leaves the mode and keeps the reports. See MONITOR_DEFAULTS in
 * protocol/engine.ts for where that was read off the stock driver.
 *
 * Calibration is the opposite case — it *holds* `0xa8` — and the two must not
 * run at once, because the `0xa9` this one sends on arming would drop the
 * board out of the mode the pass depends on. Nothing here guards against that:
 * the sections are unmounted while calibration mode is on (see InputPoint), so
 * this component does not exist to arm anything.
 *
 * ## Why the value is not React state
 *
 * Events arrive as fast as a key moves. Setting state per event would render
 * this component a few hundred times a second; instead the newest sample sits
 * in a ref and a timer paints it at RENDER_MS. That is also why the hook lives
 * in this file rather than in Actuation — the repaint stays inside the gauge
 * and does not take the sliders, the presets and the notices with it.
 */

/** Fast enough to read as continuous, slow enough not to be the app's main job. */
const RENDER_MS = 50

interface Sample {
  index: number
  label: string
  depthMm: number
  /** The key's own full stroke, as the board reported it in the same event. */
  travelMm: number
}

function useLiveDepth(): Sample | null {
  const { connected } = useConnection()
  const codec = useCodec()
  const armed = connected && supports(codec, 'armAnalogStream')

  const sample = useRef<Sample | null>(null)
  const [, paint] = useState(0)

  useEffect(() => {
    if (!armed) {
      sample.current = null
      return
    }
    /*
     * Guards a resolution that arrives after this effect has been torn down.
     *
     * StrictMode mounts, unmounts and remounts, so `armActiveStream` can
     * settle for a listener that is already gone. Unlike the calibration case
     * the stale path cannot turn reporting off — the release for a
     * non-keepAlive arm does nothing — but it can still leave a second input
     * listener attached, and two listeners means every sample counted twice.
     */
    let live = true
    let release: (() => Promise<void>) | null = null

    const off = link.onInput((_reportId, data) => {
      const e = parseActiveEvent(data)
      if (!e || !e.identifiable) return
      const index = sensorMap.resolve(e)
      if (index === undefined) return
      /*
       * A press claims the gauge; a release only updates the key that already
       * has it.
       *
       * Without the second half, letting go of one key while another is held
       * would move the readout onto the key that is on its way up — and the
       * gauge would show the wrong key falling to zero. Without the first, it
       * would never move at all.
       */
      if (!e.pressed && sample.current?.index !== index) return
      sample.current = {
        index,
        label: activeLayout().byIndex(index)?.label ?? `#${index}`,
        depthMm: e.depthMm,
        travelMm: e.travelMm > 0 ? e.travelMm : 4,
      }
    })

    void armActiveStream()
      .then((fn) => {
        if (live) release = fn
        else void fn()
      })
      // Nothing to report: the gauge simply stays empty, and the tab's own
      // status line is where a link that is not answering is said out loud.
      .catch(() => {})

    const timer = setInterval(() => paint((n) => n + 1), RENDER_MS)

    return () => {
      live = false
      clearInterval(timer)
      off()
      void release?.()
      sample.current = null
    }
  }, [armed])

  return sample.current
}

/**
 * The gauge, for the left of the actuation slider.
 *
 * Same height and same top-is-shallow direction as the slider it stands
 * beside, so the reading and the trigger line can be compared by eye. The two
 * are not on one scale, though, and cannot be: this runs to the pressed key's
 * own stroke, while the slider runs to the shallowest stroke among the
 * *selected* keys. Pressing a key that is not selected is a fair thing to do
 * and the gauge still has to be right about it.
 */
export function LiveDepth() {
  const t = useT()
  const live = useLiveDepth()

  const pct = live ? Math.min(100, Math.max(0, (live.depthMm / live.travelMm) * 100)) : 0

  return (
    <div className="depth-live">
      <div className="depth-live-read">
        <div className="small dim">{t('liveDepth.title')}</div>
        <b className="mono depth-live-mm">{live ? live.depthMm.toFixed(2) + "mm" : '0.00mm'}</b>
      </div>
      <div className="depth-live-bar" style={{ '--live': `${pct}%` } as CSSProperties} />
    </div>
  )
}
