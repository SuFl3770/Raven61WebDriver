/**
 * HID Keyboard/Keypad (usage page 0x07) codes, and the full-size keyboard the
 * picker draws them as.
 *
 * These are the USB standard usages, and the board stores them as themselves: a
 * `0x10` keymap record carries the usage in its third byte and the firmware puts
 * it straight into the report (0x8f6c). See protocol/keymap.ts.
 *
 * Which usages are here is not the whole page — it is what the stock driver can
 * produce, which is its keystroke capture's conversion table at 0x45d240 (a
 * Windows virtual key to a usage) crossed with its own name table at 0x45da20.
 * Anything past that lives in `EXTRA_KEYS` in protocol/keymap.ts, which is the
 * driver's "Special" list.
 *
 * Cap legends (`A`, `Enter`, `LCtrl`, `→`) are the same in every language and
 * stay literal here. Only the handful of entries that are words rather than
 * legends carry a message key.
 */
import { t, type MessageKey } from '../i18n'

export interface KeycodeDef {
  code: number
  label?: string
  labelKey?: MessageKey
}

/** The legend to show for one entry, in the language in effect right now. */
export function keycodeDefLabel(def: KeycodeDef): string {
  return def.labelKey ? t(def.labelKey) : (def.label ?? '')
}

const range = (start: number, labels: string[]): KeycodeDef[] =>
  labels.map((label, i) => ({ code: start + i, label }))

/**
 * Every usage this app names, in table order: letters, digits and symbols, the
 * function row, editing and navigation, the numeric keypad, the modifiers, and
 * the three that are not keys at all.
 *
 * A flat list rather than named groups. It used to be grouped, because the
 * picker drew it as a list of groups; the picker now draws a keyboard
 * (`KEYBOARD_ROWS`), and the only thing left that walks this is code that wants
 * "every key, once" — the advanced-key panel's dropdown and `keycodeLabel`.
 */
export const KEYCODES: KeycodeDef[] = [
  ...range(0x04, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  ...range(0x1e, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
  ...range(0x28, ['Enter', 'Esc', 'Bksp', 'Tab', 'Space', '-', '=', '[', ']', '\\']),
  ...range(0x33, [';', "'", '`', ',', '.', '/']),
  { code: 0x39, label: 'Caps' },
  ...range(0x3a, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']),
  ...range(0x46, ['PrtSc', 'ScrLk', 'Pause', 'Ins', 'Home', 'PgUp', 'Del', 'End', 'PgDn']),
  ...range(0x4f, ['→', '←', '↓', '↑']),
  { code: 0x65, label: 'Menu' },
  /*
   * The numeric keypad, which a 61-key board has no caps for and which is
   * exactly the block this picker was missing.
   *
   * It is not a guess at the HID page: the stock driver's keystroke capture
   * turns VK_NUMLOCK and VK_NUMPAD0-9 into 0x53 and 0x59-0x63 (0x45d240), and
   * its own name table spells 0x53-0x61 out as "Num Lock" through "Num 9"
   * (0x45da20). The two names below that the driver leaves blank — keypad 0 and
   * the decimal point — it still *produces*, so they are named here in the same
   * shape rather than left out for the sake of the table's own gap.
   *
   * These are the long names, which is what a label away from the keyboard has
   * to say: "Num 7" in a dropdown, where "7" would be the digit row's. On the
   * keyboard below the cap says `7`, because there the position is the name.
   */
  ...range(0x53, ['Num Lock', 'Num /', 'Num *', 'Num -', 'Num +', 'Num Enter']),
  ...range(0x59, ['Num 1', 'Num 2', 'Num 3', 'Num 4', 'Num 5', 'Num 6', 'Num 7', 'Num 8']),
  ...range(0x61, ['Num 9', 'Num 0', 'Num .']),
  ...range(0xe0, ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin']),
  { code: 0x00, labelKey: 'keycode.none' },
  { code: 0x01, labelKey: 'keycode.error' },
  // The stock layout marks Fn as 0xff; it has no HID usage of its own.
  { code: 0xff, label: 'Fn' },
]

const BY_CODE = new Map<number, KeycodeDef>()
for (const c of KEYCODES) if (!BY_CODE.has(c.code)) BY_CODE.set(c.code, c)

export function keycodeLabel(code: number): string {
  const def = BY_CODE.get(code)
  return def ? keycodeDefLabel(def) : `0x${code.toString(16).padStart(2, '0')}`
}

/** One cap of the picker's keyboard, or a gap between blocks. */
export type KeyboardSlot =
  | {
      code: number
      /** Width in key units. 1 unless said otherwise. */
      u?: number
      /**
       * What the cap reads, when the position already says which key it is.
       * The keypad's caps are `7` and `/`, the way they are moulded; hover and
       * the readout under the grid give the long name from `keycodeLabel`.
       */
      cap?: string
    }
  | { gap: number }

/**
 * The picker's keyboard: a full-size 104-key ANSI board, row by row.
 *
 * Drawn instead of a list of groups because that is how the key is found. A
 * remap is "make *this* key send Home", and the hand knows where Home is — in
 * an alphabetical list it is somewhere in the middle of nine editing keys, and
 * on a keyboard it is where it has always been. The board in front of the user
 * is 61 keys; this is 104, and that is the point: the keys worth remapping to
 * are mostly the ones their keyboard does not have.
 *
 * Every row is 22.5u wide — the main block's 15u, the navigation block's 3u and
 * the keypad's 4u, with a quarter unit between them — so the rows line up
 * whatever the width on screen. The keypad is drawn flat, one unit per key: its
 * `+` and `Enter` are two units tall on a real board, and a picker gains
 * nothing from the two cells that would have to be skipped to say so.
 */
export const KEYBOARD_ROWS: KeyboardSlot[][] = [
  [
    { code: 0x29 }, // Esc
    { gap: 1 },
    { code: 0x3a },
    { code: 0x3b },
    { code: 0x3c },
    { code: 0x3d },
    { gap: 0.5 },
    { code: 0x3e },
    { code: 0x3f },
    { code: 0x40 },
    { code: 0x41 },
    { gap: 0.5 },
    { code: 0x42 },
    { code: 0x43 },
    { code: 0x44 },
    { code: 0x45 },
    { gap: 0.25 },
    { code: 0x46 }, // PrtSc
    { code: 0x47 },
    { code: 0x48 },
    { gap: 4.25 }, // the keypad's rows start one down
  ],
  [
    { code: 0x35 }, // `
    { code: 0x1e },
    { code: 0x1f },
    { code: 0x20 },
    { code: 0x21 },
    { code: 0x22 },
    { code: 0x23 },
    { code: 0x24 },
    { code: 0x25 },
    { code: 0x26 },
    { code: 0x27 },
    { code: 0x2d },
    { code: 0x2e },
    { code: 0x2a, u: 2 }, // Bksp
    { gap: 0.25 },
    { code: 0x49 }, // Ins
    { code: 0x4a },
    { code: 0x4b },
    { gap: 0.25 },
    { code: 0x53, cap: 'NumLk' },
    { code: 0x54, cap: '/' },
    { code: 0x55, cap: '*' },
    { code: 0x56, cap: '-' },
  ],
  [
    { code: 0x2b, u: 1.5 }, // Tab
    { code: 0x14 },
    { code: 0x1a },
    { code: 0x08 },
    { code: 0x15 },
    { code: 0x17 },
    { code: 0x1c },
    { code: 0x18 },
    { code: 0x0c },
    { code: 0x12 },
    { code: 0x13 },
    { code: 0x2f },
    { code: 0x30 },
    { code: 0x31, u: 1.5 }, // backslash
    { gap: 0.25 },
    { code: 0x4c }, // Del
    { code: 0x4d },
    { code: 0x4e },
    { gap: 0.25 },
    { code: 0x5f, cap: '7' },
    { code: 0x60, cap: '8' },
    { code: 0x61, cap: '9' },
    { code: 0x57, cap: '+' },
  ],
  [
    { code: 0x39, u: 1.75 }, // Caps
    { code: 0x04 },
    { code: 0x16 },
    { code: 0x07 },
    { code: 0x09 },
    { code: 0x0a },
    { code: 0x0b },
    { code: 0x0d },
    { code: 0x0e },
    { code: 0x0f },
    { code: 0x33 },
    { code: 0x34 },
    { code: 0x28, u: 2.25 }, // Enter
    { gap: 3.5 }, // no navigation keys on this row
    { code: 0x5c, cap: '4' },
    { code: 0x5d, cap: '5' },
    { code: 0x5e, cap: '6' },
    { gap: 1 },
  ],
  [
    { code: 0xe1, u: 2.25 }, // LShift
    { code: 0x1d },
    { code: 0x1b },
    { code: 0x06 },
    { code: 0x19 },
    { code: 0x05 },
    { code: 0x11 },
    { code: 0x10 },
    { code: 0x36 },
    { code: 0x37 },
    { code: 0x38 },
    { code: 0xe5, u: 2.75 }, // RShift
    { gap: 1.25 },
    { code: 0x52 }, // up
    { gap: 1.25 },
    { code: 0x59, cap: '1' },
    { code: 0x5a, cap: '2' },
    { code: 0x5b, cap: '3' },
    { code: 0x58, cap: 'Enter' },
  ],
  [
    { code: 0xe0, u: 1.25 }, // LCtrl
    { code: 0xe3, u: 1.25 },
    { code: 0xe2, u: 1.25 },
    { code: 0x2c, u: 6.25 }, // Space
    { code: 0xe6, u: 1.25 },
    { code: 0xe7, u: 1.25 },
    { code: 0x65, u: 1.25 }, // Menu
    { code: 0xe4, u: 1.25 }, // RCtrl
    { gap: 0.25 },
    { code: 0x50 }, // left
    { code: 0x51 },
    { code: 0x4f },
    { gap: 0.25 },
    { code: 0x62, u: 2, cap: '0' },
    { code: 0x63, cap: '.' },
    { gap: 1 },
  ],
]
