import { useT } from '../i18n'
import { ACCENTS, resolveAccent } from '../state/accent'
import { settings, useSettings } from '../state/settings'
import { Panel } from './Panel'

/**
 * The point-colour picker: one dot per colour, in the colour itself.
 *
 * No labels. A colour's name is the least useful thing about it — "green" and
 * "lemon" tell you less than the two dots side by side do — so the swatch is
 * the control, and the name only exists for a screen reader, which gets the
 * value it would otherwise have no way to read at all.
 */
export function AccentPicker() {
  const { accent } = useSettings()
  const t = useT()
  const current = resolveAccent(accent)

  return (
    <Panel title={t('settings.accent.title')}>
      <div className="swatches">
        {ACCENTS.map((color) => (
          <button
            key={color}
            className="accent-swatch"
            style={{ background: color }}
            aria-pressed={color === current}
            aria-label={t('settings.accent.swatch', { color })}
            title={color}
            onClick={() => settings.set('accent', color)}
          />
        ))}
      </div>
    </Panel>
  )
}
