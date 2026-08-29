export interface ReportSpec {
  reportId: number
  /** Payload length in bytes, excluding the report ID prefix. */
  byteLength: number
  usagePage: number
  usage: number
}

function reportBytes(report: HIDReportInfo): number {
  let bits = 0
  for (const item of report.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0)
  return Math.ceil(bits / 8)
}

function walk(
  collections: readonly HIDCollectionInfo[],
  pick: (c: HIDCollectionInfo) => readonly HIDReportInfo[] | undefined,
  out: ReportSpec[],
): void {
  for (const c of collections) {
    for (const r of pick(c) ?? []) {
      out.push({
        reportId: r.reportId ?? 0,
        byteLength: reportBytes(r),
        usagePage: c.usagePage ?? 0,
        usage: c.usage ?? 0,
      })
    }
    if (c.children?.length) walk(c.children, pick, out)
  }
}

export function inputReports(device: HIDDevice): ReportSpec[] {
  const out: ReportSpec[] = []
  walk(device.collections, (c) => c.inputReports, out)
  return out
}

export function outputReports(device: HIDDevice): ReportSpec[] {
  const out: ReportSpec[] = []
  walk(device.collections, (c) => c.outputReports, out)
  return out
}

export function featureReports(device: HIDDevice): ReportSpec[] {
  const out: ReportSpec[] = []
  walk(device.collections, (c) => c.featureReports, out)
  return out
}

/**
 * Chrome rejects an output report whose length differs from the descriptor, so
 * every write goes through here first. Returns the payload unchanged when the
 * report id is unknown (some vendor interfaces under-declare their descriptor).
 */
export function padToReport(specs: readonly ReportSpec[], reportId: number, data: Uint8Array): Uint8Array {
  const spec = specs.find((s) => s.reportId === reportId)
  if (!spec || spec.byteLength === 0 || data.length === spec.byteLength) return data
  if (data.length > spec.byteLength) return data.slice(0, spec.byteLength)
  const padded = new Uint8Array(spec.byteLength)
  padded.set(data)
  return padded
}

/** Vendor-defined pages (0xFF00–0xFFFF) are where configurator protocols live. */
export function isVendorPage(usagePage: number): boolean {
  return usagePage >= 0xff00 && usagePage <= 0xffff
}
