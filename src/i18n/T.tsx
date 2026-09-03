import { Fragment, type ReactNode } from 'react'
import { useT, type MessageKey, type MessageParams } from '.'

/**
 * Inline markup allowed inside a message, so a sentence that emphasises a word
 * or names a file stays one translatable string instead of being cut into
 * fragments around the JSX. Tags do not nest.
 *
 *   <b>…</b>  bold
 *   <i>…</i>  italic
 *   <c>…</c>  monospace — code, paths, byte values
 */
const TAG = /<(b|i|c)>([\s\S]*?)<\/\1>/g

export function rich(text: string): ReactNode {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TAG)) {
    const [whole, tag, inner] = m as unknown as [string, 'b' | 'i' | 'c', string]
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      tag === 'b' ? (
        <b key={parts.length}>{inner}</b>
      ) : tag === 'i' ? (
        <i key={parts.length}>{inner}</i>
      ) : (
        <span key={parts.length} className="mono">
          {inner}
        </span>
      ),
    )
    last = m.index + whole.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <Fragment>{parts}</Fragment>
}

/** A translated message rendered with its inline markup. */
export function T({ k, params }: { k: MessageKey; params?: MessageParams }): ReactNode {
  const t = useT()
  return rich(t(k, params))
}
