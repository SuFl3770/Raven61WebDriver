import type { ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { Hint } from './Hint'

export function Panel({
  title,
  hintKey,
  ghostHead = false,
  framed = false,
  children,
}: {
  title?: string
  /**
   * A line about what this panel is for, drawn directly under its heading.
   *
   * Here rather than above the panel, where it started: a hint outside the
   * frame belongs to whatever put the panel on the page, and these belong to
   * the section. Under the title it reads as the title's own second line,
   * which is what it is.
   *
   * Blank in the bundles until someone writes one, and nothing is drawn while
   * it is blank — see ui/Hint.
   */
  hintKey?: MessageKey
  /**
   * Whether to draw the edge round this panel — see `.panel.framed`.
   *
   * Off everywhere but the calibration guide. A panel is normally one section
   * of a page of them, told apart by its heading and the space above it; the
   * flag is for the one that is not one of a run, and is on screen alone.
   */
  /**
   * Draw the heading and hint, but only to hold their space.
   *
   * For the second panel of a pair that is really one section split in two —
   * rapid trigger's values and its switches. Only the left one is titled, so
   * without this the right one's first row sits a heading higher than the
   * left's first row, and two columns of the same thing start at two heights.
   *
   * A copy of the real header rather than a measured offset, because the
   * header is not a fixed height: it grows with the hint, which is written in
   * the bundles and can wrap to any number of lines. A spacer that had to be
   * kept in step with it by hand would be wrong the first time someone wrote a
   * long one.
   *
   * `visibility: hidden` rather than `aria-hidden`: it takes the copy out of
   * the accessibility tree as well, so the title is announced once, by the
   * panel that actually carries it.
   */
  ghostHead?: boolean
  framed?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={['panel', framed && 'framed', ghostHead && 'ghost-head']
        .filter(Boolean)
        .join(' ')}
    >
      {title && <h2>{title}</h2>}
      <Hint k={hintKey} className="panel-hint" />
      {children}
    </section>
  )
}

export type NoticeKind = 'info' | 'warn' | 'err' | 'ok'

const NOTICE_CLASS: Record<NoticeKind, string> = {
  // Warn is the bare style, since it is what the un-decoded panels use.
  warn: '',
  info: ' info',
  err: ' err',
  ok: ' ok',
}

export function Notice({ kind = 'info', children }: { kind?: NoticeKind; children: ReactNode }) {
  return <div className={`notice${NOTICE_CLASS[kind]}`}>{children}</div>
}

/** Shown by every feature panel whose capability the active codec lacks. */
export function NotDecoded({ what }: { what: MessageKey }) {
  const t = useT()
  return (
    <Notice kind="warn">
      <strong>{t('panel.notDecoded.title', { what: t(what) })}</strong>
    </Notice>
  )
}

/**
 * One named group of controls inside a panel.
 *
 * The settings tab is a handful of small things that all belong to one of two
 * owners — the board, or this browser — and as a panel each they read as eight
 * unrelated sections. Grouped, the owner is the panel's heading and each thing
 * is a group under it, with `.panel-sep` between.
 *
 * The title is optional: the first group in a panel is usually the one the
 * panel's own heading already names, and repeating it would be a heading over
 * a heading.
 */
export function PanelGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="panel-group">
      {title && <h3>{title}</h3>}
      {children}
    </div>
  )
}
