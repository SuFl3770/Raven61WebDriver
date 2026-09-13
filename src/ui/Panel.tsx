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
