import { LOCALES, i18n, useLocale, useT, type Locale } from '.'
import { Select } from '../ui/Select'

/**
 * The language picker.
 *
 * Shown twice, and never with a visible label: in the top bar next to the
 * disconnect button, and on the connect screen, which is the whole window
 * until a board is attached. Both places are chrome with no room for a caption,
 * so the accessible name is carried by `aria-label` and repeated as a tooltip.
 */
export function LanguageSelect() {
  const locale = useLocale()
  const t = useT()
  const label = t('app.language')
  return (
    <Select
      value={locale}
      label={label}
      options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
      onChange={(v) => i18n.set(v as Locale)}
    />
  )
}
