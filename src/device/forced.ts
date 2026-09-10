/**
 * ⚠ Development only: speaking the default protocol to a board nobody has
 * written a definition for.
 *
 * The app refuses to do this on its own, and that refusal is deliberate — see
 * `README.md` in this directory. But decoding a new board has to start
 * somewhere, and the first question is always "does it answer at all?". Sending
 * the one protocol we have and watching what comes back is how that question
 * gets answered, and doing it by hand in the console is slower and no safer.
 *
 * So this exists, behind the debug gesture, as an explicit act with the risk
 * spelled out on the button: **the commands below are another keyboard's**. On
 * hardware that does not share this protocol they are undefined behaviour —
 * `0xa1` here is a write of the per-key performance block, and there is no
 * reason a different firmware would agree.
 *
 * What it is not is a shortcut to support. A board that answers this way is a
 * board worth writing a definition for; forcing it every session is how you end
 * up with a configurator that works by accident.
 */

import { createCodec } from '../protocol/engine'
import type { KeyboardCodec } from '../protocol/codec'
import { DEFAULT_PROTOCOL } from './protocols/default'
import { defaultSpec } from './registry'
import type { DeviceSpec } from './spec'

/**
 * Specs are cached per device so their identity is stable.
 *
 * `setActiveDevice` compares by identity to decide whether the board changed,
 * and a fresh object on every probe would clear the working set each time.
 */
const CACHE = new Map<string, DeviceSpec>()
const CODECS = new Map<string, KeyboardCodec>()

const keyOf = (device: HIDDevice) => `${device.vendorId}:${device.productId}`

/**
 * A definition for an unrecognised device: the default protocol, the
 * placeholder board's key table, and this device's own ids.
 *
 * `confidence: 'none'` is the honest value and it is what the UI shows. The
 * layout is a stand-in — it is the Raven61's 61 keys, and the board in front of
 * the user may have any number of them — which is the other half of why this is
 * a debug tool: the caps on screen are not a claim about that hardware.
 */
export function forcedSpecFor(device: HIDDevice): DeviceSpec {
  const key = keyOf(device)
  const cached = CACHE.get(key)
  if (cached) return cached
  const base = defaultSpec()
  const spec: DeviceSpec = {
    ...base,
    ...DEFAULT_PROTOCOL,
    id: `forced:${key}`,
    name: `Forced default protocol (${hex(device.vendorId)}:${hex(device.productId)})`,
    labelKey: 'codec.forced.label',
    notesKey: 'codec.forced.notes',
    confidence: 'none',
    origin: 'forced',
    usb: { vendorId: device.vendorId, productIds: [device.productId] },
  }
  CACHE.set(key, spec)
  return spec
}

/** The codec for that spec, cached the same way. */
export function forcedCodecFor(device: HIDDevice): KeyboardCodec {
  const key = keyOf(device)
  const cached = CODECS.get(key)
  if (cached) return cached
  const codec = createCodec(forcedSpecFor(device))
  CODECS.set(key, codec)
  return codec
}

function hex(n: number): string {
  return n.toString(16).padStart(4, '0')
}
