import { GridFrame } from './GridFrame'
import { KeyGrid } from './KeyGrid'

/**
 * The board, on a tab that has nothing to do with it yet.
 *
 * The tabs that are only holding their place used to be a lone notice on an
 * otherwise blank page, which made switching to one feel like leaving the app:
 * every neighbouring tab opens with the keyboard at the top, and these dropped
 * it. Drawing the same grid keeps the page in the same shape whichever tab is
 * open, and gives whatever gets built here later the layout it will be built
 * into.
 *
 * `selectable={false}`, so the frame draws the caps and nothing else — no
 * select-all, no selection count. There is no setting on these tabs for a
 * selection to act on, and the selection store is shared across tabs, so
 * painting caps here would silently change what the input-point tab is
 * pointing at. The caps still hover and still carry their legends, which is
 * the whole of what a placeholder can honestly offer.
 */
export function PlaceholderGrid() {
  return (
    <GridFrame selectable={false}>
      <KeyGrid />
    </GridFrame>
  )
}
