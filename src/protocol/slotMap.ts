/**
 * Which key sits in which slot of the board's per-key blocks.
 *
 * The blocks (perf 0xa0, keymap 0x07, RGB 0xde) all address keys by the same
 * slot number, and it cannot be computed from the layout file. A hardware dump
 * has exactly 61 populated perf slots inside 0..63, with holes at 12, 20 and
 * 53 — so the slot space is 64 wide with three unused channels, and the
 * assignment is board wiring, not layout order. Nothing in the stock binary
 * holds a static table for it either (searched, byte- and word-wide, against
 * the row-per-actuation test below).
 *
 * The stock driver builds the mapping at runtime from the keymap block, and
 * that is exactly what this module does. Recovered from the loop at
 * 0x426344-0x4264c1, which walks the 0x07 block cached at `this+0x8a4` and
 * fills its `slot -> usage` map (`this+0xbc4`) plus the two inverse maps:
 *
 *   entry[0]  0x10 = an ordinary key. 0xf0 = a layer key. Others are media and
 *             macro kinds this mapping ignores.
 *   entry[1]  HID modifier BITMASK — 1 LCtrl, 2 LShift, 4 LAlt, 8 LGui,
 *             0x10 RCtrl … 0x80 RGui. Non-zero here wins over entry[2], which
 *             the encoder leaves at 0 for modifiers. Confirmed by 0x45d990,
 *             which converts usage 0xe0..0xe7 into exactly those bits.
 *   entry[2]  the HID usage, for everything that is not a modifier.
 *
 *   entry[0] == 0xf0 with entry[1] == 0xff is Fn, which has no usage of its
 *   own; the driver stores 0xff and so does this project.
 *
 * The 0x0a block is NOT this one — it came back all zeros on hardware, which
 * fits it being the Fn layer (unassigned on this board).
 */
import { keyByUsage, RAVEN61_KEYS, type KeyDef } from '../keyboard/raven61'

export const KEYMAP = {
  entrySize: 3,
  /** 768 bytes: 256 entries, i.e. two layers of 128. */
  blobSize: 768,
  /** Only the first layer names keys. */
  slots: 128,
  /** entry[0] for an ordinary HID key. */
  plainKey: 0x10,
  /** entry[0] for a layer key; Fn is the one this board has. */
  layerKey: 0xf0,
  /** entry[1] for Fn, and the usage this project gives it. */
  fnSelector: 0xff,
  /** Bit n of entry[1] is usage 0xE0 + n. */
  modifierBaseUsage: 0xe0,
} as const

export interface SlotMap {
  /** slot -> key, for slots that resolve to a key on this board. */
  keyBySlot: Map<number, KeyDef>
  /** key index -> slot. */
  slotByKey: Map<number, number>
  /** How the mapping was obtained, for the UI to be honest about. */
  source: 'keymap' | 'fallback'
  /** Usages the keymap reported that this layout has no key for. */
  unknownUsages: { slot: number; usage: number }[]
}

/**
 * HID usage one keymap entry produces, or 0 for an entry that names no key.
 *
 * Modifiers take the bitmask route because HID reports them in a bitmask rather
 * than the keycode array, so the firmware has no usage byte to put in entry[2].
 * Same reason the analog event stream identifies them from `payload[2]`.
 */
export function usageOfKeymapEntry(type: number, selector: number, usage: number): number {
  if (type === KEYMAP.plainKey) {
    // A single set bit is a modifier. Anything else is not one, and the usage
    // byte stands.
    if (selector !== 0 && (selector & (selector - 1)) === 0) {
      return KEYMAP.modifierBaseUsage + Math.log2(selector)
    }
    return usage === 0 || usage === KEYMAP.fnSelector ? 0 : usage
  }
  if (type === KEYMAP.layerKey && selector === KEYMAP.fnSelector) return KEYMAP.fnSelector
  return 0
}

/**
 * Builds the mapping from a keymap block.
 *
 * A remapped key reports the usage it was remapped to, so a board with a custom
 * keymap resolves that slot to the key it now types rather than the cap that is
 * physically there. The stock driver behaves the same way, and the alternative
 * — inventing a position — is worse.
 */
export function slotMapFromKeymap(blob: ArrayLike<number>): SlotMap {
  const keyBySlot = new Map<number, KeyDef>()
  const slotByKey = new Map<number, number>()
  const unknownUsages: { slot: number; usage: number }[] = []
  for (let slot = 0; slot < KEYMAP.slots; slot++) {
    const at = slot * KEYMAP.entrySize
    const usage = usageOfKeymapEntry(blob[at] ?? 0, blob[at + 1] ?? 0, blob[at + 2] ?? 0)
    if (usage === 0) continue
    const key = keyByUsage(usage)
    if (!key) {
      unknownUsages.push({ slot, usage })
      continue
    }
    // First slot wins: a duplicate usage would otherwise silently move a key.
    if (slotByKey.has(key.index)) continue
    keyBySlot.set(slot, key)
    slotByKey.set(key.index, slot)
  }
  return { keyBySlot, slotByKey, source: 'keymap', unknownUsages }
}

/**
 * Slots observed empty on hardware: the three channels the 64-wide slot space
 * does not use. Only meaningful to the fallback below.
 */
export const UNUSED_SLOTS: readonly number[] = [12, 20, 53]

/**
 * Layout order laid over the slots the board populates, skipping the three
 * unused channels.
 *
 * Known to be WRONG on hardware — a row-per-actuation test showed the board
 * groups slots quite differently (row 0 sits at slots 3, 24-27, 33, 36, 40-44,
 * 58, 59, for instance). It reproduces the right *shape*, 61 slots in the right
 * places, and nothing more. Kept only so a failed keymap read degrades to
 * something ordered rather than to nothing, and the UI labels it as a guess.
 */
export function fallbackSlotMap(): SlotMap {
  const keyBySlot = new Map<number, KeyDef>()
  const slotByKey = new Map<number, number>()
  let slot = 0
  for (const key of RAVEN61_KEYS) {
    while (UNUSED_SLOTS.includes(slot)) slot++
    keyBySlot.set(slot, key)
    slotByKey.set(key.index, slot)
    slot++
  }
  return { keyBySlot, slotByKey, source: 'fallback', unknownUsages: [] }
}
