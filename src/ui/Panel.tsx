import type { ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'

export function Panel({
  title,
  framed = false,
  children,
}: {
  title?: string
  /**
   * Whether to draw the edge round this panel — see `.panel.framed`.
   *
   * Off everywhere but the calibration guide. A panel is normally one section
   * of a page of them, told apart by its heading and the space above it; the
   * flag is for the one that is not one of a run, and is on screen alone.
   */
  framed?: boolean
  children: ReactNode
}) {
  return (
    <section className={framed ? 'panel framed' : 'panel'}>
      {title && <h2>{title}</h2>}
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
