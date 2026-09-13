import { useT } from '../i18n'
import { settings, useSettings } from '../state/settings'
import { THEMES, resolveTheme } from '../state/theme'
import { Select } from './Select'

/**
 * Light, dark, or whatever the machine says.
 *
 * A dropdown rather than a row of swatches, unlike the accent picker beside it:
 * a theme has a name and three named options do not have a picture that says
 * more than the word does. "System" in particular can only be a label — what it
 * looks like is whatever the desktop happens to be saying today.
 *
 * A labelled row rather than a panel of its own. It is one control, and it sits
 * in the driver group with the two other things this browser keeps — see
 * features/Settings.tsx.
 */
export function ThemePicker() {
  const { theme } = useSettings()
  const t = useT()

  return (
    <div className="row">
      <span className="small dim" style={{ minWidth: 96 }}>
        {t('settings.theme.title')}
      </span>
      <Select
        value={resolveTheme(theme)}
        label={t('settings.theme.title')}
        options={THEMES.map((id) => ({ value: id, label: t(`settings.theme.${id}`) }))}
        onChange={(v) => settings.set('theme', resolveTheme(v))}
        style={{ minWidth: 180 }}
      />
    </div>
  )
}
