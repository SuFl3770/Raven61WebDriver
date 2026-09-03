import { t, type MessageKey } from '../i18n'
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
  labelKey: MessageKey
  hintKey: MessageKey
  filters: HIDDeviceFilter[]
}

export const FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'raven',
    labelKey: 'device.filter.raven.label',
    hintKey: 'device.filter.raven.hint',
    filters: [{ vendorId: RAVEN_VENDOR_ID }],
  },
  {
    id: 'all',
    labelKey: 'device.filter.all.label',
    hintKey: 'device.filter.all.hint',
    filters: [],
  },
  {
    id: 'vendor-pages',
    labelKey: 'device.filter.vendorPages.label',
    hintKey: 'device.filter.vendorPages.hint',
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
/**
 * Reasons are translated here rather than at the call site because they are
 * de-duplicated as text; the panel re-renders on a language change, which
 * re-runs this.
 */
export function rankDevice(device: HIDDevice): DeviceRank {
  const reasons: string[] = []
  let score = 0

  if (isRavenDevice(device)) {
    score += 100
    reasons.push(t('device.reason.ravenVid'))
    if ((RAVEN_PRODUCT_IDS as readonly number[]).includes(device.productId)) {
      score += 20
      reasons.push(t('device.reason.knownPid'))
    }
  }

  const ins = inputReports(device)
  const outs = outputReports(device)

  if (ins.some((r) => r.byteLength === PAYLOAD_LENGTH)) {
    score += 60
    reasons.push(t('device.reason.inReport', { bytes: PAYLOAD_LENGTH }))
  }
  if (outs.some((r) => r.byteLength === PAYLOAD_LENGTH)) {
    score += 60
    reasons.push(t('device.reason.outReport', { bytes: PAYLOAD_LENGTH }))
  }

  for (const c of collectionsOf(device)) {
    const page = c.usagePage ?? 0
    if (isVendorPage(page)) {
      score += 20
      reasons.push(t('device.reason.vendorPage'))
    } else if (page === BOOT_KEYBOARD.page && (c.usage ?? 0) === BOOT_KEYBOARD.usage) {
      // The typing interface. It never carries the config channel, and writing
      // to it would only toggle lock LEDs.
      score -= 60
      reasons.push(t('device.reason.keyboardInterface'))
    } else if (page === CONSUMER_PAGE) {
      score -= 30
      reasons.push(t('device.reason.consumerControl'))
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
  return `${device.productName || t('device.unnamed')} — ${vid}:${pid}`
}
