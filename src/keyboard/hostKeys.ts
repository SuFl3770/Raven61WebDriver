/**
 * The host keyboard as a source of HID usages — `KeyboardEvent.code` to the
 * number the board would store.
 *
 * Two callers, for two different reasons, and both want the same table.
 *
 * The **demo board** has no switches, so the thing it reports travel for is the
 * keyboard the reader is already typing on: a `keydown` names a key by `code`,
 * this turns that into the usage the board would put in `payload[3]`, and the
 * layout resolves it to one of its keys. Any board's layout works, because the
 * table below is the USB standard rather than one keyboard's — a code this
 * board has no key for simply resolves to nothing and is dropped.
 *
 * The **macro recorder** wants it the other way round: a key the reader pressed
 * has to become a usage to store in a macro body, whether or not the board in
 * front of them has that key. A macro recorded on a full-size keyboard and
 * played back by a 61-key board is the normal case, not an edge one.
 *
 * That second caller is why this lives here rather than under `demo/`. It is a
 * fact about USB HID and about browsers, not about the fake board.
 *
 * Fn is deliberately absent. Browsers never report it: the key is consumed by
 * the keyboard's own firmware and no `code` reaches the page. On the demo board
 * it is covered by the idle sweep in `board.ts` instead.
 */

/** `KeyboardEvent.code` -> HID usage (page 0x07). */
const USAGE_BY_CODE: Record<string, number> = {
  // Letters. 'A' is 0x04 and the rest run in alphabetical order.
  ...letters(),
  Digit1: 30,
  Digit2: 31,
  Digit3: 32,
  Digit4: 33,
  Digit5: 34,
  Digit6: 35,
  Digit7: 36,
  Digit8: 37,
  Digit9: 38,
  Digit0: 39,
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  // Not on a 60 %, but a reader on a full-size keyboard should not have their
  // F-row silently swallowed by a board that does have one.
  F1: 58,
  F2: 59,
  F3: 60,
  F4: 61,
  F5: 62,
  F6: 63,
  F7: 64,
  F8: 65,
  F9: 66,
  F10: 67,
  F11: 68,
  F12: 69,
  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  ContextMenu: 101,
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  MetaLeft: 227,
  ControlRight: 228,
  ShiftRight: 229,
  AltRight: 230,
  MetaRight: 231,
}

function letters(): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 0; i < 26; i++) out[`Key${String.fromCharCode(65 + i)}`] = 4 + i
  return out
}

export function usageForCode(code: string): number | undefined {
  return USAGE_BY_CODE[code]
}

/** True for the eight usages HID carries in the modifier bitmask. */
export function isModifierUsage(usage: number): boolean {
  return usage >= 0xe0 && usage <= 0xe7
}

/** The bit `payload[2]` sets for a modifier usage. */
export function modifierBit(usage: number): number {
  return isModifierUsage(usage) ? 1 << (usage - 0xe0) : 0
}
