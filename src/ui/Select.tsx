import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useExit } from './useExit'

/**
 * How long the list takes to fold away. Must match `.select-menu.closing` in
 * styles.css — see ui/useExit.ts on why the two are written twice.
 *
 * Shorter than the 120ms it takes to open. A menu opening is the app answering
 * you and can afford to be seen; a menu closing is over as a decision before it
 * is over as a picture, and anything slower reads as the list being in the way.
 */
const EXIT_MS = 100

export interface SelectOption {
  /** Always a string on the wire of this component — see `Select`. */
  value: string
  label: ReactNode
  /**
   * Shown but not choosable. Used for a value the board holds that this app's
   * table does not offer: hiding it would leave the control blank while the
   * board plainly has a setting, which reads as "unset".
   */
  disabled?: boolean
}

/**
 * The dropdown, as a listbox rather than a `<select>`.
 *
 * A native select cannot be styled below its own edge: the popup is drawn by
 * the platform, in the platform's colours, with no way to round it, tint it or
 * move it. That was fine while it was the only part of the app wearing someone
 * else's design; it is not once the control it drops out of is drawn here.
 *
 * What that costs is everything a select gives away for free, so it is all
 * rebuilt rather than skipped:
 *
 *   - the roles a screen reader needs (`combobox` over `listbox`, with
 *     `aria-activedescendant` naming the row the keyboard is on);
 *   - the keys — up and down to move, Enter or Space to take, Escape to leave,
 *     Home and End for the ends, Tab to step out;
 *   - focus that stays on the trigger the whole time, so the option list never
 *     has to be reachable by tab;
 *   - closing when the pointer goes down anywhere else.
 *
 * Values are strings because that is what a select's `value` is, which keeps
 * every call site's `Number(...)` and casts exactly where they already were.
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  label,
  style,
}: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Accessible name, for the pickers with no visible label beside them. */
  label?: string
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  /**
   * Which way the list opens. Decided when it opens rather than in CSS,
   * because it depends on where the trigger happens to be: the language picker
   * sits at the very bottom of the rail, and a list that only ever dropped
   * downwards would open off the end of the window.
   */
  const [up, setUp] = useState(false)
  /*
   * The list outlives `open` by the length of its exit — see ui/useExit.ts.
   *
   * Everything else here still reads `open`, and that is the point: the
   * keyboard, the press-away listener and `aria-expanded` are all about whether
   * the list is *live*, and it stops being live the moment it is dismissed. The
   * extra 100ms is a picture of a list, and only the rendering knows about it.
   */
  const { mounted, closing } = useExit(open, EXIT_MS)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()

  const currentIndex = options.findIndex((o) => o.value === value)
  const current = currentIndex >= 0 ? options[currentIndex] : undefined

  // Close on a press anywhere else. `pointerdown` rather than `click` so the
  // list is gone before whatever was pressed acts on it.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const step = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (!options[i]?.disabled) return i
    }
    return from
  }

  const firstEnabled = (dir: 1 | -1) =>
    dir === 1 ? step(-1, 1) : step(options.length, -1)

  const show = () => {
    if (disabled) return
    // Room below, in the window. 220px is the list's own cap plus its gap.
    const rect = trigger.current?.getBoundingClientRect()
    setUp(rect ? window.innerHeight - rect.bottom < 220 && rect.top > 220 : false)
    setActive(currentIndex >= 0 && !current?.disabled ? currentIndex : firstEnabled(1))
    setOpen(true)
  }

  const commit = (i: number) => {
    const option = options[i]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    trigger.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        show()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => step(i, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => step(i, -1))
        break
      case 'Home':
        e.preventDefault()
        setActive(firstEnabled(1))
        break
      case 'End':
        e.preventDefault()
        setActive(firstEnabled(-1))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        commit(active)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        // Not prevented: the list closes and the tab goes where it was going.
        setOpen(false)
        break
    }
  }

  return (
    <div className="select" ref={root} style={style}>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{current?.label}</span>
      </button>

      {mounted && (
        <div
          className={`select-menu${up ? ' up' : ''}${closing ? ' closing' : ''}`}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          /*
           * On the way out it is a picture and nothing else: hidden from a
           * screen reader, and `pointer-events: none` in the stylesheet so a
           * pointer crossing the fading list cannot highlight or choose a row
           * that is no longer on offer.
           */
          aria-hidden={closing || undefined}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`select-option${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
              // Keeps the focus on the trigger: a press that moved focus into
              // the list would fire the close-on-press-away above.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => commit(i)}
              onPointerEnter={() => !o.disabled && setActive(i)}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
