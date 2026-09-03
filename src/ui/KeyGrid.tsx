import { useT } from '../i18n'
import { LAYOUT_UNITS, RAVEN61_KEYS, type KeyDef } from '../keyboard/raven61'

export interface KeyGridProps {
  selected?: ReadonlySet<number>
  onSelect?: (index: number, additive: boolean) => void
  /** 0…1 travel fill drawn from the bottom of the cap — used by the monitor. */
  fill?: (key: KeyDef) => number
  /** Secondary line inside the cap (actuation value, keycode, …). */
  sub?: (key: KeyDef) => string | undefined
  label?: (key: KeyDef) => string
}

const PAD = 0.06 // gap between caps, in keyboard units

export function KeyGrid({ selected, onSelect, fill, sub, label }: KeyGridProps) {
  const t = useT()
  return (
    <div className="keygrid" role="group" aria-label={t('keygrid.label')}>
      {RAVEN61_KEYS.map((k) => {
        const style = {
          left: `${((k.x + PAD) / LAYOUT_UNITS.width) * 100}%`,
          top: `${((k.y + PAD) / LAYOUT_UNITS.height) * 100}%`,
          width: `${((k.w - PAD * 2) / LAYOUT_UNITS.width) * 100}%`,
          height: `${((1 - PAD * 2) / LAYOUT_UNITS.height) * 100}%`,
        }
        const amount = fill?.(k) ?? 0
        const subText = sub?.(k)
        return (
          <button
            key={k.index}
            type="button"
            className={`keycap${selected?.has(k.index) ? ' selected' : ''}`}
            style={style}
            aria-pressed={selected?.has(k.index) ?? false}
            title={`#${k.index} ${k.label}`}
            onClick={(e) => onSelect?.(k.index, e.shiftKey || e.ctrlKey || e.metaKey)}
          >
            {amount > 0 && <span className="fill" style={{ height: `${Math.min(1, amount) * 100}%` }} />}
            <span className="cap-label">{label?.(k) ?? k.label}</span>
            {subText && <span className="sub cap-label">{subText}</span>}
          </button>
        )
      })}
    </div>
  )
}
