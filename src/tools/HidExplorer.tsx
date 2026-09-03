import { isVendorPage } from '../hid/reportInfo'
import { useT } from '../i18n'
import { T } from '../i18n/T'
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
  const t = useT()
  if (!reports.length) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small dim">{title}</div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 90 }}>Report ID</th>
            <th style={{ width: 90 }}>{t('explorer.col.bytes')}</th>
            <th>{t('explorer.col.items')}</th>
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
  const t = useT()
  const page = c.usagePage ?? 0
  const vendor = isVendorPage(page)
  return (
    <div style={{ marginLeft: depth * 16, marginTop: 10 }}>
      <div className="row">
        <span className="badge" style={vendor ? { borderColor: 'var(--accent)' } : undefined}>
          {hex4(page)} / {hex4(c.usage ?? 0)}
        </span>
        <span className="small dim">{pageName(page)}</span>
        {vendor && (
          <span className="small" style={{ color: 'var(--accent)' }}>
            {t('explorer.configCandidate')}
          </span>
        )}
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
  const t = useT()

  if (!device) {
    return (
      <Panel title={t('explorer.title')}>
        <Notice>{t('explorer.needDevice')}</Notice>
      </Panel>
    )
  }

  return (
    <Panel title={t('explorer.title')}>
      <div className="small dim" style={{ marginBottom: 4 }}>
        {t('explorer.hint')}
      </div>
      <Notice>
        <span className="small">
          <T k="explorer.chromeNote" />
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
