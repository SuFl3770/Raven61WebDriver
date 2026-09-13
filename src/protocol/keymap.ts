/**
 * The keymap record, and the set of things the stock driver can put in one.
 *
 * Three sources agree on the format, which is why this module is something
 * other than a guess:
 *
 *   - the stock driver's own encoder at 0x429f80, which turns one
 *     `t_key_macro_data` row into the three bytes that go on the wire. Every
 *     branch of it is reproduced below, and it is the authority on what the
 *     stock remap tab can produce
 *   - the firmware's press-time dispatch at 0x9ec6, which switches on the type
 *     byte and hands the other two to a handler per kind (0x8f6c keyboard,
 *     0x9678 mouse buttons, 0x96e0 wheel, 0x7ff6 consumer, 0x812c actions)
 *   - the firmware's boot check at 0xa7ae, which reads slot 0 of the live
 *     keymap and **rewrites both layers from the factory tables** unless its
 *     type byte is one of 0x00, 0x10, 0x20-0x23, 0x30, 0x40, 0x50, 0x60, 0x70,
 *     0x80, 0x90-0x92 or 0xf0
 *
 * A record is `[type][param][code]`:
 *
 *   0x10  ordinary key.   param = HID modifier bitmask, code = HID usage
 *   0x20  mouse buttons.  param = button bitmask, code = 1 for a double click
 *   0x21  mouse wheel.    code = signed step, 1 up and 0xff down
 *   0x30  consumer key.   param/code = a 16-bit usage, little-endian
 *   0x70  macro.          param = macro slot, code = repeat count
 *   0x90-0x95  advanced key. param indexes the 24-byte records at flash 0x22100
 *   0xf0  action.         param = action code, code = its argument
 *   0x00 / 0xff  nothing bound; 0xff is what the factory keymap leaves behind
 *
 * The record format and the catalogs came out of those three; reading and
 * writing a layer with them is confirmed on hardware (spec 7.3).
 */
import type { KeymapSpec } from '../device/spec'
import { t, type MessageKey } from '../i18n'

/**
 * Geometry of the *live* keymap — flash 0x20b00, read with 0x08 and written
 * with 0x09.
 *
 * Not the block the slot map comes from: that is 0x07, the factory defaults in
 * code flash, and it is deliberately the one a slot map uses because remapping
 * a key cannot move its slot. See slotMap.ts.
 *
 * 512 bytes per layer would hold 170 whole records, but the firmware's lookup
 * (`0x20b00 + layer * 512 + slot * 3`, at 0x885e) is only ever reached with a
 * slot below 128, and the driver's own write loop stops there too.
 */
export const KEYMAP_BLOCK = {
  entrySize: 3,
  layerBytes: 512,
  slots: 128,
  /**
   * Layers with storage behind them. The firmware indexes four, but layer 2
   * lands on the per-key RGB blob and layer 3 on the macro table — see
   * layers.ts, and do not offer them.
   */
  layers: 2,
} as const

/** Type byte of a record. */
export const RECORD_TYPE = {
  none: 0x00,
  key: 0x10,
  mouseButton: 0x20,
  mouseWheel: 0x21,
  consumer: 0x30,
  macro: 0x70,
  /**
   * Advanced keys, in the order the driver's encoder assigns them from
   * `macro_type` 14-19: DKS, TGL, MT, RS, SOCD, OKS. The pairing of 0x91 with
   * TGL and 0x92 with MT is the encoder's rather than a guess — 0x92 is the one
   * whose third byte carries a hold time (milliseconds / 10), which is MT's own
   * setting.
   */
  dks: 0x90,
  tgl: 0x91,
  mt: 0x92,
  rs: 0x93,
  socd: 0x94,
  oks: 0x95,
  action: 0xf0,
  unassigned: 0xff,
} as const

/** Bit n of a modifier mask is usage 0xE0 + n. Confirmed by the driver's 0x45d990. */
export const MODIFIER_BASE_USAGE = 0xe0

export const MODIFIERS: readonly { bit: number; label: string; usage: number }[] = [
  { bit: 0x01, label: 'LCtrl', usage: 0xe0 },
  { bit: 0x02, label: 'LShift', usage: 0xe1 },
  { bit: 0x04, label: 'LAlt', usage: 0xe2 },
  { bit: 0x08, label: 'LWin', usage: 0xe3 },
  { bit: 0x10, label: 'RCtrl', usage: 0xe4 },
  { bit: 0x20, label: 'RShift', usage: 0xe5 },
  { bit: 0x40, label: 'RAlt', usage: 0xe6 },
  { bit: 0x80, label: 'RWin', usage: 0xe7 },
] as const

/** Mouse button bits, as the firmware ORs them into its report at 0x9678. */
export const MOUSE_BUTTONS = {
  left: 0x01,
  right: 0x02,
  middle: 0x04,
  back: 0x08,
  forward: 0x10,
} as const

/**
 * The keymap geometry and entry markers a caller gets when it names no spec.
 *
 * Assembled from the constants above rather than restating them, so the
 * evidence stays with the numbers. A sibling board overrides these in
 * `DeviceSpec.keymap`; the three-byte record itself is the family's and is not
 * a spec field — see `decodeRecord`.
 */
export const DEFAULT_KEYMAP: KeymapSpec = {
  entrySize: KEYMAP_BLOCK.entrySize,
  slots: KEYMAP_BLOCK.slots,
  layers: KEYMAP_BLOCK.layers,
  layerBytes: KEYMAP_BLOCK.layerBytes,
  /**
   * 768 bytes: what the stock driver asks command 0x07 for, which is layer 0
   * whole and layer 1 as far as slot 85. Not `layerBytes * layers` — the
   * factory block is packed 3 bytes per slot with no layer padding.
   */
  defaultsBlobSize: 768,
  plainKey: RECORD_TYPE.key,
  layerKey: RECORD_TYPE.action,
  fnSelector: 0xff,
  modifierBaseUsage: MODIFIER_BASE_USAGE,
}

export type KeyBinding =
  /** Nothing bound. `raw` keeps 0x00 and 0xff apart — see decodeRecord. */
  | { kind: 'none'; raw: number }
  | { kind: 'key'; usage: number; modifiers: number }
  | { kind: 'consumer'; usage: number }
  | { kind: 'mouseButton'; buttons: number; doubleClick: boolean }
  | { kind: 'mouseWheel'; delta: number }
  | { kind: 'action'; code: number; arg: number }
  | { kind: 'macro'; slot: number; repeat: number }
  | { kind: 'advanced'; type: number; record: number; param: number }
  /** A type byte none of the above covers, kept byte for byte so a write puts it back. */
  | { kind: 'unknown'; bytes: readonly [number, number, number] }

const ADVANCED_TYPES: readonly number[] = [
  RECORD_TYPE.dks,
  RECORD_TYPE.tgl,
  RECORD_TYPE.mt,
  RECORD_TYPE.rs,
  RECORD_TYPE.socd,
  RECORD_TYPE.oks,
]

/** Decodes three bytes. Never throws: an unrecognised type comes back as `unknown`. */
export function decodeRecord(bytes: ArrayLike<number>, at = 0): KeyBinding {
  const type = bytes[at] ?? 0
  const param = bytes[at + 1] ?? 0
  const code = bytes[at + 2] ?? 0
  switch (type) {
    case RECORD_TYPE.none:
    case RECORD_TYPE.unassigned:
      return { kind: 'none', raw: type }
    case RECORD_TYPE.key:
      // `10 00 00` is what the driver writes for an unassigned key, so it is a
      // key record with no usage rather than a kind of its own.
      return param === 0 && code === 0
        ? { kind: 'none', raw: type }
        : { kind: 'key', usage: code, modifiers: param }
    case RECORD_TYPE.mouseButton:
      return { kind: 'mouseButton', buttons: param, doubleClick: code === 1 }
    case RECORD_TYPE.mouseWheel:
      // The step is signed: the driver writes 0xff for a wheel-down.
      return { kind: 'mouseWheel', delta: code > 0x7f ? code - 0x100 : code }
    case RECORD_TYPE.consumer:
      return { kind: 'consumer', usage: param | (code << 8) }
    case RECORD_TYPE.macro:
      return { kind: 'macro', slot: param, repeat: code }
    case RECORD_TYPE.action:
      return { kind: 'action', code: param, arg: code }
    default:
      if (ADVANCED_TYPES.includes(type)) {
        return { kind: 'advanced', type, record: param, param: code }
      }
      return { kind: 'unknown', bytes: [type, param, code] }
  }
}

/** The three bytes for a binding. */
export function encodeRecord(binding: KeyBinding): [number, number, number] {
  switch (binding.kind) {
    case 'none':
      // `10 00 00`, which is what the stock encoder writes for macro_type 1.
      // 0xff would be the factory's own marker rather than an edit.
      return [RECORD_TYPE.key, 0, 0]
    case 'key':
      return [RECORD_TYPE.key, binding.modifiers & 0xff, binding.usage & 0xff]
    case 'consumer':
      return [RECORD_TYPE.consumer, binding.usage & 0xff, (binding.usage >> 8) & 0xff]
    case 'mouseButton':
      return [RECORD_TYPE.mouseButton, binding.buttons & 0xff, binding.doubleClick ? 1 : 0]
    case 'mouseWheel':
      return [RECORD_TYPE.mouseWheel, 0, binding.delta & 0xff]
    case 'action':
      return [RECORD_TYPE.action, binding.code & 0xff, binding.arg & 0xff]
    case 'macro':
      return [RECORD_TYPE.macro, binding.slot & 0xff, binding.repeat & 0xff]
    case 'advanced':
      return [binding.type & 0xff, binding.record & 0xff, binding.param & 0xff]
    case 'unknown':
      return [binding.bytes[0], binding.bytes[1], binding.bytes[2]]
  }
}

/**
 * The base-layer record the factory keymap holds for a key with this legend.
 *
 * The layout file gives each key a HID usage, and the factory keymap stores it
 * in one of three shapes: a modifier as a bitmask with no usage byte, Fn as the
 * momentary layer action, and everything else as a plain usage (see
 * slotMap.ts). This rebuilds that.
 *
 * It is a *display* helper, not a source of defaults — "put this key back"
 * reads the board's own factory table (0x07). Its job is to answer whether a
 * cap is showing something other than its legend, which is what decides
 * whether the grid needs to spell the binding out.
 */
export function factoryBinding(usage: number): KeyBinding {
  if (usage >= MODIFIER_BASE_USAGE && usage <= MODIFIER_BASE_USAGE + 7) {
    return { kind: 'key', usage: 0, modifiers: 1 << (usage - MODIFIER_BASE_USAGE) }
  }
  if (usage === 0xff) return { kind: 'action', code: ACTION.momentaryLayer, arg: 1 }
  return { kind: 'key', usage, modifiers: 0 }
}

/**
 * Whether two bindings are the same thing.
 *
 * The wire bytes decide it, with one exception: `encodeRecord` deliberately
 * writes `10 00 00` for every `none`, because `0xff` is the factory's marker and
 * this app does not put it back as if it were an edit. That makes the encoding
 * lossy in exactly one place — a slot the factory left empty and a key someone
 * switched off encode alike — so `raw` is compared as well.
 *
 * Without that, picking `KC_NO` for a key whose slot is already `ff ff ff` (most
 * of the Fn layer) looked like an edit back to what the board holds, and the
 * remap tab dropped it: no write, no change on screen, and no way to tell that
 * from a setting that had been applied. The two records really are different
 * bytes on the board, and the firmware's boot check reads the difference.
 */
export function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  const x = encodeRecord(a)
  const y = encodeRecord(b)
  if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false
  if (a.kind === 'none' && b.kind === 'none') return a.raw === b.raw
  return true
}

/**
 * Action codes for a 0xf0 record, from the handler at 0x812c. The whole set the
 * firmware decodes is 0x01-0x08, 0x2b-0x3e, 0x51-0x54, 0xfe and 0xff; the ones
 * named here are those the stock driver's remap tab can produce, plus 0xfe,
 * which the driver never offers but the factory Fn layer already binds.
 */
export const ACTION = {
  lock: 0x01,
  winLock: 0x02,
  wasdSwap: 0x03,
  /**
   * ⚠ Latch to base layer 0 (0x04) or 2 (0x05). Deliberately not offered
   * anywhere: layer 2's keymap address is the per-key RGB blob on this board,
   * so binding 0x05 makes the firmware read colours as keycodes until the
   * keymap is rewritten. The stock driver has no UI for either. See layers.ts.
   */
  latchProfileA: 0x04,
  latchProfileB: 0x05,
  boot: 0x07,
  reset: 0x08,
  /**
   * Calibration reset (0xfe): drops every sensor's stored scale back to the
   * 0.62 floor, the same thing the record reset writes (see calibration.ts).
   * The factory Fn layer binds it, and the keys have to be pressed through
   * their full travel again afterwards for depth to read correctly.
   */
  calibrationReset: 0xfe,
  /** Momentary layer switch: hold for the layer in `arg`. Fn is `f0 ff 01`. */
  momentaryLayer: 0xff,
} as const

/** Never written by this app, whatever a catalog or a UI says. */
export const UNSAFE_ACTIONS: readonly number[] = [ACTION.latchProfileA, ACTION.latchProfileB]

export function isUnsafe(binding: KeyBinding): boolean {
  return binding.kind === 'action' && UNSAFE_ACTIONS.includes(binding.code)
}

/** One entry of the picker. `label` is a legend, and stays literal in every language. */
export interface BindingChoice {
  label: string
  binding: KeyBinding
}

/**
 * One run of related entries inside a group.
 *
 * A group is a whole tab of the picker and some of them are twenty buttons long,
 * which is a wall to read: "Vol+" and "Web Refresh" and "Calculator" have
 * nothing to do with each other beyond both being on the consumer page. So each
 * group is split into the sets a person actually looks for — playback, volume,
 * web, launchers — and the split is only for reading. The values, and which
 * group an entry is in, stay the stock driver's.
 *
 * `nameKey` is absent for a group that is one set, where a header would just
 * repeat the tab's own name.
 */
export interface BindingSection {
  nameKey?: MessageKey
  choices: BindingChoice[]
}

export interface BindingGroup {
  nameKey: MessageKey
  sections: BindingSection[]
}

/** Every choice of a group, in the order the sections put them. */
export function groupChoices(group: BindingGroup): BindingChoice[] {
  return group.sections.flatMap((s) => s.choices)
}

const section = (nameKey: MessageKey, choices: BindingChoice[]): BindingSection => ({
  nameKey,
  choices,
})

const consumer = (label: string, usage: number): BindingChoice => ({
  label,
  binding: { kind: 'consumer', usage },
})

/**
 * The stock driver's "Multimedia" list, in its order, with the consumer-page
 * usage it pairs each name with (0x414880-0x414cc6).
 */
export const CONSUMER_SECTIONS: BindingSection[] = [
  section('keymap.section.playback', [
    consumer('Play', 0x0cd),
    consumer('Stop', 0x0b7),
    consumer('Previous', 0x0b6),
    consumer('Next', 0x0b5),
  ]),
  section('keymap.section.volume', [
    consumer('Vol+', 0x0e9),
    consumer('Vol-', 0x0ea),
    consumer('Mute', 0x0e2),
  ]),
  section('keymap.section.display', [
    consumer('Screen Bright+', 0x06f),
    consumer('Screen Bright-', 0x070),
  ]),
  section('keymap.section.web', [
    consumer('Web Home', 0x223),
    consumer('Web Refresh', 0x227),
    consumer('Web Stop', 0x226),
    consumer('Web Backward', 0x224),
    consumer('Web Forward', 0x225),
    consumer('Web Favorites', 0x22a),
    consumer('Web Search', 0x221),
  ]),
  /*
   * The four that start a program rather than control one. "Player" is the
   * driver's name for 0x183, which is the consumer page's own
   * "launch media player" — it heads the driver's list, and it belongs here
   * rather than under playback, where it would read as a transport control.
   */
  section('keymap.section.apps', [
    consumer('Player', 0x183),
    consumer('PC', 0x194),
    consumer('Calculator', 0x192),
    consumer('Email', 0x18a),
  ]),
]

export const CONSUMER_KEYS: BindingChoice[] = CONSUMER_SECTIONS.flatMap((s) => s.choices)

const key = (label: string, usage: number): BindingChoice => ({
  label,
  binding: { kind: 'key', usage, modifiers: 0 },
})

/*
 * "no key", and the one entry in this list the stock driver has no counterpart
 * for. It is here because the obvious thing to look for is not here: VIA's
 * `KC_TRNS`, the transparent key that falls through to the layer below.
 *
 * **This firmware has no such record.** The press path fetches the three bytes
 * at `0x20b00 + layer * 512 + slot * 3` and hands them straight to the
 * dispatch (0xf6ec, then 0x9ec6) — there is no second fetch with layer 0 — and
 * the dispatch has no branch for `0x00` or `0xff`, so both fall to its default
 * arm, which sends the report along untouched (0xa116 → 0xa2ce). An unbound key
 * on the Fn layer does nothing; it does not become the base layer's key.
 *
 * So the honest entry is the one below and it is named for what it is. It
 * writes `10 00 00`, the same record the picker's "unassign" button writes —
 * having it in the list too is what makes it findable by someone looking for
 * the triangle.
 *
 * `raw` is the type byte this record actually has, so that a pending edit and
 * the same record read back off the board are one binding and read the same
 * on the cap. See the `none` arm of `bindingLabel`.
 */
const KC_NO: BindingChoice = { label: 'KC_NO', binding: { kind: 'none', raw: RECORD_TYPE.key } }

/**
 * The stock driver's "Special" list: the HID usages a 61-key board has no cap
 * for (0x414cc6-0x415180), plus `KC_NO` — see the note on it above, which is the
 * one entry here that is this app's and not the driver's.
 *
 * Its last entry, "Reset" with the value 0xf8, is left out. 0xf8 is not a HID
 * usage and the firmware's key path would put it in the report unchanged, so
 * what the stock driver means by it is not settled — and a keycode nothing can
 * type is not worth offering on a guess.
 *
 * The CJK names are the driver's own. In HID terms they are 0x88
 * Katakana/Hiragana, 0x89 Yen, 0x8a Henkan, 0x8b Muhenkan, 0x90 Hangul/English
 * and 0x91 Hanja.
 */
export const EXTRA_SECTIONS: BindingSection[] = [
  section('keymap.section.unbound', [KC_NO]),
  section(
    'keymap.section.fkeys',
    Array.from({ length: 12 }, (_, i) => key(`F${13 + i}`, 0x68 + i)),
  ),
  section('keymap.section.international', [
    key('NUHS', 0x32),
    key('NUBS', 0x64),
    key('Ro', 0x87),
    key('かな', 0x88),
    key('￥', 0x89),
    key('変換', 0x8a),
    key('無変換', 0x8b),
    key('한영', 0x90),
    key('漢字', 0x91),
  ]),
]

export const EXTRA_KEYS: BindingChoice[] = EXTRA_SECTIONS.flatMap((s) => s.choices)

/** LShift. The stock driver stores one modifier per binding, and this is it. */
const SHIFT = 0x02

const shifted = (label: string, usage: number): BindingChoice => ({
  label,
  binding: { kind: 'key', usage, modifiers: SHIFT },
})

/**
 * The shifted symbols, in board order — the number row, then the two brackets
 * and the backslash, then the home row, then the bottom row.
 *
 * These are **not** a stock-driver list, and nothing in the binary names them:
 * the stock tab reaches them by capturing a keypress, so pressing Shift+1 there
 * stores exactly what a button here does — a `0x10` record with the Shift bit in
 * its modifier byte and the *unshifted* key's usage in its code byte
 * (`10 02 1e`). There is no such thing as a HID usage for "!"; the shift is the
 * modifier, and the OS is what turns the pair into a character.
 *
 * Which character it turns into is therefore the **host's** business, not the
 * board's. The legends below are the US layout's, because that is the layout
 * this board is printed for; on a keyboard layout that puts something else on
 * Shift+2, the board still sends `10 02 1f` and the host still decides. The
 * picker shows the record's bytes beside the name for exactly this reason.
 */
export const SHIFTED_KEYS: BindingChoice[] = [
  shifted('~', 0x35),
  shifted('!', 0x1e),
  shifted('@', 0x1f),
  shifted('#', 0x20),
  shifted('$', 0x21),
  shifted('%', 0x22),
  shifted('^', 0x23),
  shifted('&', 0x24),
  shifted('*', 0x25),
  shifted('(', 0x26),
  shifted(')', 0x27),
  shifted('_', 0x2d),
  shifted('+', 0x2e),
  shifted('{', 0x2f),
  shifted('}', 0x30),
  shifted('|', 0x31),
  shifted(':', 0x33),
  shifted('"', 0x34),
  shifted('<', 0x36),
  shifted('>', 0x37),
  shifted('?', 0x38),
]

const action = (label: string, code: number, arg = 0): BindingChoice => ({
  label,
  binding: { kind: 'action', code, arg },
})

/**
 * The stock driver's "Function" list (0x415180-0x41545c), minus the layers,
 * plus the calibration reset the factory Fn layer binds and the driver's list
 * leaves out.
 *
 * The names are the driver's. What the firmware does for "Lock" (0x01) and
 * "Reset" (0x08) was not read out of the handler branch by branch, so they are
 * repeated rather than explained.
 */
export const SYSTEM_SECTIONS: BindingSection[] = [
  section('keymap.section.input', [
    action('Lock', ACTION.lock),
    action('WinLock', ACTION.winLock),
    action('WASD Change', ACTION.wasdSwap),
  ]),
  /* The ones that stop the keyboard being a keyboard for a moment. */
  section('keymap.section.board', [
    action('Boot', ACTION.boot),
    action('Reset', ACTION.reset),
    action('Calibration Reset', ACTION.calibrationReset),
  ]),
]

export const SYSTEM_ACTIONS: BindingChoice[] = SYSTEM_SECTIONS.flatMap((s) => s.choices)

/**
 * Momentary layer keys. The stock driver offers FN1-FN7; this board has two
 * layers, so only FN1 leads anywhere and the rest are left out rather than
 * offered as keys that would make another block be read as a keymap.
 */
export function layerKeys(layers: number): BindingChoice[] {
  return Array.from({ length: Math.max(0, layers - 1) }, (_, i) =>
    action(`FN${i + 1}`, ACTION.momentaryLayer, i + 1),
  )
}

/** The list for a two-layer board, i.e. the family default. */
export const LAYER_KEYS: BindingChoice[] = layerKeys(KEYMAP_BLOCK.layers)

/**
 * The stock driver's "Lighting" list (0x41545c-0x4157f5). The firmware decodes
 * these in the same 0x812c handler as the system actions.
 */
export const LIGHT_SECTIONS: BindingSection[] = [
  section('keymap.section.mode', [
    action('RGB Mode-', 0x2e),
    action('RGB Mode+', 0x2f),
    action('RGB Mode', 0x30),
    action('RGB Test', 0x31),
  ]),
  section('keymap.section.brightness', [
    action('Bright+', 0x32),
    action('Bright-', 0x33),
    action('Bright', 0x34),
    action('Bright Off', 0x35),
  ]),
  section('keymap.section.speed', [
    action('Speed+', 0x36),
    action('Speed-', 0x37),
    action('Speed', 0x38),
  ]),
  section('keymap.section.direction', [
    action('Light Left', 0x39),
    action('Light Right', 0x3a),
    action('Light Trend', 0x3b),
  ]),
  section('keymap.section.color', [
    action('Color +', 0x3c),
    action('Color -', 0x3d),
    action('Color', 0x3e),
  ]),
]

export const LIGHT_ACTIONS: BindingChoice[] = LIGHT_SECTIONS.flatMap((s) => s.choices)

/**
 * The stock driver's "Mouse" list (0x4158c7-0x415aee), whose eight items its
 * encoder turns into five button masks, a double click and two wheel steps.
 */
export const MOUSE_SECTIONS: BindingSection[] = [
  section('keymap.section.buttons', [
  {
    label: 'Left Click',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.left, doubleClick: false },
  },
  {
    label: 'Middle Click',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.middle, doubleClick: false },
  },
  {
    label: 'Right Click',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.right, doubleClick: false },
  },
  {
    label: 'Double Click',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.left, doubleClick: true },
  },
  {
    label: 'Forward',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.forward, doubleClick: false },
  },
  {
    label: 'Backward',
    binding: { kind: 'mouseButton', buttons: MOUSE_BUTTONS.back, doubleClick: false },
  },
  ]),
  section('keymap.section.wheel', [
    { label: 'Scroll Up', binding: { kind: 'mouseWheel', delta: 1 } },
    { label: 'Scroll Down', binding: { kind: 'mouseWheel', delta: -1 } },
  ]),
]

export const MOUSE_ACTIONS: BindingChoice[] = MOUSE_SECTIONS.flatMap((s) => s.choices)

/**
 * Everything the picker offers beyond the plain keyboard usages.
 *
 * Takes the layer count because the momentary-layer keys depend on it: a board
 * with more layers gets more FN keys, and offering an FN that leads nowhere is
 * how a keymap ends up pointing at another block.
 */
export function bindingGroups(layers: number = KEYMAP_BLOCK.layers): BindingGroup[] {
  return [
    // One set, so no header: every one of these is Shift and a key.
    { nameKey: 'keymap.group.symbols', sections: [{ choices: SHIFTED_KEYS }] },
    { nameKey: 'keymap.group.multimedia', sections: CONSUMER_SECTIONS },
    { nameKey: 'keymap.group.special', sections: EXTRA_SECTIONS },
    {
      nameKey: 'keymap.group.function',
      // The layer keys lead this group: on a two-layer board FN1 is the one
      // entry here that is used every day, and the rest are once-ever settings.
      sections: [
        { nameKey: 'keymap.section.layer', choices: layerKeys(layers) },
        ...SYSTEM_SECTIONS,
      ],
    },
    { nameKey: 'keymap.group.lighting', sections: LIGHT_SECTIONS },
    { nameKey: 'keymap.group.mouse', sections: MOUSE_SECTIONS },
  ]
}

/** The groups for a two-layer board. Used for the label map below. */
export const BINDING_GROUPS: BindingGroup[] = bindingGroups()

const CHOICE_LABELS = new Map<string, string>()
for (const group of BINDING_GROUPS) {
  for (const choice of groupChoices(group)) {
    const bytes = encodeRecord(choice.binding).join(',')
    if (!CHOICE_LABELS.has(bytes)) CHOICE_LABELS.set(bytes, choice.label)
  }
}

function modifierPrefix(mask: number): string {
  return MODIFIERS.filter((m) => (mask & m.bit) !== 0)
    .map((m) => m.label)
    .join('+')
}

/**
 * What a cap should read.
 *
 * `keyLabel` is the caller's HID-usage legend — keycodes.ts owns that table and
 * this module does not duplicate it. A record with no name falls back to its
 * bytes rather than to a blank, which is the only honest thing to show for one
 * this app does not understand.
 */
export function bindingLabel(binding: KeyBinding, keyLabel: (usage: number) => string): string {
  switch (binding.kind) {
    case 'none': {
      /*
       * Two different things decode to `none`, and only one of them has a name.
       *
       * `10 00 00` is a key record with no usage: a deliberate "this key sends
       * nothing", which is what the stock encoder writes for macro_type 1 and
       * what the picker offers as `KC_NO`. Naming it is the only way a read can
       * show that the setting took — a dash there is indistinguishable from a
       * slot nobody ever wrote.
       *
       * `0x00` and `0xff` are the other thing: a slot that was never set, which
       * is most of the Fn layer straight from the factory. There is no name to
       * put on that, so it stays a dash.
       */
      if (binding.raw !== RECORD_TYPE.key) return '—'
      return CHOICE_LABELS.get(encodeRecord(binding).join(',')) ?? '—'
    }
    case 'key': {
      const prefix = modifierPrefix(binding.modifiers)
      if (binding.usage === 0) return prefix || '—'
      // The catalog first, because it names records the caller's table cannot:
      // F13-F24 and the international keys are in `EXTRA_KEYS` and nowhere else,
      // and a cap showing `0x68` for F13 is the shape of a key that looks broken.
      // The whole record is looked up before the bare usage, so Shift+1 reads as
      // `!` rather than as `LShift+1` — see SHIFTED_KEYS.
      const whole = CHOICE_LABELS.get(encodeRecord(binding).join(','))
      if (whole) return whole
      const named = CHOICE_LABELS.get(`${RECORD_TYPE.key},0,${binding.usage}`)
      const label = named ?? keyLabel(binding.usage)
      return prefix ? `${prefix}+${label}` : label
    }
    case 'macro':
      return t('keymap.label.macro', { slot: binding.slot })
    case 'advanced':
      return t('keymap.label.advanced', { record: binding.record })
    case 'unknown':
      return binding.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    default: {
      const named = CHOICE_LABELS.get(encodeRecord(binding).join(','))
      if (named) return named
      if (binding.kind === 'action') {
        return binding.code === ACTION.momentaryLayer
          ? t('keymap.label.momentary', { layer: binding.arg })
          : t('keymap.label.action', { code: binding.code.toString(16).padStart(2, '0') })
      }
      return encodeRecord(binding)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
    }
  }
}
