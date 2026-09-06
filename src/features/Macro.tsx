import { useT } from '../i18n'
import { Notice, Panel } from '../ui/Panel'

/**
 * A tab with its place kept and nothing in it yet.
 *
 * It says so plainly rather than showing an empty panel: a tab that renders
 * nothing reads as something that failed to load, and someone would go looking
 * for the board or the connection to blame.
 */
export function Macro() {
  const t = useT()
  // No title on the panel: the tab's own name is the heading above it now
  // (App.tsx), and this one only ever repeated it.
  return (
    <Panel>
      <Notice kind="info">{t('macro.todo')}</Notice>
    </Panel>
  )
}
