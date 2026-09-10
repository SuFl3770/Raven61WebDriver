/**
 * The board's own lookup tables — which switches it reports, and which report
 * rates it accepts.
 *
 * These used to be constants in `protocol/types.ts`, which was fine while
 * there was one board: a switch list is a property of a keyboard, not of a
 * protocol, and a second board with a different switch selection would have
 * shown the first one's names. They read the active spec instead.
 *
 * Every one of them is safe to call during a render: `activeSpec` is a plain
 * getter, and a change to it re-renders through `useDeviceSpec`.
 */

import { t } from '../i18n'
import type { ReportRateSpec, SwitchTypeSpec } from './spec'
import { activeSpec } from './active'

export function switchTypes(): readonly SwitchTypeSpec[] {
  return activeSpec().switchTypes
}

/** The types a user may actually assign. See `SwitchTypeSpec.selectable`. */
export function selectableSwitchTypes(): readonly SwitchTypeSpec[] {
  return switchTypes().filter((s) => s.selectable)
}

/**
 * What to paint for a switch: its colour, or the hatch that means "no colour on
 * file".
 *
 * A CSS background rather than a colour, because the second case is a gradient
 * — `--hatch`, defined once in the stylesheet. Three places show a switch as a
 * colour (the band on a cap, the edge of a card, the swatch beside a name) and
 * all three have to agree about what an empty field looks like, or an unfilled
 * colour starts reading as a dark grey switch.
 */
export function switchColor(value: number | undefined): string {
  return switchTypeInfo(value)?.color ?? 'var(--hatch)'
}

export function switchTypeInfo(value: number | undefined): SwitchTypeSpec | undefined {
  return value === undefined ? undefined : switchTypes().find((s) => s.value === value)
}

/** Never invents a name: a value the board's table has no entry for shows as itself. */
export function switchTypeName(value: number | undefined): string {
  if (value === undefined) return '—'
  return switchTypeInfo(value)?.name ?? t('protocol.switchType.unknown', { value })
}

/**
 * Full travel for a key, in mm.
 *
 * The switch type wins when the board reported one this table knows, and the
 * layout's nominal travel is the fallback. Both are needed: a board can report
 * a switch type that is not in its own list, and a key that has never been
 * read has no switch type at all.
 */
export function travelMmFor(switchType: number | undefined): number {
  return switchTypeInfo(switchType)?.travelMm ?? activeSpec().layout.travelMm
}

export function reportRates(): readonly ReportRateSpec[] {
  return activeSpec().reportRates
}

export function reportRateInfo(value: number | undefined): ReportRateSpec | undefined {
  return value === undefined ? undefined : reportRates().find((r) => r.value === value)
}

/** Never invents a rate: a value outside the board's table is shown as itself. */
export function reportRateName(value: number | undefined): string {
  if (value === undefined) return '—'
  const info = reportRateInfo(value)
  return info ? t('board.rate.hz', { hz: info.hz }) : t('board.rate.unknown', { value })
}
