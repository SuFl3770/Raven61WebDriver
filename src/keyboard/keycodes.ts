/**
 * HID Keyboard/Keypad (usage page 0x07) codes, grouped for the picker.
 *
 * These are the USB standard usages. Whether the Raven61 firmware stores
 * keymaps as raw usages or as its own action ids is unknown until the keymap
 * command is decoded — see docs/protocol.md.
 */
export interface KeycodeDef {
  code: number
  label: string
}

export interface KeycodeGroup {
  name: string
  codes: KeycodeDef[]
}

const range = (start: number, labels: string[]): KeycodeDef[] =>
  labels.map((label, i) => ({ code: start + i, label }))

export const KEYCODE_GROUPS: KeycodeGroup[] = [
  {
    name: '문자',
    codes: range(0x04, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  },
  {
    name: '숫자 · 기호',
    codes: [
      ...range(0x1e, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
      ...range(0x28, ['Enter', 'Esc', 'Bksp', 'Tab', 'Space', '-', '=', '[', ']', '\\']),
      ...range(0x33, [';', "'", '`', ',', '.', '/']),
      { code: 0x39, label: 'Caps' },
    ],
  },
  {
    name: '기능키',
    codes: range(0x3a, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']),
  },
  {
    name: '편집 · 이동',
    codes: [
      ...range(0x46, ['PrtSc', 'ScrLk', 'Pause', 'Ins', 'Home', 'PgUp', 'Del', 'End', 'PgDn']),
      ...range(0x4f, ['→', '←', '↓', '↑']),
      { code: 0x65, label: 'Menu' },
    ],
  },
  {
    name: '수정자',
    codes: range(0xe0, ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin']),
  },
  {
    name: '특수',
    codes: [
      { code: 0x00, label: '없음' },
      { code: 0x01, label: '오류' },
      // The stock layout marks Fn as 0xff; it has no HID usage of its own.
      { code: 0xff, label: 'Fn' },
    ],
  },
]

const BY_CODE = new Map<number, string>()
for (const g of KEYCODE_GROUPS) for (const c of g.codes) if (!BY_CODE.has(c.code)) BY_CODE.set(c.code, c.label)

export function keycodeLabel(code: number): string {
  return BY_CODE.get(code) ?? `0x${code.toString(16).padStart(2, '0')}`
}
