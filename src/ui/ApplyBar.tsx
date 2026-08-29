import { useState } from 'react'
import { supports } from '../protocol/codec'
import { configStore, useDirtyKeys } from '../state/config'
import { link, useCodec, useConnection } from '../state/link'
import { Notice } from './Panel'

/** Read / write / commit controls shared by the actuation and rapid-trigger panels. */
export function ApplyBar() {
  const codec = useCodec()
  const { connected } = useConnection()
  const dirty = useDirtyKeys()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canRead = supports(codec, 'readKeyConfigs')
  const canWrite = supports(codec, 'writeKeyConfigs')
  const canCommit = supports(codec, 'commit')

  const run = (name: string, fn: () => Promise<void>) => async () => {
    setBusy(name)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="row">
        <button
          disabled={!connected || !canRead || busy !== null}
          onClick={run('read', async () => {
            const configs = await codec.readKeyConfigs!(link)
            configStore.load(configs)
          })}
        >
          {busy === 'read' ? '읽는 중…' : '보드에서 읽기'}
        </button>
        <button
          className="primary"
          disabled={!connected || !canWrite || busy !== null || dirty.length === 0}
          onClick={run('write', async () => {
            const all = configStore.all()
            const changed = configStore.dirtyIndices()
            const payload = all.map((c, i) => (changed.includes(i) ? c : null))
            await codec.writeKeyConfigs!(link, payload)
            configStore.markClean()
          })}
        >
          {busy === 'write' ? '적용 중…' : `보드에 적용${dirty.length ? ` (${dirty.length})` : ''}`}
        </button>
        {canCommit && (
          <button
            disabled={!connected || busy !== null}
            onClick={run('commit', () => codec.commit!(link))}
          >
            {busy === 'commit' ? '저장 중…' : '플래시에 저장'}
          </button>
        )}
        {!canWrite && (
          <span className="small dim">현재 코덱({codec.label})은 쓰기를 지원하지 않습니다.</span>
        )}
      </div>
      {error && (
        <div style={{ marginTop: 8 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}
    </div>
  )
}
