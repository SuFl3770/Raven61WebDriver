import { useT } from '../i18n'
import { Notice, Panel } from '../ui/Panel'

/** A tab with its place kept and nothing in it yet — see features/Macro.tsx. */
export function Overview() {
  const t = useT()
  return (
    <Panel title={t('overview.title')}>
      <Notice kind="info">{t('overview.todo')}</Notice>
    </Panel>
  )
}
