import type { ReactNode } from 'react'

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
export function NotDecoded({ what }: { what: string }) {
  return (
    <Notice kind="warn">
      <strong>{what} — 프로토콜 미해독</strong>
      <div className="small dim" style={{ marginTop: 4 }}>
        이 패널은 코덱이 해당 명령을 구현하면 자동으로 활성화됩니다. 먼저 <b>탐색기 → 콘솔 → 프로버</b>로
        명령을 찾아 <span className="mono">src/protocol/</span> 에 코덱을 추가하세요.
      </div>
    </Notice>
  )
}
