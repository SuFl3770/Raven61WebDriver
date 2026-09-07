import { useState, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'

/**
 * Navigation for panels that belong to one tab but do not fit on one screen.
 *
 * Both tabs that use it grew the same way: a coherent group of settings that
 * ended up nine panels long, where finding anything meant scrolling past
 * everything. Splitting them into separate top-level tabs would say they are
 * unrelated, which is the opposite of true — the switch type rescales
 * actuation, and probing a command means watching the monitor.
 */
export interface SubTab {
  id: string
  labelKey: MessageKey
  /**
   * Overrides `labelKey` when the label cannot be a message key.
   *
   * A board's layers are the case: how many there are comes from its spec, and
   * the bundles cannot carry a name for a layer nobody knew about.
   */
  label?: string
  render: () => ReactNode
}

/**
 * Controlled: the parent owns which section is open, because what sits *above*
 * the strip may need to follow it — the input-point tab points its shared key
 * grid at whatever the open section edits.
 */
export function SubTabs({
  tabs,
  label,
  active,
  onActive,
}: {
  tabs: readonly SubTab[]
  /** Accessible name for the strip. */
  label: string
  active: string
  onActive: (id: string) => void
}) {
  const t = useT()
  const current = tabs.find((s) => s.id === active) ?? tabs[0]!

  /*
   * Which way the last move went, so the new section can come in from the side
   * it was on: forwards from the right, backwards from the left.
   *
   * Set on the click rather than worked out while rendering. The component is
   * controlled, so `active` and this land in the same batch and the render that
   * shows the new section already knows which way it arrived — no ref written
   * during a render, and nothing to get wrong when a render is repeated.
   */
  const [back, setBack] = useState(false)
  const indexOf = (id: string) => tabs.findIndex((s) => s.id === id)

  return (
    <>
      <nav className="subtabs" role="tablist" aria-label={label}>
        {tabs.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === active}
            onClick={() => {
              setBack(indexOf(s.id) < indexOf(active))
              onActive(s.id)
            }}
          >
            {s.label ?? t(s.labelKey)}
          </button>
        ))}
      </nav>
      {/*
        Keyed by the section for the same reason as the tab above: a new key is
        a new element, which is what replays the slide.
      */}
      <div key={current.id} className={`section-in${back ? ' back' : ''}`}>
        {current.render()}
      </div>
    </>
  )
}
