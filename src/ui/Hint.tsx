import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'

/**
 * A blank slot for a line of guidance, next to whatever it is about.
 *
 * The text is a locale string rather than markup — the same arrangement
 * `calibration.guide` uses — so rewording a hint, or writing one for the first
 * time, is an edit to `src/i18n/locales/*.json` and nothing else. Every hint
 * key ships as `""`.
 *
 * Blank renders nothing at all, not an empty line: the slots outnumber the
 * hints that will ever be written, and a dozen empty paragraphs pushing the
 * controls down would be a worse page than the one without hints. So a section
 * with no hint is exactly the section as it is today, and the space appears the
 * moment someone writes into the bundle.
 *
 * `T` rather than `t`, so a hint can carry the small markup the bundles
 * already use elsewhere — `<b>` around the part that matters.
 */
export function Hint({ k, className }: { k?: MessageKey; className?: string }) {
  const t = useT()
  if (!k || t(k) === '') return null
  return (
    <div className={className ? `hint ${className}` : 'hint'}>
      <T k={k} />
    </div>
  )
}
