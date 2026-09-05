import type { ReactNode } from 'react'
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
  /** One line under the strip saying what this section is for. Optional. */
  hintKey?: MessageKey
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

  return (
    <>
      <nav className="subtabs" role="tablist" aria-label={label}>
        {tabs.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === active}
            onClick={() => onActive(s.id)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </nav>
      {current.hintKey && (
        <div className="small dim" style={{ padding: '6px 2px 10px' }}>
          {t(current.hintKey)}
        </div>
      )}

      {current.render()}
    </>
  )
}
