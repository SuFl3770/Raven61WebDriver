import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Where a tab's key grid goes: the strip below the title, which does not
 * scroll.
 *
 * A tab is a title, a keyboard, a row of sections and then panels — and the
 * panels are the only part of it that is ever long. Letting the whole column
 * scroll took the grid off the top of the screen the moment anyone read past
 * the first panel, which is exactly when they most need it: every setting
 * below is about the keys that are picked in it. So the grid is lifted out of
 * the scrolling part of the tab and into a band above it, the way the title
 * already is.
 *
 * The same trick as ui/TabActions.tsx, and for the same reason — the element
 * has to sit above something that is several levels above where it is
 * declared, and no amount of CSS will lift a child out of the box it is in.
 * App.tsx keeps an empty element there and whatever wants the band renders
 * into it from wherever it lives.
 *
 * Not the sub-tab strip, which stays where it is written: it is the first
 * thing in the scrolling part and `position: sticky` is enough to hold it —
 * see `.subtabs` in styles.css. Sticky cannot do the same for the grid,
 * because a grid pinned to the top of the scroller would still be scrolled
 * *through* on the way there, and it is far too tall to be worth that.
 */
const SlotContext = createContext<HTMLElement | null>(null)

export const TabPinnedSlot = SlotContext.Provider

/**
 * Renders its children into the band above the tab's panels.
 *
 * Nothing until the slot exists, which is one render — see `TabActions`, which
 * has the same first-paint gap for the same reason.
 */
export function TabPinned({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext)
  return slot ? createPortal(children, slot) : null
}
