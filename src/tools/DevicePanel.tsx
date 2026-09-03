import { useEffect, useState } from 'react'
import { FILTER_PRESETS, describeDevice, pickConfigInterface, rankDevice } from '../hid/filters'
import { HidLink } from '../hid/link'
import { isVendorPage } from '../hid/reportInfo'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { Notice, Panel } from '../ui/Panel'
import { link, refreshCodec, useCodec, useConnection } from '../state/link'

export function DevicePanel() {
  const { device, connected } = useConnection()
  const codec = useCodec()
  const t = useT()
  const [presetId, setPresetId] = useState(FILTER_PRESETS[0]!.id)
  const [known, setKnown] = useState<HIDDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  const reloadKnown = async () => setKnown(await link.knownDevices())
  useEffect(() => {
    void reloadKnown()
  }, [])

  if (!HidLink.supported()) {
    return (
      <Panel title={t('device.title')}>
        <Notice kind="err">
          <strong>{t('device.unsupported.title')}</strong>
          <div className="small" style={{ marginTop: 4 }}>
            {t('device.unsupported.body')}
          </div>
        </Notice>
      </Panel>
    )
  }

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null)
    try {
      await fn()
      await reloadKnown()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const preset = FILTER_PRESETS.find((p) => p.id === presetId)!
  const ranked = known
    .map((d) => ({ d, rank: rankDevice(d) }))
    .sort((a, b) => b.rank.score - a.rank.score)
  const recommended = ranked[0]?.d ?? null
  // Opening the typing interface looks like a successful connection but no
  // analog events ever arrive, so say so instead of leaving the monitor blank.
  const wrongInterface = connected && recommended !== null && device !== recommended

  return (
    <Panel title={t('device.title')}>
      <div className="row">
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {FILTER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(p.labelKey)}
            </option>
          ))}
        </select>
        <button className="primary" onClick={run(() => link.pickDevice(preset.filters, pickConfigInterface))}>
          {t('device.pick')}
        </button>
        <button onClick={run(() => link.close())} disabled={!connected}>
          {t('device.disconnect')}
        </button>
        <span className="badge">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? t('app.connected') : t('app.disconnected')}
        </span>
        <span className="dim small">{t('device.codec', { codec: t(codec.labelKey) })}</span>
      </div>
      <div className="small dim" style={{ marginTop: 6 }}>
        {t(preset.hintKey)}
      </div>

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      {wrongInterface && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">
            <T k="device.wrongInterface" />
          </Notice>
        </div>
      )}

      {device && (
        <div style={{ marginTop: 12 }} className="small">
          <div className="mono">{describeDevice(device)}</div>
          <div className="dim">
            {t('device.collections', {
              total: device.collections.length,
              vendor: device.collections.filter((c) => isVendorPage(c.usagePage ?? 0)).length,
            })}
          </div>
        </div>
      )}

      {known.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="small dim" style={{ marginBottom: 6 }}>
            <T k="device.knownHint" />
          </div>
          <table>
            <thead>
              <tr>
                <th>{t('device.table.interface')}</th>
                <th style={{ width: 70 }}>{t('device.table.score')}</th>
                <th>{t('device.table.reasons')}</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ d, rank }, i) => (
                <tr key={`${d.vendorId}-${d.productId}-${i}`}>
                  <td className="mono">
                    {describeDevice(d)}
                    {d === recommended && (
                      <span className="small" style={{ color: 'var(--accent)' }}> {t('device.recommended')}</span>
                    )}
                  </td>
                  <td>{rank.score}</td>
                  <td className="small dim">{rank.reasons.join(', ') || '—'}</td>
                  <td>
                    <button
                      onClick={run(async () => {
                        await link.open(d)
                        await refreshCodec()
                      })}
                      disabled={d === device && connected}
                    >
                      {d === device && connected ? t('device.inUse') : t('device.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
