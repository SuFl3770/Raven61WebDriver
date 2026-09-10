import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Where a tab's controls go: the right-hand end of the row its title is on.
 *
 * The two are far apart in the tree — App.tsx draws the title above whatever
 * the tab renders, and the controls belong to a grid several levels down
 * inside one of its panels — and no amount of CSS will put a child of a panel
 * on a line above that panel's own border. So the title row keeps an empty
 * element on its right, and the controls are rendered into it from wherever
 * they are declared, which is next to the thing they act on.
 *
 * One slot, because a tab has one title. A second `TabActions` on the same tab
 * would render into the same element beside the first, which is a reasonable
 * thing for it to do but not a thing any tab does today.
 */
const SlotContext = createContext<HTMLElement | null>(null)

export const TabActionSlot = SlotContext.Provider

/**
 * Renders its children into the title row instead of where it sits.
 *
 * Nothing until the slot exists, which is the first render of a tab: App.tsx
 * learns the element from a ref, and a ref is only known once the DOM is
 * there. The state that follows is flushed before the browser paints, so the
 * gap is a render rather than a frame.
 */
export function TabActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext)
  return slot ? createPortal(children, slot) : null
}
