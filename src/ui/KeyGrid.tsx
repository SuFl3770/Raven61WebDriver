import { useRef, type ReactNode } from 'react'
import { useT } from '../i18n'
import { LAYOUT_UNITS, RAVEN61_KEYS, type KeyDef } from '../keyboard/raven61'

export interface KeyGridProps {
  selected?: ReadonlySet<number>
  /**
   * Pick one key. Plain click, no drag — for the panels that bind or inspect a
   * single key rather than editing a set.
   */
  onSelect?: (index: number) => void
  /**
   * Multi-select: click toggles a key, and dragging across the grid paints.
   *
   * Given instead of `onSelect`. `on` is what the key should become — for a
   * click that is simply the opposite of its current state, and for a drag it
   * is whatever the key the drag *started* on became, so one gesture either
   * selects a run of keys or clears one, and never alternates as it crosses
   * keys that disagree.
   */
  onToggle?: (index: number, on: boolean) => void
  /** 0…1 travel fill drawn from the bottom of the cap — used by the monitor. */
  fill?: (key: KeyDef) => number
  /**
   * Secondary line inside the cap (actuation value, keycode, …).
   *
   * Markup rather than a string because some of these are a pair — rapid
   * trigger's press and release — and the two halves are told apart by colour,
   * which a string cannot carry.
   */
  sub?: (key: KeyDef) => ReactNode
  /** Extra class for that line — `pair` when it holds two numbers. */
  subClass?: string
  /**
   * Per-key condition, drawn as a border colour.
   *
   * A border rather than a fill or a label: the cap already carries both, and
   * this has to be readable at a glance across 61 keys without displacing the
   * value being edited.
   *
   * `done` is drawn as well as the two warnings, which is a deliberate
   * exception to "a key that is fine looks like a key". During a calibration
   * pass the whole grid is the progress display, and "this one is finished" is
   * the thing being waited for — a green cap and an untouched cap have to be
   * distinguishable. Outside a pass nothing passes `done`.
   */
  status?: (key: KeyDef) => 'done' | 'marginal' | 'bad' | undefined
  label?: (key: KeyDef) => string
}

const PAD = 0.06 // gap between caps, in keyboard units

export function KeyGrid({ selected, onSelect, onToggle, fill, sub, subClass, label, status }: KeyGridProps) {
  const t = useT()
  /** What the in-progress drag is painting, or null when none is running. */
  const painting = useRef<boolean | null>(null)
  /** Where the pointer was at the previous move, so the gap can be filled in. */
  const last = useRef<{ x: number; y: number } | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  /**
   * The drag is tracked by hit-testing the pointer rather than by listening for
   * `pointerenter` on each cap.
   *
   * Because the grid captures the pointer on the way down. That is what makes
   * the gesture survive leaving the grid and coming back, and guarantees the
   * `pointerup` that ends it — but a captured pointer sends every event to the
   * capturing element, so the caps themselves stop hearing about it.
   */
  const keyUnder = (x: number, y: number): number | undefined => {
    const el = document.elementFromPoint(x, y)
    const cap = el?.closest<HTMLElement>('.keycap')
    const index = cap?.dataset.key
    return index === undefined ? undefined : Number(index)
  }

  const startPaint = (e: React.PointerEvent, index: number) => {
    if (!onToggle) return
    // Left button only: a right-click is the context menu, and a middle-click
    // paste has no business changing the selection.
    if (e.button !== 0) return
    const on = !selected?.has(index)
    painting.current = on
    last.current = { x: e.clientX, y: e.clientY }
    onToggle(index, on)
    // After the toggle, never before: capture throws when the pointer is
    // already gone, and losing it must not lose the click as well.
    try {
      grid.current?.setPointerCapture(e.pointerId)
    } catch {
      // The drag still paints inside the grid without it.
    }
  }

  /**
   * Paints every key between the last pointer position and this one.
   *
   * Hit-testing only where the pointer happens to land drops keys, because
   * pointer samples are as far apart as the pointer moved between them: flick
   * across a row and the row comes out with gaps in it. Walking the segment in
   * steps of half a cap closes them, and costs nothing on a slow drag where the
   * two points are already in the same cap.
   */
  const paintAt = (e: React.PointerEvent) => {
    if (painting.current === null || !onToggle) return
    const on = painting.current
    const from = last.current ?? { x: e.clientX, y: e.clientY }
    const dx = e.clientX - from.x
    const dy = e.clientY - from.y
    // One keyboard unit wide, halved — narrow enough that no cap fits between
    // two samples, and it follows the grid when the window resizes.
    const step = Math.max(4, (grid.current?.clientWidth ?? 0) / LAYOUT_UNITS.width / 2)
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step))
    for (let i = 1; i <= steps; i++) {
      const index = keyUnder(from.x + (dx * i) / steps, from.y + (dy * i) / steps)
      if (index !== undefined) onToggle(index, on)
    }
    last.current = { x: e.clientX, y: e.clientY }
  }

  const endPaint = (e: React.PointerEvent) => {
    painting.current = null
    last.current = null
    if (grid.current?.hasPointerCapture(e.pointerId)) {
      grid.current.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      ref={grid}
      /*
       * `flagged` means the caps are carrying a per-key state on their edge,
       * which today is only a calibration pass. The class is derived from
       * `status` rather than passed in, so the grid cannot be told it is
       * showing states while no cap has one.
       */
      className={`keygrid${onToggle ? ' selectable' : ''}${status ? ' flagged' : ''}`}
      role="group"
      aria-label={t('keygrid.label')}
      onPointerMove={onToggle ? paintAt : undefined}
      onPointerUp={onToggle ? endPaint : undefined}
      onPointerCancel={onToggle ? endPaint : undefined}
    >
      {RAVEN61_KEYS.map((k) => {
        const style = {
          left: `${((k.x + PAD) / LAYOUT_UNITS.width) * 100}%`,
          top: `${((k.y + PAD) / LAYOUT_UNITS.height) * 100}%`,
          width: `${((k.w - PAD * 2) / LAYOUT_UNITS.width) * 100}%`,
          height: `${((1 - PAD * 2) / LAYOUT_UNITS.height) * 100}%`,
        }
        const amount = fill?.(k) ?? 0
        const subText = sub?.(k)
        const state = status?.(k)
        const stateClass = state ? ` ${state}` : ''
        const isSelected = selected?.has(k.index) ?? false
        return (
          <button
            key={k.index}
            type="button"
            data-key={k.index}
            className={`keycap${isSelected ? ' selected' : ''}${stateClass}`}
            style={style}
            aria-pressed={isSelected}
            title={`#${k.index} ${k.label}`}
            onPointerDown={onToggle ? (e) => startPaint(e, k.index) : undefined}
            onClick={(e) => {
              // The pointer path already ran on the way down. A click with no
              // pointer behind it (`detail === 0`) is the keyboard activating
              // the focused cap, which is the only case left to handle.
              if (onToggle) {
                if (e.detail === 0) onToggle(k.index, !isSelected)
                return
              }
              onSelect?.(k.index)
            }}
          >
            {amount > 0 && <span className="fill" style={{ height: `${Math.min(1, amount) * 100}%` }} />}
            <span className="cap-label">{label?.(k) ?? k.label}</span>
            {subText && (
              <span className={`sub cap-label${subClass ? ` ${subClass}` : ''}`}>{subText}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
