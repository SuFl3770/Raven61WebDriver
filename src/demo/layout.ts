/**
 * The demo board's key table: ANSI tenkeyless, 87 keys, 18.25u x 6.5u.
 *
 * Written out here rather than generated, because there is no vendor file to
 * generate it from — this board does not exist. What it is instead is the
 * *ordinary* keyboard: a 60 % is the interesting case for a hall-effect board
 * and a poor one for showing the app, since half of what the panels do is
 * lost on someone who has to be told which keys are missing. A TKL has the
 * F-row, the navigation cluster and the arrows where a reader expects them.
 *
 * Positions are keyboard units from the top-left, with the F-row separated
 * from the number row by half a unit the way the physical board is. Codes are
 * the USB standard usages, which is also what `keyboard/hostKeys.ts` maps the host's
 * `KeyboardEvent.code` to — so every key here answers to the same key on the
 * reader's own keyboard.
 *
 * `keyIndex` and `lightIndex` are the table's own index. On a real board they
 * are the firmware's addressing and neither can be computed (see
 * `protocol/slotMap.ts`); here there is no firmware to disagree with, and
 * inventing a scramble would be inventing evidence.
 */

import type { KeyDef, LayoutSpec } from '../device/spec'

/** One entry of a row: a key, or a gap in units before the next one. */
type Cell = readonly [label: string, code: number, width?: number] | { readonly gap: number }

const ROWS: readonly { y: number; cells: readonly Cell[] }[] = [
  {
    y: 0,
    cells: [
      ['Esc', 41],
      { gap: 1 },
      ['F1', 58], ['F2', 59], ['F3', 60], ['F4', 61],
      { gap: 0.5 },
      ['F5', 62], ['F6', 63], ['F7', 64], ['F8', 65],
      { gap: 0.5 },
      ['F9', 66], ['F10', 67], ['F11', 68], ['F12', 69],
      { gap: 0.25 },
      ['PrtSc', 70], ['ScrLk', 71], ['Pause', 72],
    ],
  },
  {
    y: 1.15,
    cells: [
      ['`', 53],
      ['1', 30], ['2', 31], ['3', 32], ['4', 33], ['5', 34],
      ['6', 35], ['7', 36], ['8', 37], ['9', 38], ['0', 39],
      ['-', 45], ['=', 46], ['Backspace', 42, 2],
      { gap: 0.25 },
      ['Insert', 73], ['Home', 74], ['PgUp', 75],
    ],
  },
  {
    y: 2.15,
    cells: [
      ['Tab', 43, 1.5],
      ['Q', 20], ['W', 26], ['E', 8], ['R', 21], ['T', 23], ['Y', 28],
      ['U', 24], ['I', 12], ['O', 18], ['P', 19], ['[', 47], [']', 48],
      ['\\', 49, 1.5],
      { gap: 0.25 },
      ['Delete', 76], ['End', 77], ['PgDn', 78],
    ],
  },
  {
    y: 3.15,
    cells: [
      ['Caps', 57, 1.75],
      ['A', 4], ['S', 22], ['D', 7], ['F', 9], ['G', 10], ['H', 11],
      ['J', 13], ['K', 14], ['L', 15], [';', 51], ["'", 52],
      ['Enter', 40, 2.25],
    ],
  },
  {
    y: 4.15,
    cells: [
      ['Shift', 225, 2.25],
      ['Z', 29], ['X', 27], ['C', 6], ['V', 25], ['B', 5],
      ['N', 17], ['M', 16], [',', 54], ['.', 55], ['/', 56],
      ['Shift', 229, 2.75],
      // The arrow cluster is not flush with the row: Up sits alone above Down,
      // one unit in from the left edge of the cluster.
      { gap: 1.15 },
      ['↑', 82],
    ],
  },
  {
    y: 5.15,
    cells: [
      ['Ctrl', 224, 1.25], ['Win', 227, 1.25], ['Alt', 226, 1.25],
      ['Space', 44, 6.25],
      ['Alt', 230, 1.25], ['Win', 231, 1.25], ['Menu', 101, 1.25], ['Ctrl', 228, 1.25],
      { gap: 0.15 },
      ['←', 80], ['↓', 81], ['→', 79],
    ],
  },
]

function buildKeys(): KeyDef[] {
  const out: KeyDef[] = []
  for (const row of ROWS) {
    let x = 0
    for (const cell of row.cells) {
      if ('gap' in cell) {
        x += cell.gap
        continue
      }
      const [label, code, width = 1] = cell
      const index = out.length
      out.push({ index, label, code, x, y: row.y, w: width, keyIndex: index, lightIndex: index })
      x += width
    }
  }
  return out
}

export const DEMO_TKL_KEYS: readonly KeyDef[] = buildKeys()

export const DEMO_TKL_LAYOUT: LayoutSpec = {
  units: { width: 18.25, height: 6.5 },
  /** Nominal stroke, the same 4.00 mm the switch table's common types have. */
  travelMm: 4.0,
  keys: DEMO_TKL_KEYS,
}
