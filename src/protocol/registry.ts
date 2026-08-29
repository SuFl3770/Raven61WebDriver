import type { HidLink } from '../hid/link'
import type { Raven61Codec } from './codec'
import { raven61Codec } from './raven61'
import { unknownCodec } from './unknown'

/**
 * Codecs are tried in order; the first successful probe wins. Add newly
 * decoded firmware families above `unknownCodec`, which always matches last.
 */
export const CODECS: Raven61Codec[] = [raven61Codec, unknownCodec]

export async function selectCodec(link: HidLink): Promise<Raven61Codec> {
  for (const codec of CODECS) {
    try {
      if (await codec.probe(link)) return codec
    } catch {
      // A probe that throws simply means "not this one".
    }
  }
  return unknownCodec
}
