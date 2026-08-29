import { isVendorPage } from '../hid/reportInfo'
import { Notice, Panel } from '../ui/Panel'
import { useConnection } from '../state/link'

const USAGE_PAGES: Record<number, string> = {
  0x01: 'Generic Desktop',
  0x02: 'Simulation',
  0x06: 'Generic Device',
  0x07: 'Keyboard/Keypad',
  0x08: 'LED',
  0x09: 'Button',
  0x0c: 'Consumer',
  0x0d: 'Digitizer',
  0xff60: 'Vendor (QMK raw)',
}

function pageName(page: number): string {
  return USAGE_PAGES[page] ?? (isVendorPage(page) ? 'Vendor-defined' : 'Unknown')
}

const hex4 = (n: number) => `0x${n.toString(16).padStart(4, '0')}`

function reportBytes(r: HIDReportInfo): number {
  let bits = 0
  for (const it of r.items ?? []) bits += (it.reportSize ?? 0) * (it.reportCount ?? 0)
  return Math.ceil(bits / 8)
}

function ReportTable({ title, reports }: { title: string; reports: readonly HIDReportInfo[] }) {
  if (!reports.length) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small dim">{title}</div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 90 }}>Report ID</th>
            <th style={{ width: 90 }}>바이트</th>
            <th>항목</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r.reportId ?? 0}</td>
              <td className="mono">{reportBytes(r)}</td>
              <td className="small dim">
                {(r.items ?? [])
                  .map((it) => `${it.reportCount ?? 0}×${it.reportSize ?? 0}bit`)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Collection({ c, depth }: { c: HIDCollectionInfo; depth: number }) {
  const page = c.usagePage ?? 0
  const vendor = isVendorPage(page)
  return (
    <div style={{ marginLeft: depth * 16, marginTop: 10 }}>
      <div className="row">
        <span className="badge" style={vendor ? { borderColor: 'var(--accent)' } : undefined}>
          {hex4(page)} / {hex4(c.usage ?? 0)}
        </span>
        <span className="small dim">{pageName(page)}</span>
        {vendor && <span className="small" style={{ color: 'var(--accent)' }}>← 설정 채널 후보</span>}
      </div>
      <ReportTable title="Input" reports={c.inputReports ?? []} />
      <ReportTable title="Output" reports={c.outputReports ?? []} />
      <ReportTable title="Feature" reports={c.featureReports ?? []} />
      {(c.children ?? []).map((child, i) => (
        <Collection key={i} c={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export function HidExplorer() {
  const { device } = useConnection()

  if (!device) {
    return (
      <Panel title="HID 탐색기">
        <Notice>장치를 먼저 연결하세요.</Notice>
      </Panel>
    )
  }

  return (
    <Panel title="HID 탐색기">
      <div className="small dim" style={{ marginBottom: 4 }}>
        브라우저가 파싱한 리포트 디스크립터입니다. 보낼 수 있는 리포트 ID와 정확한 길이를 여기서 확인하세요.
      </div>
      <Notice>
        <span className="small">
          크롬은 보안상 <b>키보드 top-level 컬렉션(0x01/0x06)</b>을 WebHID에 노출하지 않습니다. 여기 보이지
          않는다고 고장이 아니며, 설정 통신은 벤더 정의 컬렉션으로 이뤄집니다.
        </span>
      </Notice>
      <div style={{ marginTop: 12 }}>
        {device.collections.map((c, i) => (
          <Collection key={i} c={c} depth={0} />
        ))}
      </div>
    </Panel>
  )
}
