import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { selection, useSelection } from '../state/selection'

/**
 * The column of controls beside the key grid.
 *
 * It was a bar above the grid. Everything in it acts *on* the grid — select
 * all, clear, and the mode the grid is showing — so sitting above meant the
 * controls pushed the keyboard down the page and read in the wrong order.
 * Beside it, the grid stays put and the selection count sits next to the caps
 * it is counting.
 *
 * `children` is for controls that belong to whatever owns the grid rather than
 * to the selection itself — the input-point tab puts its calibration toggle
 * there, since entering that mode changes what the grid shows.
 */
export function SelectionBar({
  selectable = true,
  children,
}: {
  /**
   * False while something else owns the grid — a calibration pass, where the
   * caps mirror the board's LEDs and there is nothing to select for. The
   * controls go rather than being disabled: a greyed "select all" invites a
   * click that would do nothing visible.
   */
  selectable?: boolean
  children?: ReactNode
}) {
  const sel = useSelection()
  const t = useT()

  if (!selectable) return <div className="gridside">{children}</div>

  return (
    <div className="gridside">
      <div className="group">
        <button onClick={() => selection.selectAll()}>{t('selection.selectAll')}</button>
        <button onClick={() => selection.clear()}>{t('selection.clear')}</button>
      </div>
      <div className="small dim">
        {sel.size === 0 ? t('selection.none') : t('selection.count', { count: sel.size })}
        <div style={{ marginTop: 4 }}>{t('selection.hint')}</div>
      </div>
      {children && (
        <>
          <hr className="sep" />
          {children}
        </>
      )}
    </div>
  )
}
