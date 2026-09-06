/**
 * Decoding analog events for whichever board is attached.
 *
 * `parseKeyEvent` in frame.ts takes the field layout as an argument, which is
 * right for the engine and awkward for a panel that just wants to render what
 * arrived. These two read the active spec so a component does not have to
 * thread it through — and so a board with a different event layout is decoded
 * correctly by panels that never mention it.
 */

import { activeSpec } from '../device/active'
import { isEvent, parseKeyEvent, type KeyEvent } from './frame'

/** Decodes one payload, or null when it is not an analog event. */
export function parseActiveEvent(payload: ArrayLike<number>): KeyEvent | null {
  const spec = activeSpec()
  return parseKeyEvent(payload, spec.event, spec.frame, spec.encoding.countsPerMm)
}

/** True for an unsolicited report, decoded or not. */
export function isActiveEvent(payload: ArrayLike<number>): boolean {
  return isEvent(payload, activeSpec().frame)
}
