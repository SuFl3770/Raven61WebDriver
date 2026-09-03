import { useT } from '../i18n'
import { LanguageSelect } from '../i18n/LanguageSelect'
import { T } from '../i18n/T'
import { sensorMap, useSensorMap } from '../state/sensorMap'
import { settings, useSettings } from '../state/settings'
import { Notice, Panel } from '../ui/Panel'

export function Settings() {
  const { debug } = useSettings()
  const t = useT()
  // Subscribes so the built-in-table switch below reflects changes made
  // anywhere else.
  useSensorMap()

  return (
    <>
      <Panel title={t('settings.language.title')}>
        <label className="row">
          <LanguageSelect />
          <span className="small dim">{t('settings.language.hint')}</span>
        </label>
      </Panel>

      <Panel title={t('settings.display.title')}>
        <label className="row">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => settings.set('debug', e.target.checked)}
          />
          <span>
            {t('settings.debug.label')}
            <div className="small dim" style={{ marginTop: 2 }}>
              <T k="settings.debug.hint" />
            </div>
          </span>
        </label>
      </Panel>

      <Panel title={t('settings.keyId.title')}>
        <label className="row">
          <input
            type="checkbox"
            checked={sensorMap.builtInIgnored}
            onChange={(e) => sensorMap.setIgnoreBuiltIn(e.target.checked)}
          />
          <span>
            {t('settings.keyId.label')}
            <div className="small dim" style={{ marginTop: 2 }}>
              <T k="settings.keyId.hint" />
            </div>
          </span>
        </label>
      </Panel>

      <Panel title={t('settings.storage.title')}>
        <Notice>
          <span className="small">
            <T k="settings.storage.hint" />
          </span>
        </Notice>
      </Panel>
    </>
  )
}
