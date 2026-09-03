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

import { t } from '../i18n'

/**
 * `key_mode` in the stock schema. 0 = off, 1 = rapid trigger, 2 = rapid trigger
 * with full-stroke quick trigger — see KEY_MODE_WIRE in keyPerf.ts. The model
 * here keeps the two rapid-trigger variants in `RapidTrigger.continuous`.
 */
export type KeyMode = 'normal' | 'rapidTrigger'

/**
 * `switch_type` — which magnetic switch is fitted, reported per key by the
 * board in the performance blob.
 *
 * **Names are hardware-derived.** Each type was set for the whole board in the
 * stock driver and read back here, so the value-to-name pairing below is
 * measured, not inferred. That matters because it contradicts the binary: the
 * stock driver pushes language strings 1450-1457 in ascending order as varargs
 * (0x44af0d-0x44aff8), which would put Light Breeze at 0, and hardware says 0
 * is Magnetic Orange. Four of the eight came out swapped that way — 0 with 4,
 * and 1 with 3 — while 2, 5, 6 and 7 matched. So that vararg list is not the
 * order the selector ends up in, and how it gets reordered is still unknown.
 * See docs, "switch name order", for the open question.
 *
 * Travel comes from a dword table at 0x576c8c, and stays attached to the *value*
 * rather than the name: the driver indexes it with the raw `switch_type`
 * (0x43a7df), the same number it hands to SetCurSel. Its 3.32 / 3.80 / 3.50 /
 * 3.40 / 2.50 mm entries are why total stroke cannot be assumed to be 4 mm for
 * every board.
 *
 * Older string ids 502-504 name a different, shorter list ("Jiadalong Magnetic
 * Jade/White Axis", "Hejin axis") which belongs to another model's UI.
 */
export interface SwitchTypeInfo {
  value: number
  name: string
  /** Full travel in mm, from the stock driver's own table. */
  travelMm: number
}

export const SWITCH_TYPES: readonly SwitchTypeInfo[] = [
  { value: 0, name: 'Magnetic Orange', travelMm: 4.0 },
  { value: 1, name: 'Magnetic White', travelMm: 4.0 },
  { value: 2, name: 'Magnetic Jade', travelMm: 3.32 },
  { value: 3, name: 'Light Breeze', travelMm: 4.0 },
  { value: 4, name: 'Light Breeze V2', travelMm: 3.8 },
  { value: 5, name: 'GEON RAW HE', travelMm: 3.5 },
  { value: 6, name: 'TTC Magneto', travelMm: 3.4 },
  { value: 7, name: 'Chocolate Dwarf', travelMm: 2.5 },
] as const

export function switchTypeInfo(value: number | undefined): SwitchTypeInfo | undefined {
  return value === undefined ? undefined : SWITCH_TYPES.find((s) => s.value === value)
}

/** Never invents a name: an out-of-range value is shown as the number it is. */
export function switchTypeName(value: number | undefined): string {
  if (value === undefined) return '—'
  return switchTypeInfo(value)?.name ?? t('protocol.switchType.unknown', { value })
}

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
  /** `switch_type`, as read from the board. Undefined until a read happens. */
  switchType?: number
  /**
   * Bits 5-7 of the switch byte, kept only so a write can put back exactly what
   * the read found. Meaning unknown — see KeyPerfRecord.switchFlags.
   */
  switchFlags?: number
  /**
   * The board marked this key's rapid-trigger and dead-zone bytes as never set
   * (all 0xff). Kept so a write puts the marker back instead of inventing
   * values — see KeyPerfRecord.rtUnset.
   */
  rtUnset?: boolean
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
  /** False for reports that cannot name a key at all — see KeyEvent. */
  identifiable: boolean
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

/**
 * The board-wide settings that sit alongside the per-key ones, read with 0x05.
 *
 * Only the bytes the stock driver actually writes are named. Two call sites
 * share this block and touch disjoint ranges — the performance tab writes
 * payload[12..15] (0x429560) and the general settings page payload[16..24]
 * (0x428a30) — and 0x429300 reads three of them straight back into its UI,
 * which is what confirms the offsets.
 */
export interface GlobalSettings {
  /** The whole reply payload, for panels that want to show the raw bytes. */
  raw: Uint8Array
  /** `reporte_rate` (the vendor's own typo), payload[12] bits 0-3. */
  reportRate: number
  /** `tick_rate`, payload[12] bits 4-7. */
  tickRate: number
  /** `dead_zone`, payload[13]. */
  deadZone: number
  disableWin: boolean
  disableAltTab: boolean
  disableAltF4: boolean
  /** `perf_tachyon_mode`. Meaning still unknown. */
  tachyon: boolean
  /**
   * `perf_bottomrapidtrigger_mode` — the stock UI's "always trigger when
   * bottoming". The one performance-tab setting that is global rather than
   * per-key.
   */
  bottomOutTrigger: boolean
  /** `actuation_check`. */
  actuationCheck: boolean
  /** The magnet-axis test bit, which the driver also sets while on its performance tab. */
  magnetTest: boolean
  /** `debounce_level`, payload[15] bits 5-6. */
  debounceLevel: number
  /** Sleep timeout in minutes; 0xff means never. */
  sleepMinutes: number
}

/**
 * One read of the per-key performance blob, raw bytes included.
 *
 * The bytes are part of the product while the protocol is still being pinned
 * down: the first cut of this codec indexed the blob by the wrong field, and
 * the decoded model looked plausible enough to hide it. A dump of the slots is
 * what makes that kind of mistake visible.
 */
export interface KeyPerfSnapshot {
  /** The blob exactly as the board returned it. */
  blob: Uint8Array
  /** The keymap block the slot mapping came from, when it was read. */
  keymap?: Uint8Array
  /** Which key each slot holds, and where that came from. */
  slotMap: SlotMapInfo
  /** Decoded per key, in this project's key order. */
  configs: KeyConfig[]
  /** Slots whose 8 bytes are all zero, by slot number. */
  emptySlots: number[]
}

/** Structural view of a slot mapping, so panels need not import the codec. */
export interface SlotMapInfo {
  keyBySlot: Map<number, { index: number; label: string }>
  slotByKey: Map<number, number>
  source: 'keymap' | 'fallback'
  unknownUsages: { slot: number; usage: number }[]
}

export interface KeymapEntry {
  /** HID usage code or a vendor-specific action code. */
  code: number
  label?: string
}
