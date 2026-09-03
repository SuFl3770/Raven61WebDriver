import type { ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="panel">
      {title && <h2>{title}</h2>}
      {children}
    </section>
  )
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err'; children: ReactNode }) {
  return <div className={`notice${kind === 'info' ? ' info' : kind === 'err' ? ' err' : ''}`}>{children}</div>
}

/** Shown by every feature panel whose capability the active codec lacks. */
export function NotDecoded({ what }: { what: MessageKey }) {
  const t = useT()
  return (
    <Notice kind="warn">
      <strong>{t('panel.notDecoded.title', { what: t(what) })}</strong>
      <div className="small dim" style={{ marginTop: 4 }}>
        <T k="panel.notDecoded.body" />
      </div>
    </Notice>
  )
}
