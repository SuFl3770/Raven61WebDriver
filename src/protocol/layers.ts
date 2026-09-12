/**
 * Layers and profiles — what the firmware actually implements, and the seam a
 * profile-capable sibling board plugs into.
 *
 * Nothing here is wired into the UI yet. It exists because the facts below were
 * read out of the Raven61 firmware image (spec 7.1) and are worth keeping next
 * to the code that will need them, rather than only in a document. Everything
 * marked `[fw]` came from `Raven FW/FW.exe`; nothing here is hardware-verified.
 *
 * The short version for this board:
 *
 *   - one byte at `gp-0x7b6` selects the keymap: `0x20b00 + layer * 512`
 *   - only two of those slots hold a keymap. Slot 2 is the per-key RGB blob and
 *     slot 3 is the macro table, so layers 2 and 3 read foreign bytes as
 *     keycodes
 *   - the switch affects the keymap and nothing else. Actuation, rapid trigger,
 *     macros, advanced-key definitions and lighting are one global copy each
 *   - only a key action can change it. No host command does, and the boot path
 *     forces it back to 0
 *
 * So this board has layers, not profiles. Siblings on the same protocol do
 * expose profiles; see PROFILE_UNKNOWNS for what has to be measured on one
 * before any of this can be implemented.
 */

/**
 * A keymap entry is three bytes: `[type][param][code]`.
 *
 * Duplicated from slotMap.ts's KEYMAP on purpose — that constant describes the
 * subset the slot mapping needs, this one describes the record as the firmware
 * dispatches on it (0x885e for the lookup, 0x812c for the action handler).
 *
 * Neither is the authority any more. **keymap.ts is**: it carries the whole
 * type taxonomy, the codec that reads and writes a record, and the catalog of
 * what the stock driver's remap tab can put in one. What stays here is the
 * layer geometry and the actions that move between layers, which is what this
 * module is about.
 */
export const KEYMAP_ENTRY = {
  size: 3,
  /** Bytes per layer in flash. 128 usable records of 3 bytes, then padding. */
  layerStride: 512,
  type: {
    /** No binding. */
    none: 0x00,
    /** Ordinary HID key. `param` is the modifier bitmask, `code` the usage. */
    plainKey: 0x10,
    /** Advanced key. `param` indexes the 24-byte records at flash 0x22100. */
    advancedKey: 0x90,
    /** Special action. `param` is a LAYER_ACTION, `code` its argument. */
    action: 0xf0,
    /** Unassigned slot, as the factory keymap leaves it. */
    unassigned: 0xff,
  },
} as const

/**
 * Action codes for a `0xf0` keymap entry, from the handler at 0x812c. [fw]
 *
 * Only the layer-related ones are named here; the handler also decodes media
 * and system keys (0x2b–0x3e, 0x51–0x54) and a few internal toggles.
 */
export const LAYER_ACTION = {
  /**
   * Momentary: hold for layer `code`, release to go back.
   *
   * The one the factory keymap uses — slot 7 is `f0 ff 01`, i.e. Fn. The
   * previous layer is saved into a 12-entry array at `gp+0x334` indexed by
   * `code`, and release only restores it if the saved layer is lower than the
   * current one.
   */
  momentary: 0xff,
  /**
   * Latch to base layer 0, or to 1 if Fn is held. Also sets the return-to
   * layer for every momentary key to 0.
   *
   * Together with `latchProfileB` this is a two-profile design: profile A is
   * layers {0, 1}, profile B is layers {2, 3}. Unbound in the factory keymap,
   * and the stock driver has no UI for it.
   */
  latchProfileA: 0x04,
  /**
   * The same for base layer 2 (or 3 with Fn held).
   *
   * ⚠ Do not bind this on a Raven61. Layer 2's keymap address collides with the
   * per-key RGB blob and layer 3's with the macro table, so the board starts
   * reading colour or macro bytes as keycodes. Recovery means rewriting the
   * keymap or a factory reset.
   */
  latchProfileB: 0x05,
  /** Toggles the Windows-key lock, global settings byte 6 bit 0. */
  toggleWinLock: 0x02,
} as const

/**
 * Flash layout of the configuration area, from the factory-reset routine at
 * 0x14500 and the 31 command handlers it shares bases with. [fw]
 *
 * Addresses are flash addresses (file offset + 0x5000), the convention
 * `tools/fw/fw.py` uses.
 */
export const FLASH = {
  deviceId: { base: 0x20000, size: 0x100 },
  globalSettings: { base: 0x20100, size: 0x40 },
  calibration: { base: 0x20300, size: 0x200 },
  keyPerf: { base: 0x20700, size: 0x400 },
  /** Two layers of 512. Layer n is `keymap.base + n * KEYMAP_ENTRY.layerStride`. */
  keymap: { base: 0x20b00, size: 0x400, layers: 2 },
  keyRgb: { base: 0x20f00, size: 0x180 },
  macros: { base: 0x21100, size: 0x1000 },
  /**
   * Advanced keys, in three tables indexed by the same record number. The two
   * small ones were down as lighting until the driver's apply path was read:
   * it sends 0xa3, 0xa5 and 0xa7 together, and no LED code in the firmware
   * reads either address. See `protocol/advancedKeys.ts`.
   */
  advancedDks: { base: 0x22100, size: 0x400, recordSize: 24 },
  advancedPair: { base: 0x224f0, size: 0x100, recordSize: 6 },
  advancedToggle: { base: 0x225f0, size: 0x100, recordSize: 3 },
  /** Allocated and zeroed, referenced by no runtime code. */
  reserved: { base: 0x226f0, size: 0x400 },
} as const

/**
 * Where the active layer lives in the global settings block (0x05 / 0x06).
 *
 * Reading it tells you which layer the board is on. Writing it does *not*
 * switch layers: the handler at 0x67d2 copies the block into the live settings
 * struct but never reloads `gp-0x7b6`, and the boot path at 0xa710 zeroes the
 * byte anyway. Left here so a sibling board can be tested for the same thing —
 * if writing it does switch layers there, that is the host-side switch this
 * board lacks.
 */
export const ACTIVE_LAYER_OFFSET = 1

/**
 * What a codec for a profile-capable sibling has to answer before this can be
 * built. Each one is a measurement on that board, not a decision.
 *
 * The order matters: 1 and 2 decide whether profiles are a firmware feature at
 * all on that model, and everything else is wasted work if they come back the
 * same as Raven61.
 *
 *  1. Does its flash reserve N copies of each block, or one? Dump the factory
 *     reset routine the way `tools/fw/fw.py` does here — the addresses it
 *     writes are the whole answer.
 *  2. Which blocks are indexed by the profile: keymap only, or key perf and
 *     lighting too? Look for the profile byte reaching the lookup in the scan
 *     loop, as `gp-0x7b6` does at 0x885e here.
 *  3. Can the host switch profiles, or only a key action? If a command exists,
 *     it is the one thing this app cannot emulate without it.
 *  4. Does the board announce a switch? Raven61 only ever sends `a2 <layer> ff`
 *     and only after a factory reset, so its driver's 0xa1 "profile changed"
 *     handler is dead code. A sibling that really sends 0xa1 would confirm the
 *     driver was written against a different model.
 *  5. Does the selection survive a power cycle? Raven61 persists it to flash
 *     and then zeroes it at boot, which is not the same as persisting it.
 */
export const PROFILE_UNKNOWNS = [
  'flash-copies-per-profile',
  'which-blocks-are-profile-indexed',
  'host-side-switch-command',
  'switch-notification-report',
  'survives-power-cycle',
] as const

export type ProfileUnknown = (typeof PROFILE_UNKNOWNS)[number]

/**
 * What a codec reports about its board's profile support.
 *
 * `kind` is deliberately three-valued rather than a boolean. Raven61 is
 * `'layers'`: it can switch keymaps but calling that a profile would promise
 * the user that their actuation and lighting come along, which they do not.
 */
export interface ProfileSupport {
  kind: 'none' | 'layers' | 'profiles'
  /** How many the board actually has storage for, not how many it will accept. */
  count: number
  /** Which configuration blocks change when the selection changes. */
  scope: readonly ('keymap' | 'keyPerf' | 'advancedKeys' | 'macros' | 'lighting')[]
  /** True when a host command can change the selection, not just a key action. */
  hostSwitchable: boolean
}

/** Raven61, from the firmware. Not hardware-verified. */
export const RAVEN61_PROFILE_SUPPORT: ProfileSupport = {
  kind: 'layers',
  count: 2,
  scope: ['keymap'],
  hostSwitchable: false,
}
