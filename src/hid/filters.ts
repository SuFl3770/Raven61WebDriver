import { isVendorPage } from './reportInfo'

/**
 * Device ids recovered from the stock driver binary. It matches devices by the
 * Windows hardware id `VID_19F5&PID_xxxx&MI_01`, i.e. always USB interface 1 —
 * the vendor interface, not the keyboard interface.
 *
 * The binary's string pool does not preserve the name-to-id pairing reliably,
 * so all three ids are treated as one family; the actual product id is read
 * back from the device once connected.
 */
export const RAVEN_VENDOR_ID = 0x19f5

export const RAVEN_PRODUCT_IDS = [0xfe20, 0xfed0, 0xfeb1] as const

/** Layout files shipped by the stock driver, for reference. */
export const RAVEN_FAMILY = ['Raven61', 'Raven68', 'ABT68'] as const

export interface FilterPreset {
  id: string
  label: string
  hint: string
  filters: HIDDeviceFilter[]
}

export const FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'raven',
    label: 'Raven 계열 (VID 0x19F5)',
    hint: '순정 드라이버가 인식하는 장치 ID입니다. 보통 이걸 쓰면 됩니다.',
    filters: [{ vendorId: RAVEN_VENDOR_ID }],
  },
  {
    id: 'all',
    label: '모든 HID 장치',
    hint: '위에서 아무것도 안 보일 때. 크롬이 접근 가능한 모든 HID 장치를 보여줍니다.',
    filters: [],
  },
  {
    id: 'vendor-pages',
    label: '벤더 정의 페이지',
    hint: '설정 채널로 흔히 쓰이는 usage page 들만.',
    filters: [{ usagePage: 0xff00 }, { usagePage: 0xff01 }, { usagePage: 0xff02 }],
  },
]

export function isRavenDevice(device: HIDDevice): boolean {
  return device.vendorId === RAVEN_VENDOR_ID
}

/**
 * Heuristic ranking for "which of these interfaces is the configurator
 * channel". A known Raven id wins outright; otherwise a vendor-defined
 * collection carrying feature reports is the best guess, since the stock
 * driver talks over HidD_SetFeature / HidD_GetFeature.
 */
export function scoreDevice(device: HIDDevice): number {
  let score = isRavenDevice(device) ? 100 : 0
  if (score > 0 && (RAVEN_PRODUCT_IDS as readonly number[]).includes(device.productId)) score += 50
  for (const c of device.collections) {
    if (!isVendorPage(c.usagePage ?? 0)) continue
    score += 10
    if ((c.featureReports?.length ?? 0) > 0) score += 8
    if ((c.inputReports?.length ?? 0) > 0) score += 5
    if ((c.outputReports?.length ?? 0) > 0) score += 5
  }
  return score
}

export function describeDevice(device: HIDDevice): string {
  const vid = device.vendorId.toString(16).padStart(4, '0')
  const pid = device.productId.toString(16).padStart(4, '0')
  return `${device.productName || '(이름 없음)'} — ${vid}:${pid}`
}
