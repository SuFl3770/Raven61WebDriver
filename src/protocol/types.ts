/**
 * Domain model, mirroring the stock driver's own SQLite schema so that a
 * profile exported from one side means the same thing on the other.
 *
 * Reference: `t_key_perf_data(profile, key_code, switch_type, key_mode,
 * key_actuation, rt_press, rt_release, deadzone_state, press_deadzone,
 * release_deadzone)` — recovered from the stock driver binary, see
 * docs/protocol.md.
 *
 * Units here are millimetres. The wire encoding is the codec's problem.
 */

/** `key_mode` in the stock schema. Numeric values are not yet confirmed. */
export type KeyMode = 'normal' | 'rapidTrigger'

/** `switch_type`. The stock driver lists these switch families. */
export const SWITCH_TYPES = [
  'Magnetic Jade',
  'Magnetic White',
  'Magnetic Orange',
  'TTC Magneto',
] as const
export type SwitchType = (typeof SWITCH_TYPES)[number]

export interface RapidTrigger {
  enabled: boolean
  /** `rt_press` — downward travel that re-triggers a press, in mm. */
  pressMm: number
  /** `rt_release` — upward travel that releases, in mm. */
  releaseMm: number
  /** UI-only: when false the two sensitivities are edited as one value. */
  separate: boolean
  /** "Full stroke quick trigger": rapid trigger stays active below actuation. */
  continuous: boolean
}

export interface DeadZone {
  /** `deadzone_state` */
  enabled: boolean
  /** `press_deadzone` — ignored travel at the top of the stroke, in mm. */
  topMm: number
  /** `release_deadzone` — ignored travel at the bottom, in mm. */
  bottomMm: number
}

/** One row of `t_key_perf_data`, in domain terms. */
export interface KeyConfig {
  /** `key_actuation` — actuation depth in mm from the top of travel. */
  actuationMm: number
  mode: KeyMode
  rapidTrigger: RapidTrigger
  deadZone: DeadZone
  switchType?: SwitchType
}

/**
 * "Advanced keys" — `t_magnetic_key_data.macro_type`. The stock driver caps
 * these at 40 per profile.
 */
export type AdvancedKeyType = 'DKS' | 'MT' | 'TGL' | 'RS' | 'SOCD' | 'OKS'

export interface AdvancedKey {
  type: AdvancedKeyType
  /** Firmware key address this binding attaches to (`key_value`). */
  keyIndex: number
  layer: number
  /** RS and SOCD watch a pair of keys; the others use `keyIndex` only. */
  key1?: number
  key2?: number
  /** DKS: the four bindings fired at four travel checkpoints. */
  bindings?: [number, number, number, number]
  /** DKS: `trigger_state1..4` from `t_key_item_data`. */
  triggerStates?: [number, number, number, number]
}

/** One live sample of a key's analog travel. */
export interface KeySample {
  /** HID usage, or 0x00 / 0x01 for keys that have none (modifiers, Fn). */
  usage: number
  /** Identity for keys whose usage is a placeholder (modifiers, Fn). */
  fingerprint: string
  sensorId: number
  adcBaseline: number
  usageIsReal: boolean
  /** 0.0 (released) … travelMm (bottomed out). */
  depthMm: number
  /** Unscaled sensor value, kept for calibration work. */
  raw: number
  pressed: boolean
}

export interface DeviceInfo {
  vendorId: number
  productId: number
  productName: string
  firmwareVersion?: string
  /** Full key travel in mm — needed to turn raw counts into depth. */
  travelMm: number
  keyCount: number
}

export interface KeymapEntry {
  /** HID usage code or a vendor-specific action code. */
  code: number
  label?: string
}
