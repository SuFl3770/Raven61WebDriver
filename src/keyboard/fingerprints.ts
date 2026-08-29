/**
 * Identities for the keys whose analog events do not name themselves.
 *
 * The board reports each key's HID usage in `payload[3]`, except for the seven
 * modifiers (0x00) and Fn (0x01) — HID carries modifiers in a bitmask, so they
 * have no keycode-array usage to report. Those are identified instead by
 * `payload[12..13]` together with the resting ADC baseline in `payload[18..19]`.
 *
 * Neither field is unique on its own: 0x0806 is shared by Esc, LAlt and RAlt,
 * and 0x0805 by LCtrl and LShift. The pair is what separates them.
 *
 * Measured on hardware. Kept in its own file because src/keyboard/raven61.ts is
 * regenerated from the stock driver's layout XML and would lose these.
 */
export interface KeyFingerprint {
  /** payload[12..13]. */
  sensorId: number
  /** payload[18..19] — the resting ADC reading, a stored calibration constant. */
  adcBaseline: number
  /** Index into RAVEN61_KEYS. */
  keyIndex: number
  label: string
}

export const KEY_FINGERPRINTS: readonly KeyFingerprint[] = [
  { sensorId: 0x0805, adcBaseline: 1888, keyIndex: 41, label: 'LShift' },
  { sensorId: 0x0808, adcBaseline: 1927, keyIndex: 52, label: 'RShift' },
  { sensorId: 0x0805, adcBaseline: 1880, keyIndex: 53, label: 'LCtrl' },
  { sensorId: 0x0801, adcBaseline: 1827, keyIndex: 54, label: 'LWin' },
  { sensorId: 0x0806, adcBaseline: 1881, keyIndex: 55, label: 'LAlt' },
  { sensorId: 0x0806, adcBaseline: 1898, keyIndex: 57, label: 'RAlt' },
  { sensorId: 0x0809, adcBaseline: 1905, keyIndex: 59, label: 'RCtrl' },
  { sensorId: 0x0801, adcBaseline: 1815, keyIndex: 60, label: 'Fn' },
]

/**
 * How far a baseline may drift and still match. The closest pair that shares a
 * sensor value is LCtrl 1880 / LShift 1888, so anything under 4 keeps them
 * apart; 3 leaves a little room without risking a wrong match.
 */
export const BASELINE_TOLERANCE = 3

/**
 * Finds the key for an unnamed event. Returns undefined when nothing is close
 * enough, or when two candidates are equally close — a wrong key is worse than
 * an unresolved one.
 */
export function matchFingerprint(sensorId: number, adcBaseline: number): KeyFingerprint | undefined {
  const scored = KEY_FINGERPRINTS.filter((f) => f.sensorId === sensorId)
    .map((f) => ({ f, d: Math.abs(f.adcBaseline - adcBaseline) }))
    .sort((a, b) => a.d - b.d)
  const best = scored[0]
  if (!best || best.d > BASELINE_TOLERANCE) return undefined
  if (scored[1] && scored[1].d === best.d) return undefined
  return best.f
}
