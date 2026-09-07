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

import type { ReportRateSpec, SwitchTypeSpec } from '../device/spec'
import { t, type MessageKey } from '../i18n'
import type { KeyBinding } from './keymap'
import type { Rgb } from './keyRgb'
import type { LightingSettings } from './lighting'

/**
 * `key_mode` in the stock schema. 0 = off, 1 = rapid trigger, 2 = rapid trigger
 * with full-stroke quick trigger — see KEY_MODE_WIRE in keyPerf.ts. The model
 * here keeps the two rapid-trigger variants in `RapidTrigger.continuous`.
 */
export type KeyMode = 'normal' | 'rapidTrigger'

/**
 * A magnetic switch the board can report.
 *
 * The *list* is a property of the board, so it lives in its spec and is read
 * through `device/tables.ts`; this is only the shape. It was in this file when
 * there was one board, and moving it is what stopped a second board from
 * showing the Raven61's switch names.
 */
export type SwitchTypeInfo = SwitchTypeSpec

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
 * A USB polling rate the board accepts.
 *
 * Same as SwitchTypeInfo: the values are the board's and live in its spec, and
 * `device/tables.ts` is what reads them.
 */
export type ReportRateInfo = ReportRateSpec

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
  /**
   * The lighting effect settings, which share this block — `payload[16..24]`.
   *
   * `null` for a board whose spec does not locate them, which is not the same
   * as a board with the lights off. See `protocol/lighting.ts`.
   *
   * These bytes used to be read as a single `sleepMinutes` field. They are not
   * a timeout: `payload[16]` is the effect the board is running.
   */
  lighting: LightingSettings | null
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

/**
 * What one key of one layer is bound to.
 *
 * It used to be a bare HID usage, from before the record was decoded. The board
 * stores three bytes that can also be a mouse button, a consumer key, a macro,
 * an advanced key or a firmware action, so a usage alone cannot hold what a
 * read finds — see protocol/keymap.ts for the record and the catalogs.
 */
export interface KeymapEntry {
  binding: KeyBinding
  /** Slot the record came from, when the slot map resolved one for the key. */
  slot?: number
}

/** One key's stored custom colour. See `protocol/keyRgb.ts`. */
export interface KeyRgbEntry {
  color: Rgb
  /** Slot the record came from, when the slot map resolved one for the key. */
  slot?: number
}

/**
 * A read of a per-key colour block, decoded and raw.
 *
 * The raw blob is kept for the same reason the performance snapshot keeps
 * one — a decode can look right while being indexed wrongly, and this block has
 * already been misread once as a keymap layer (see keyRgb.ts).
 *
 * `live` says which block it is. The stored layer (0x0a) is what a write goes
 * to and what a verify compares; the live frame (0xde) is a RAM buffer the
 * effect engine rewrites every frame, so it answers "what is on the keyboard
 * right now" and nothing else.
 */
export interface KeyRgbSnapshot {
  blob: Uint8Array
  slotMap: SlotMapInfo
  /** Decoded per key, in this project's key order. */
  entries: KeyRgbEntry[]
  live: boolean
}
