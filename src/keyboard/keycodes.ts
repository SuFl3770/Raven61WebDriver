/**
 * HID Keyboard/Keypad (usage page 0x07) codes, grouped for the picker.
 *
 * These are the USB standard usages. Whether the Raven61 firmware stores
 * keymaps as raw usages or as its own action ids is unknown until the keymap
 * command is decoded — see docs/protocol.md.
 *
 * Cap legends (`A`, `Enter`, `LCtrl`, `→`) are the same in every language and
 * stay literal here. Only the group names and the handful of entries that are
 * words rather than legends carry a message key.
 */
import { t, type MessageKey } from '../i18n'

export interface KeycodeDef {
  code: number
  label?: string
  labelKey?: MessageKey
}

export interface KeycodeGroup {
  nameKey: MessageKey
  codes: KeycodeDef[]
}

/** The legend to show for one entry, in the language in effect right now. */
export function keycodeDefLabel(def: KeycodeDef): string {
  return def.labelKey ? t(def.labelKey) : (def.label ?? '')
}

const range = (start: number, labels: string[]): KeycodeDef[] =>
  labels.map((label, i) => ({ code: start + i, label }))

export const KEYCODE_GROUPS: KeycodeGroup[] = [
  {
    nameKey: 'keycode.group.letters',
    codes: range(0x04, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  },
  {
    nameKey: 'keycode.group.digits',
    codes: [
      ...range(0x1e, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
      ...range(0x28, ['Enter', 'Esc', 'Bksp', 'Tab', 'Space', '-', '=', '[', ']', '\\']),
      ...range(0x33, [';', "'", '`', ',', '.', '/']),
      { code: 0x39, label: 'Caps' },
    ],
  },
  {
    nameKey: 'keycode.group.function',
    codes: range(0x3a, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']),
  },
  {
    nameKey: 'keycode.group.editing',
    codes: [
      ...range(0x46, ['PrtSc', 'ScrLk', 'Pause', 'Ins', 'Home', 'PgUp', 'Del', 'End', 'PgDn']),
      ...range(0x4f, ['→', '←', '↓', '↑']),
      { code: 0x65, label: 'Menu' },
    ],
  },
  {
    nameKey: 'keycode.group.modifiers',
    codes: range(0xe0, ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin']),
  },
  {
    nameKey: 'keycode.group.special',
    codes: [
      { code: 0x00, labelKey: 'keycode.none' },
      { code: 0x01, labelKey: 'keycode.error' },
      // The stock layout marks Fn as 0xff; it has no HID usage of its own.
      { code: 0xff, label: 'Fn' },
    ],
  },
]

const BY_CODE = new Map<number, KeycodeDef>()
for (const g of KEYCODE_GROUPS) for (const c of g.codes) if (!BY_CODE.has(c.code)) BY_CODE.set(c.code, c)

export function keycodeLabel(code: number): string {
  const def = BY_CODE.get(code)
  return def ? keycodeDefLabel(def) : `0x${code.toString(16).padStart(2, '0')}`
}
