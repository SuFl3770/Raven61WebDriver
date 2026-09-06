import { useT } from '../i18n'
import { Notice, Panel } from '../ui/Panel'

/** A tab with its place kept and nothing in it yet — see features/Macro.tsx. */
export function Lighting() {
  const t = useT()
  // No title on the panel: the tab's own name is the heading above it now
  // (App.tsx), and this one only ever repeated it.
  return (
    <Panel>
      <Notice kind="info">{t('light.todo')}</Notice>
    </Panel>
  )
}
