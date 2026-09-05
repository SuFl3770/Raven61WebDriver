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

import { t, type MessageKey } from '../i18n'

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
  /**
   * False for an entry that exists in the driver's table but not as a switch
   * anyone can fit. Kept for decoding — a board reporting the value still gets
   * a name instead of a bare number — but never offered as something to write.
   */
  selectable: boolean
}

export const SWITCH_TYPES: readonly SwitchTypeInfo[] = [
  { value: 0, name: 'Magnetic Orange', travelMm: 4.0, selectable: true },
  { value: 1, name: 'Magnetic White', travelMm: 4.0, selectable: true },
  { value: 2, name: 'Magnetic Jade', travelMm: 3.32, selectable: true },
  { value: 3, name: 'Light Breeze', travelMm: 4.0, selectable: true },
  { value: 4, name: 'Light Breeze V2', travelMm: 3.8, selectable: true },
  { value: 5, name: 'GEON RAW HE', travelMm: 3.5, selectable: true },
  { value: 6, name: 'TTC Magneto', travelMm: 3.4, selectable: true },
  // Not a switch that exists — confirmed by the board's owner. It is in the
  // driver's table, so it is decoded, but writing it would tell the board its
  // keys have a 2.50 mm stroke they do not have, and every depth measured
  // against that would be wrong.
  { value: 7, name: 'Chocolate Dwarf', travelMm: 2.5, selectable: false },
] as const

/** The types a user may actually assign. See SwitchTypeInfo.selectable. */
export const SELECTABLE_SWITCH_TYPES: readonly SwitchTypeInfo[] = SWITCH_TYPES.filter(
  (s) => s.selectable,
)

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
  firmware?: FirmwareIdentity
  /** Full key travel in mm — needed to turn raw counts into depth. */
  travelMm: number
  keyCount: number
}

/**
 * What the board answers when asked which firmware it is running — command
 * 0x03, see COMMAND.readFirmware.
 *
 * **Not a version number, and this app never calls it one.** The firmware has
 * none: the reply is its build name and the date and time it was compiled,
 * three strings the compiler baked in. Two boards flashed from the same release
 * are indistinguishable here, and two builds made on the same day are too. It
 * is still the only identity the board has, and it does change across a
 * firmware update, which is what makes it worth showing.
 */
export interface FirmwareIdentity {
  /** The reply exactly as the board sent it, commas and all. */
  raw: string
  /** The build's own name — `HALL_HS_USB_KB` on the board this was read from. */
  name: string
  /** The compiler's `__DATE__`, e.g. `Nov 13 2024`. Absent if the board omits it. */
  buildDate?: string
  /** The compiler's `__TIME__`, e.g. `11:05:59`. */
  buildTime?: string
}

/**
 * `reporte_rate` (the vendor's own typo) — the USB polling rate.
 *
 * The value on the wire is *not* a rate, and not an index into the list as it
 * reads either: it is the number the stock driver attaches to each item of its
 * own report-rate combo box (built at 0x4443ef-0x444527, one AddString per
 * entry with the value pushed alongside the language-string id). Those four
 * pairings are what this table is:
 *
 *   1 -> string 80 "8000Hz Report Rate"
 *   2 -> string 81 "4000Hz"
 *   3 -> string 82 "2000Hz"
 *   4 -> string 83 "1000Hz"
 *
 * The shipped profile database agrees: `reporte_rate` is 1 in the default
 * profile and 4 in the three user profiles, the two ends of that range and
 * nothing outside it. 8000 Hz being on the list is not a mistake either — the
 * firmware calls itself `HALL_HS_USB_KB`, and high speed is what it takes.
 *
 * Nothing here is confirmed against hardware: no capture of the stock driver
 * changing the rate has been taken, so the pairing rests on the driver's own
 * table alone.
 */
export interface ReportRateInfo {
  value: number
  hz: number
}

export const REPORT_RATES: readonly ReportRateInfo[] = [
  { value: 1, hz: 8000 },
  { value: 2, hz: 4000 },
  { value: 3, hz: 2000 },
  { value: 4, hz: 1000 },
] as const

export function reportRateInfo(value: number | undefined): ReportRateInfo | undefined {
  return value === undefined ? undefined : REPORT_RATES.find((r) => r.value === value)
}

/** Never invents a rate: a value outside the driver's table is shown as itself. */
export function reportRateName(value: number | undefined): string {
  if (value === undefined) return '—'
  const info = reportRateInfo(value)
  return info ? t('board.rate.hz', { hz: info.hz }) : t('board.rate.unknown', { value })
}

/**
 * `debounce_level`, `payload[15]` bits 5-6.
 *
 * Three levels, named the way the stock driver names them in its own combo box
 * (0x44427e-0x444362, language strings 75-77 with the values 0, 1 and 2). What
 * they are in milliseconds is not written down anywhere on either side, so this
 * app repeats the names and shows the raw value rather than inventing a figure.
 *
 * The field is two bits wide, so a board could report 3. Nothing names it.
 */
export interface DebounceLevelInfo {
  value: number
  labelKey: MessageKey
}

export const DEBOUNCE_LEVELS = [
  { value: 0, labelKey: 'board.debounce.high' },
  { value: 1, labelKey: 'board.debounce.medium' },
  { value: 2, labelKey: 'board.debounce.low' },
] as const satisfies readonly DebounceLevelInfo[]

export function debounceLevelName(value: number | undefined): string {
  if (value === undefined) return '—'
  const info = DEBOUNCE_LEVELS.find((d) => d.value === value)
  return info ? t(info.labelKey) : t('board.debounce.unknown', { value })
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
