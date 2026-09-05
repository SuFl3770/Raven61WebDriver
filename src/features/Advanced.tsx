import { useT } from '../i18n'
import { T } from '../i18n/T'
import { NotDecoded, Panel } from '../ui/Panel'

/**
 * Advanced keys — DKS, MT, TGL, RS, SOCD, OKS.
 *
 * A tab of its own rather than a panel under rapid trigger. It was sitting
 * there because both are "what a key does when you press it", but the input
 * point tab is about *where in the stroke* a key triggers, and every section in
 * it edits the same per-key performance record and applies through the same
 * write. Advanced keys are a different block (`t_magnetic_key_data`), a
 * different limit (40 per profile) and a different protocol, none of which is
 * decoded — so it shared an apply bar it could never use.
 */
export function Advanced() {
  const t = useT()
  return (
    <Panel title={t('advanced.title')}>
      <NotDecoded what="advanced.what" />
      <div className="small dim" style={{ marginTop: 8 }}>
        <T k="advanced.note" />
      </div>
    </Panel>
  )
}
