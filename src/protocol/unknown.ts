import type { KeyboardCodec } from './codec'

/**
 * What is selected when no spec matches the attached device.
 *
 * It implements no capability, which makes every feature panel render its
 * "protocol not yet decoded" state instead of pretending to work. It also
 * carries no spec: the UI keeps showing the default board's layout, and this
 * codec is what tells the user that the layout is not a claim about their
 * hardware.
 */
export const unknownCodec: KeyboardCodec = {
  id: 'unknown',
  name: 'Unknown',
  labelKey: 'codec.unknown.label',
  confidence: 'none',
  notesKey: 'codec.unknown.notes',
  async probe() {
    return true
  },
}
