import { useT } from '../i18n'
import { Notice, Panel } from '../ui/Panel'

/** A tab with its place kept and nothing in it yet — see features/Macro.tsx. */
export function Lighting() {
  const t = useT()
  return (
    <Panel title={t('light.title')}>
      <Notice kind="info">{t('light.todo')}</Notice>
    </Panel>
  )
}
