import { PAYLOAD_LENGTH } from '../protocol/frame'
import { inputReports, isVendorPage, outputReports } from './reportInfo'

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
 * How a candidate interface scored, and why.
 *
 * A composite keyboard exposes several HID interfaces under the same VID/PID,
 * and only one of them carries the configurator channel. `requestDevice`
 * returns all of them at once, so something has to choose — and it cannot be
 * "the first one", which on this board is the plain keyboard interface.
 */
export interface DeviceRank {
  score: number
  reasons: string[]
}

/** Usage pages that identify an interface as one of the boot/HID roles. */
const BOOT_KEYBOARD = { page: 0x01, usage: 0x06 }
const CONSUMER_PAGE = 0x0c

function collectionsOf(device: HIDDevice): HIDCollectionInfo[] {
  const out: HIDCollectionInfo[] = []
  const walk = (list: readonly HIDCollectionInfo[]) => {
    for (const c of list) {
      out.push(c)
      if (c.children?.length) walk(c.children)
    }
  }
  walk(device.collections)
  return out
}

/**
 * Ranks an interface by how much it looks like the configurator channel.
 *
 * The decisive signal is the report shape rather than the usage page: the
 * driver moves fixed 64-byte payloads in both directions (docs/protocol.md §2),
 * and no boot keyboard or consumer-control interface declares reports that
 * size. The usage page only breaks ties, because vendors are inconsistent about
 * whether the configurator collection is vendor-defined.
 */
export function rankDevice(device: HIDDevice): DeviceRank {
  const reasons: string[] = []
  let score = 0

  if (isRavenDevice(device)) {
    score += 100
    reasons.push('Raven VID')
    if ((RAVEN_PRODUCT_IDS as readonly number[]).includes(device.productId)) {
      score += 20
      reasons.push('알려진 PID')
    }
  }

  const ins = inputReports(device)
  const outs = outputReports(device)

  if (ins.some((r) => r.byteLength === PAYLOAD_LENGTH)) {
    score += 60
    reasons.push(`${PAYLOAD_LENGTH}바이트 IN`)
  }
  if (outs.some((r) => r.byteLength === PAYLOAD_LENGTH)) {
    score += 60
    reasons.push(`${PAYLOAD_LENGTH}바이트 OUT`)
  }

  for (const c of collectionsOf(device)) {
    const page = c.usagePage ?? 0
    if (isVendorPage(page)) {
      score += 20
      reasons.push('벤더 페이지')
    } else if (page === BOOT_KEYBOARD.page && (c.usage ?? 0) === BOOT_KEYBOARD.usage) {
      // The typing interface. It never carries the config channel, and writing
      // to it would only toggle lock LEDs.
      score -= 60
      reasons.push('키보드 인터페이스')
    } else if (page === CONSUMER_PAGE) {
      score -= 30
      reasons.push('컨슈머 컨트롤')
    }
  }

  return { score, reasons: [...new Set(reasons)] }
}

export function scoreDevice(device: HIDDevice): number {
  return rankDevice(device).score
}

/**
 * The interface to open out of everything one pick returned.
 *
 * Chrome's chooser lists physical devices, so selecting the keyboard hands back
 * every interface it exposes. Opening `devices[0]` picked the typing interface,
 * which never streams analog events — the monitor stayed empty until the user
 * opened the right one by hand.
 */
export function pickConfigInterface(devices: readonly HIDDevice[]): HIDDevice | null {
  let best: HIDDevice | null = null
  let bestScore = -Infinity
  for (const d of devices) {
    const { score } = rankDevice(d)
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

export function describeDevice(device: HIDDevice): string {
  const vid = device.vendorId.toString(16).padStart(4, '0')
  const pid = device.productId.toString(16).padStart(4, '0')
  return `${device.productName || '(이름 없음)'} — ${vid}:${pid}`
}
