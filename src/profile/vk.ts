/**
 * Windows virtual keys to HID usages, for the one place a stock profile uses
 * them: `macro_info > record_item > item@value`.
 *
 * ## Why this table exists at all
 *
 * Every other key field in a stock profile is a HID usage — `perf_info`,
 * `key_info`, `key_light` all index by the same number the layout file does.
 * Macro records are the exception: the stock recorder captures keystrokes
 * through the Windows message loop, stores what it caught, and converts on the
 * way to the board (`0x45d240`, see docs/protocol.md §1.1). So a macro body in
 * the file is in a different key space from the rest of the file, and reading
 * one without this table produces a macro that types the wrong letters.
 *
 * ## How far it is confirmed
 *
 * The letters are confirmed against both sample profiles — `Q` is 81, which is
 * `VK_Q` and not usage 0x14. The rest is the standard Windows table restricted
 * to what the driver's own converter produces (docs §, "`0x45d240` 이 만들어
 * 내는 usage"): A–Z, the digit row, punctuation, F1–F24, editing and arrows,
 * the numeric keypad, NUBS, Menu and the eight modifiers. Nothing outside that
 * set is here, because a usage the driver cannot capture is one no stock macro
 * can contain.
 *
 * Unmapped either way returns `undefined` rather than a guess. The caller
 * reports the record as one it could not convert; it does not invent a key.
 */

/** `[vk, usage]`, in VK order. */
const PAIRS: readonly (readonly [number, number])[] = [
  [0x08, 0x2a], // Backspace
  [0x09, 0x2b], // Tab
  [0x0d, 0x28], // Enter
  [0x13, 0x48], // Pause
  [0x14, 0x39], // Caps Lock
  [0x1b, 0x29], // Esc
  [0x20, 0x2c], // Space
  [0x21, 0x4b], // Page Up
  [0x22, 0x4e], // Page Down
  [0x23, 0x4d], // End
  [0x24, 0x4a], // Home
  [0x25, 0x50], // Left
  [0x26, 0x52], // Up
  [0x27, 0x4f], // Right
  [0x28, 0x51], // Down
  [0x2c, 0x46], // Print Screen
  [0x2d, 0x49], // Insert
  [0x2e, 0x4c], // Delete
  [0x30, 0x27], // 0 — the digit row wraps, 0 sits after 9
  [0x5b, 0xe3], // Left Win
  [0x5c, 0xe7], // Right Win
  [0x5d, 0x65], // Menu
  [0x6a, 0x55], // Num *
  [0x6b, 0x57], // Num +
  [0x6d, 0x56], // Num -
  [0x6e, 0x63], // Num .
  [0x6f, 0x54], // Num /
  [0x90, 0x53], // Num Lock
  [0x91, 0x47], // Scroll Lock
  [0xa0, 0xe1], // Left Shift
  [0xa1, 0xe5], // Right Shift
  [0xa2, 0xe0], // Left Ctrl
  [0xa3, 0xe4], // Right Ctrl
  [0xa4, 0xe2], // Left Alt
  [0xa5, 0xe6], // Right Alt
  [0xba, 0x33], // ;
  [0xbb, 0x2e], // =
  [0xbc, 0x36], // ,
  [0xbd, 0x2d], // -
  [0xbe, 0x37], // .
  [0xbf, 0x38], // /
  [0xc0, 0x35], // `
  [0xdb, 0x2f], // [
  [0xdc, 0x31], // backslash
  [0xdd, 0x30], // ]
  [0xde, 0x34], // '
  [0xe2, 0x64], // NUBS
]

const TO_USAGE = new Map<number, number>(PAIRS.map(([vk, usage]) => [vk, usage]))
const TO_VK = new Map<number, number>(PAIRS.map(([vk, usage]) => [usage, vk]))

/** Adds a contiguous run to both directions. */
function run(vkStart: number, usageStart: number, count: number): void {
  for (let i = 0; i < count; i++) {
    TO_USAGE.set(vkStart + i, usageStart + i)
    TO_VK.set(usageStart + i, vkStart + i)
  }
}

run(0x31, 0x1e, 9) // 1-9. VK_0 is out of line and is in PAIRS above.
run(0x41, 0x04, 26) // A-Z
run(0x61, 0x59, 9) // Num 1-9. VK_NUMPAD0 is out of line, like the digit row's.
run(0x70, 0x3a, 12) // F1-F12
run(0x7c, 0x68, 12) // F13-F24
TO_USAGE.set(0x60, 0x62) // Num 0
TO_VK.set(0x62, 0x60)

/*
 * The generic modifiers, which the message loop reports when nothing has asked
 * it to tell the sides apart. They resolve to the left-hand usage, and the
 * reverse direction is not touched — a usage always maps back to the side it
 * names, never to the generic key.
 */
TO_USAGE.set(0x10, 0xe1) // VK_SHIFT
TO_USAGE.set(0x11, 0xe0) // VK_CONTROL
TO_USAGE.set(0x12, 0xe2) // VK_MENU

/** The HID usage a stock macro record's `value` means, or undefined. */
export function usageForVk(vk: number): number | undefined {
  return TO_USAGE.get(vk)
}

/** The `value` a stock macro record needs for this usage, or undefined. */
export function vkForUsage(usage: number): number | undefined {
  return TO_VK.get(usage)
}
