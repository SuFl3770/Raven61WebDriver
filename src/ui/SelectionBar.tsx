import { useT } from '../i18n'
import { selection, useSelection } from '../state/selection'

export function SelectionBar() {
  const sel = useSelection()
  const t = useT()
  return (
    <div className="row" style={{ marginBottom: 10 }}>
      <button onClick={() => selection.selectAll()}>{t('selection.selectAll')}</button>
      <button onClick={() => selection.clear()}>{t('selection.clear')}</button>
      <span className="small dim">
        {sel.size === 0 ? t('selection.none') : t('selection.count', { count: sel.size })} ·{' '}
        {t('selection.hint')}
      </span>
    </div>
  )
}
