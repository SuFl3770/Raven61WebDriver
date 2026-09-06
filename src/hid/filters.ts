import { allSpecs, specForDevice } from '../device/registry'
import { t, type MessageKey } from '../i18n'
import { inputReports, isVendorPage, outputReports } from './reportInfo'

/**
 * Which HID interfaces to offer, and which of them is the configurator.
 *
 * Nothing here names a board any more. The vendor ids come from the registered
 * specs, so adding a device definition also adds it to the chooser's filter and
 * to the ranking below — see `src/device/spec.ts`.
 */

/** Vendor ids any registered board answers to, de-duplicated. */
export function knownVendorIds(): number[] {
  return [...new Set(allSpecs().map((s) => s.usb.vendorId))]
}

/** Payload sizes the registered boards use; the report-shape signal below. */
function knownPayloadLengths(): number[] {
  return [...new Set(allSpecs().map((s) => s.frame.payloadLength))]
}

/**
 * True when a registered spec lists this exact product id.
 *
 * Stricter than `specForDevice`, deliberately: this is a ranking signal, and a
 * spec that claims a whole vendor would otherwise make every device under it
 * look equally identified.
 */
export function isKnownDevice(device: HIDDevice): boolean {
  return allSpecs().some(
    (s) => s.usb.vendorId === device.vendorId && s.usb.productIds.includes(device.productId),
  )
}

/** The board a registered spec claims for this device, if any. */
export function specFor(device: HIDDevice) {
  return specForDevice(device)
}

export interface FilterPreset {
  id: string
  labelKey: MessageKey
  hintKey: MessageKey
  filters: HIDDeviceFilter[]
}

export function filterPresets(): FilterPreset[] {
  return [
    {
      id: 'known',
      labelKey: 'device.filter.known.label',
      hintKey: 'device.filter.known.hint',
      filters: knownVendorIds().map((vendorId) => ({ vendorId })),
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

  if (knownVendorIds().includes(device.vendorId)) {
    score += 100
    reasons.push(t('device.reason.knownVid'))
    if (isKnownDevice(device)) {
      score += 20
      reasons.push(t('device.reason.knownPid'))
    }
  }

  const ins = inputReports(device)
  const outs = outputReports(device)

  for (const bytes of knownPayloadLengths()) {
    if (ins.some((r) => r.byteLength === bytes)) {
      score += 60
      reasons.push(t('device.reason.inReport', { bytes }))
    }
    if (outs.some((r) => r.byteLength === bytes)) {
      score += 60
      reasons.push(t('device.reason.outReport', { bytes }))
    }
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
