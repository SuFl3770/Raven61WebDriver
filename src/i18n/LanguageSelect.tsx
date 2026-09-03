import { LOCALES, i18n, useLocale, type Locale } from '.'

/** The language picker, shown in the settings tab. */
export function LanguageSelect() {
  const locale = useLocale()
  return (
    <select value={locale} onChange={(e) => i18n.set(e.target.value as Locale)}>
      {LOCALES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}
