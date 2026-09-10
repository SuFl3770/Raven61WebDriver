import { useT } from '../i18n'
import { T } from '../i18n/T'
import { NotDecoded, Panel } from '../ui/Panel'
import { PlaceholderGrid } from '../ui/PlaceholderGrid'

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
 *
 * It opens with the same grid as its neighbours even though nothing here reads
 * it yet — see ui/PlaceholderGrid.tsx. An advanced key is a per-key setting, so
 * this is the grid the panel will eventually be wired to.
 */
export function Advanced() {
  const t = useT()
  return (
    <>
      <PlaceholderGrid />
      <Panel title={t('advanced.title')}>
        <NotDecoded what="advanced.what" />
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="advanced.note" />
        </div>
      </Panel>
    </>
  )
}
