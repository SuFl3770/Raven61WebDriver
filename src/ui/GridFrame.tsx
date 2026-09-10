import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { selection, useSelection } from '../state/selection'
import { Marquee } from './Marquee'
import { TabActions } from './TabActions'

/**
 * The key grid with its controls above it and its readouts below.
 *
 * Both were a column beside the grid, which is where they went when they were
 * a bar across the top — the reasoning then was that a bar pushed the keyboard
 * down the page. What it actually cost was width: the grid is the widest thing
 * in the app and it was giving up a fixed column of it on every tab that draws
 * one, on both sides of a window that is often not wide enough for either. So
 * the controls are a row again, the grid has the panel to itself, and what the
 * column used to say underneath its buttons is one centred line under the
 * caps it is counting.
 *
 * The frame owns the marquee band as well, so the three tabs that draw a grid
 * describe it the same way rather than each assembling the wrapper themselves.
 */
export function GridFrame({
  selectable = true,
  marquee = false,
  top,
  foot,
  children,
}: {
  /**
   * Whether this grid has a selection to act on.
   *
   * False while something else owns it — a calibration pass, where the caps
   * mirror the board's LEDs, and the two tabs that pick one key rather than a
   * set. The controls go rather than being disabled: a greyed "select all"
   * invites a click that would do nothing visible.
   */
  selectable?: boolean
  /** Whether a drag in the band draws a rubber band — see ui/Marquee.tsx. */
  marquee?: boolean
  /** The owner's controls, beside the selection's in the tab's title row. */
  top?: ReactNode
  /** The owner's readouts, beside the selection count in the line below it. */
  foot?: ReactNode
  /** The grid. */
  children: ReactNode
}) {
  const sel = useSelection()
  const t = useT()

  // Nothing to put in a bar means no bar: an empty row would still take its
  // gap, and leave the grid sitting lower than it does on the tab next door.
  const hasTop = selectable || top
  const hasFoot = selectable || foot

  return (
    <Marquee className="gridband" disabled={!marquee}>
      {hasTop && (
        <TabActions>
          {selectable && (
            <>
              <button onClick={() => selection.selectAll()}>{t('selection.selectAll')}</button>
              <button onClick={() => selection.invert()}>{t('selection.invert')}</button>
              <button onClick={() => selection.clear()}>{t('selection.clear')}</button>
            </>
          )}
          {/*
            Only with something on both sides of it. The three above act on
            what is picked in the grid; whatever the tab put here acts on the
            grid itself, and they are near enough in shape to be worth telling
            apart.
          */}
          {selectable && top && <hr className="sep" />}
          {top}
        </TabActions>
      )}

      {children}

      {hasFoot && (
        <div className="gridfoot">
          {selectable && (
            <span>
              {sel.size === 0 ? t('selection.none') : t('selection.count', { count: sel.size })}
            </span>
          )}
          {foot}
        </div>
      )}
    </Marquee>
  )
}
