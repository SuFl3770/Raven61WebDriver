import { allSpecs, codecFor } from '../device/registry'
import type { HidLink } from '../hid/link'
import type { KeyboardCodec } from './codec'
import { unknownCodec } from './unknown'

/**
 * Picking the codec for an attached device.
 *
 * The list is no longer written here: it is one codec per registered spec, in
 * registry order — user JSON specs first, then the built-ins — with
 * `unknownCodec` always last. Adding a board is adding a spec, and this file
 * does not change.
 */
export function codecs(): KeyboardCodec[] {
  return [...allSpecs().map(codecFor), unknownCodec]
}

export async function selectCodec(link: HidLink): Promise<KeyboardCodec> {
  for (const codec of codecs()) {
    try {
      if (await codec.probe(link)) return codec
    } catch {
      // A probe that throws simply means "not this one".
    }
  }
  return unknownCodec
}
