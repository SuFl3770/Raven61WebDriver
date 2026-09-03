import type { Raven61Codec } from './codec'

/**
 * Placeholder used until the Raven61 protocol is decoded. It implements no
 * capability, which makes every feature panel render its "protocol not yet
 * decoded" state instead of pretending to work.
 */
export const unknownCodec: Raven61Codec = {
  id: 'unknown',
  labelKey: 'codec.unknown.label',
  confidence: 'none',
  notesKey: 'codec.unknown.notes',
  async probe() {
    return true
  },
}
