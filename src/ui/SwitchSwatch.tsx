import { switchColor } from '../device/tables'

/**
 * The colour dot beside a switch's name.
 *
 * Purely a label. `SwitchTypeSpec.color` is filled in by whoever wrote the
 * board definition and is never read by the protocol layer, so this dot says
 * "this is the row you mean", not "this is what your keyboard reports".
 *
 * A type with no colour on file draws hatched rather than filled. That is the
 * common case — a switch table recovered from a driver binary has no colours in
 * it — and painting an unknown one grey would put seven grey switches in a list
 * where grey means something.
 *
 * Hidden from screen readers on purpose: it always sits next to the switch's
 * name, and a reader announcing a colour it cannot check adds nothing.
 */
export function SwitchSwatch({ value }: { value: number | undefined }) {
  return (
    <span className="swatch switch-swatch" style={{ background: switchColor(value) }} aria-hidden="true" />
  )
}
