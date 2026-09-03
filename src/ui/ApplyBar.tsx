import { useState } from 'react'
import { useT } from '../i18n'
import { supports } from '../protocol/codec'
import { configStore, useDirtyKeys } from '../state/config'
import { link, useCodec, useConnection } from '../state/link'
import { Notice } from './Panel'

/** Read / write / commit controls shared by the actuation and rapid-trigger panels. */
export function ApplyBar() {
  const codec = useCodec()
  const t = useT()
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
          {busy === 'read' ? t('apply.reading') : t('apply.read')}
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
          {busy === 'write'
            ? t('apply.writing')
            : dirty.length
              ? t('apply.writeCount', { count: dirty.length })
              : t('apply.write')}
        </button>
        {canCommit && (
          <button
            disabled={!connected || busy !== null}
            onClick={run('commit', () => codec.commit!(link))}
          >
            {busy === 'commit' ? t('apply.committing') : t('apply.commit')}
          </button>
        )}
        {!canWrite && (
          <span className="small dim">{t('apply.noWrite', { codec: t(codec.labelKey) })}</span>
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
