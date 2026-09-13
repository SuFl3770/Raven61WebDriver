import { useT } from '../i18n'
import { T } from '../i18n/T'
import { sensorMap, useSensorMap } from '../state/sensorMap'
import { Panel } from '../ui/Panel'

/**
 * "Ignore the built-in identity table" — a debug-tab switch.
 *
 * It was on the settings tab, next to the language picker, which put a
 * protocol-debugging escape hatch among the preferences a normal user is
 * expected to touch. It belongs here instead, immediately under the sensor
 * analysis whose stale-table warning is the reason anyone would reach for it:
 * the table matches keys by sensor value and baseline ADC, calibration moves
 * both, and a table that has drifted does not fail to name a key — it names
 * the wrong one.
 */
export function KeyIdSetting() {
  const t = useT()
  // Subscribes so the switch reflects a change made anywhere else.
  useSensorMap()

  return (
    <Panel title={t('debug.keyId.title')}>
      <label className="row">
        <span>{t('debug.keyId.label')}</span>
        <input
          type="checkbox"
          checked={sensorMap.builtInIgnored}
          onChange={(e) => sensorMap.setIgnoreBuiltIn(e.target.checked)}
        />
      </label>
    </Panel>
  )
}
