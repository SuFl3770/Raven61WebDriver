import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { useT } from '../i18n'

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
  vertical = false,
  className,
  style,
  ...rest
}: Omit<ComponentProps<'input'>, 'type'> & {
  /**
   * Stand the control up, min at the top and max at the bottom.
   *
   * A depth into the switch is the one value on this page that has a real
   * direction: the key goes down. `.slider-v` turns the native control with
   * `writing-mode`, which runs it top-to-bottom, so deeper on the board is
   * lower on screen instead of further right.
   */
  vertical?: boolean
}) {
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
      className={[vertical ? 'slider-v' : '', className ?? ''].filter(Boolean).join(' ') || undefined}
      min={min}
      max={max}
      value={value}
      style={{ ...style, '--fill': `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties}
    />
  )
}

/**
 * The grid the rows below live in.
 *
 * It is the parent that carries the columns, and each row is `display:
 * contents`, so the labels, the tracks and the spinners of a whole group line
 * up in three columns. A grid per row would have sized its own label column to
 * its own label, and two rows whose tracks start a few pixels apart is exactly
 * the misalignment that makes a stacked pair unreadable as a pair.
 */
export function SliderRows({ children }: { children: ReactNode }) {
  return <div className="slider-rows">{children}</div>
}

/**
 * A labelled millimetre field: name, slider, spinner, unit, on one line.
 *
 * Rapid trigger and dead zones are each two of these — press and release, top
 * and bottom — and both pairs were spinners alone, which say what a value is
 * but not where it sits in the range the field can hold. The slider carries
 * that, the spinner stays for the exact 0.02 mm step, and both write the same
 * value, so neither is the authority.
 *
 * One row per value rather than two side by side: the two are read against each
 * other, and stacked they share a left edge and a track length, so which is the
 * larger is visible without reading either number.
 *
 * Goes inside `SliderRows` — alone it has no columns of its own.
 */
export function SliderRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  disabled,
  onValue,
  held,
}: {
  label: ReactNode
  /** Trailing note — the counts readout, or the field's own limit. */
  hint?: ReactNode
  min: number
  max: number
  step: number
  value: number
  disabled?: boolean
  onValue: (mm: number) => void
  /** `useHeldWrites`' props, spread onto both controls. */
  held?: ComponentProps<'input'>
}) {
  const t = useT()
  return (
    <div className="slider-row">
      <span className="small dim slider-row-label">{label}</span>
      <Slider
        {...held}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
      <input
        type="number"
        {...held}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
      {/*
        The unit, beside the number rather than inside the name.

        It was "(mm)" on the end of every label, which is a parenthesis a
        reader has to carry from the left of the row to the right to use, and
        four labels saying it made a column of them. Against the spinner it is
        where the number it belongs to is, and it is the same word in both
        bundles — every value this row can hold is a millimetre, which is what
        the component is.
      */}
      <span className="small dim slider-row-unit">{t('unit.mm')}</span>
      {hint !== undefined && <span className="small dim slider-row-hint">{hint}</span>}
    </div>
  )
}
