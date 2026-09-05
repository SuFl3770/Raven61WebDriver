import { LOCALES, i18n, useLocale, useT, type Locale } from '.'

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
    <select
      value={locale}
      aria-label={label}
      title={label}
      onChange={(e) => i18n.set(e.target.value as Locale)}
    >
      {LOCALES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}
