import { selection, useSelection } from '../state/selection'

export function SelectionBar() {
  const sel = useSelection()
  return (
    <div className="row" style={{ marginBottom: 10 }}>
      <button onClick={() => selection.selectAll()}>전체 선택</button>
      <button onClick={() => selection.clear()}>선택 해제</button>
      <span className="small dim">
        {sel.size === 0 ? '선택 없음 — 변경은 전체 키에 적용됩니다' : `${sel.size}개 키 선택됨`} · Shift/Ctrl+클릭으로 다중 선택
      </span>
    </div>
  )
}
