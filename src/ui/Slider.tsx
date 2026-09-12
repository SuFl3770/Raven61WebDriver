import type { ComponentProps, CSSProperties } from 'react'

/**
 * A range input that knows how far along it is.
 *
 * Chrome draws the track as one piece: there is no pseudo-element for the part
 * behind the thumb, so the filled half cannot be coloured in CSS alone. What
 * CSS can do is take a hard-stopped gradient, and what it needs for that is the
 * position as a percentage — which only whoever holds the value knows.
 *
 * So the percentage is worked out here and handed to the stylesheet as
 * `--fill`. Everything else is the native input, passed straight through:
 * `useHeldWrites`' props, `disabled`, `step`, the change handler and the
 * layout style all arrive as they always did.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  style,
  ...rest
}: Omit<ComponentProps<'input'>, 'type'>) {
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : fallback
  }

  const lo = num(min, 0)
  const hi = num(max, 100)
  const at = num(value, lo)
  // A zero-width range is a control with one position; it reads as full rather
  // than as a division by zero.
  const fill = hi > lo ? ((at - lo) / (hi - lo)) * 100 : 100

  return (
    <input
      {...rest}
      type="range"
      min={min}
      max={max}
      value={value}
      style={{ ...style, '--fill': `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties}
    />
  )
}
