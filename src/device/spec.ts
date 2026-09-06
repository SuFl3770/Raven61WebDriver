/**
 * What a keyboard *is*, as data.
 *
 * Everything this app knew about the Raven61 used to be spread across
 * `src/protocol/*` and `src/keyboard/raven61.ts` as module constants, which
 * meant supporting a second board meant editing the protocol layer. This file
 * is the other half of that split: the protocol layer became an engine that
 * takes one of these, and a board is now a value.
 *
 * ## Adding a board
 *
 * Two ways in, both of them source-level — this app has no runtime importer,
 * so a new board means editing the tree and running the build:
 *
 *   - **TypeScript**, `src/device/boards/<board>/index.ts`. Call `defineDevice` with
 *     what differs from the family baseline and add it to `BUILT_IN_SPECS` in
 *     `src/device/boards/index.ts`. Type-checked, and the only way to express
 *     something the schema cannot.
 *   - **JSON**, `src/device/user/<board>.device.json`. The same shape, picked
 *     up by the glob in `src/device/userSpecs.ts` and validated at startup.
 *     Nothing to register, but nothing to type-check either — the validator is
 *     what stands between a typo and a bad write.
 *
 * See `src/device/README.md` for the walkthrough, and for what has to be
 * measured on a board before each field can be filled in honestly.
 *
 * ## What a spec may and may not change
 *
 * A spec moves numbers: report ids, command bytes, block geometry, bit
 * positions, the key table. It does **not** describe a different *shape* of
 * protocol — the 64-byte framing, the block-transfer header and the 8-byte
 * performance record are this family's skeleton, and a board that does not
 * share them needs a codec of its own rather than a spec. `KeyboardCodec` in
 * `protocol/codec.ts` is where such a codec plugs in.
 */

import type { MessageKey } from '../i18n'
import type { ProfileSupport } from '../protocol/layers'

/**
 * One physical key. Matches the rows `tools/layout/from-vendor-xml.mjs` emits
 * into a board's `layout.json`.
 */
export interface KeyDef {
  /** This table's own ordering, row-major. Every UI index is one of these. */
  index: number
  label: string
  /** Default HID Keyboard/Keypad (page 0x07) usage. 0xff = Fn, which has none. */
  code: number
  /** Position in keyboard units from the top-left. */
  x: number
  y: number
  w: number
  /**
   * Firmware key address. Not the slot a per-key block is indexed by — see
   * `protocol/slotMap.ts`, which reads that off the board — and not `index`
   * either.
   */
  keyIndex: number
  /** Per-key LED address. */
  lightIndex: number
}

export interface LayoutSpec {
  /** Size of the board in keyboard units, for the grid to lay itself out in. */
  units: { width: number; height: number }
  /**
   * Full travel in mm, used when nothing better is known.
   *
   * A fallback, not a fact about every key: `switchTypes[].travelMm` is what a
   * key with a known switch type uses, and this is what a key without one gets.
   */
  travelMm: number
  keys: readonly KeyDef[]
}

/**
 * Packet framing. See `protocol/frame.ts` for what each offset means and how
 * it was recovered.
 */
export interface FrameSpec {
  /** HID report id. 0 on every board seen so far. */
  reportId: number
  /** Payload bytes, excluding the report id. */
  payloadLength: number
  /** First byte of a request. */
  magic: number
  /** First byte of a reply. */
  ack: number
  /** First byte of an unsolicited event, and of a data reply. */
  replyData: number
  offsets: { magic: number; command: number; reserved: number; checksum: number; data: number }
  /** Block-transfer header, inside the same payload. */
  block: { length: number; offsetLo: number; offsetHi: number; data: number }
}

/**
 * Command bytes.
 *
 * Named by what they do rather than by their value, so a board that numbers
 * them differently only changes the numbers. A command left `null` is one the
 * board does not have: the engine then leaves the matching capability off the
 * codec, and the panels say so instead of sending a byte nobody has decoded.
 */
export interface CommandSpec {
  begin: number | null
  end: number | null
  readFirmware: number | null
  readGlobalSettings: number | null
  writeGlobalSettings: number | null
  /** The factory keymap in code flash — what the slot map is built from. */
  readKeymapDefaults: number | null
  readKeymapLive: number | null
  writeKeymapLive: number | null
  readKeyPerf: number | null
  writeKeyPerf: number | null
  readCalibration: number | null
  /** Enters analog test mode: travel is reported, typing stops. */
  analogTestOn: number | null
  /** Leaves it. */
  analogTestOff: number | null
  /** ⚠ Destroys the board's settings. Left `null` unless it has been confirmed. */
  factoryReset: number | null
}

/** Field layout of an analog key event. See `EVENT` in `protocol/frame.ts`. */
export interface EventSpec {
  type: number
  modifiers: number
  usage: number
  travelRaw: number
  depth: number
  direction: number
  calState: number
  scaleUnits: number
  scaleTenths: number
  scaleHundredths: number
  travel: number
  adc: number
  adcBaseline: number
  /** `payload[1]` values that mark an event as a key event and as an Fn event. */
  kind: { key: number; fn: number }
  /** `payload[2]` for Fn, and the usage this app gives it. */
  fnSelector: number
  /** Bit n of the modifier mask is this usage plus n. */
  modifierBaseUsage: number
  /** Stroke in counts to assume when the board reports none. */
  defaultTravelCounts: number
}

/** Geometry and limits of the per-key performance blob. See `protocol/keyPerf.ts`. */
export interface KeyPerfSpec {
  recordSize: number
  slots: number
  /**
   * What each field can hold. These are field widths, not preferences: writing
   * past them wraps, so the encoder saturates and the UI bounds its inputs to
   * the same numbers.
   */
  limits: {
    rtMin: number
    rtMax: number
    deadZoneMin: number
    deadZoneMax: number
    actuationMin: number
    actuationMax: number
  }
  /** `key_mode` on the wire. */
  keyMode: { off: number; rapidTrigger: number; fullStroke: number }
}

/** Geometry of the keymap blocks. See `protocol/keymap.ts` and `protocol/slotMap.ts`. */
export interface KeymapSpec {
  entrySize: number
  /** Records per layer that can name a key. */
  slots: number
  /** Layers with real storage behind them. */
  layers: number
  /** Stride of one layer inside the live block. */
  layerBytes: number
  /** Size of the factory-defaults block, which may span several layers. */
  defaultsBlobSize: number
  /** entry[0] for an ordinary HID key. */
  plainKey: number
  /** entry[0] for a layer key. */
  layerKey: number
  /** entry[1] for Fn. */
  fnSelector: number
  /** Bit n of entry[1] is this usage plus n. */
  modifierBaseUsage: number
}

/** The board-wide settings block. See `protocol/global.ts`. */
export interface GlobalSpec {
  /** Block length the read asks for. */
  length: number
  offsets: {
    rate: number
    deadZone: number
    gameLock: number
    flags: number
    sleep: number
    /** Byte holding the active layer, if the board has one. */
    activeLayer: number | null
  }
  flags: {
    tachyon: number
    bottomOutTrigger: number
    actuationCheck: number
    magnetTest: number
    debounceShift: number
    debounceMask: number
  }
  /** How long the board is left alone after a write, before reading back. */
  settleMs: number
  /**
   * What the block holds after a factory reset, from the firmware's own
   * defaults table. `null` when it has not been read out of an image — a reset
   * then reports what came back rather than checking it against a guess.
   */
  factoryDefaults: {
    reportRate: number
    tickRate: number
    deadZone: number
    flags: number
    debounceLevel: number
    sleepMinutes: number
  } | null
}

export interface MonitorSpec {
  /** Re-send period while holding calibration mode. */
  rearmMs: number
  /** How long to wait for a mode packet to be acknowledged. */
  ackMs: number
}

export interface FactoryResetSpec {
  /** Both waits come from the stock driver; reading sooner reads a busy board. */
  firstWaitMs: number
  secondWaitMs: number
}

/** The board's own calibration table. See `protocol/calibration.ts`. */
export interface CalibrationSpec {
  records: number
  recordSize: number
}

export interface EncodingSpec {
  /** Wire counts per millimetre. 50 on this family: one count is 0.02 mm. */
  countsPerMm: number
}

/**
 * A magnetic switch the board can report.
 *
 * Two of these fields are load-bearing and two are description, and the
 * difference is worth keeping in mind while filling one in. `value` is written
 * to the board and `travelMm` is the stroke every millimetre in this app is
 * divided by — a wrong one of those misreads actuation, rapid trigger and
 * every depth at once. `magnetGauss` and `color` are read by nothing but the
 * switch panel: they exist so a list of eight vendor names reads like the
 * parts in front of you.
 *
 * The descriptive fields are optional because they are *unknown*, not because
 * they are unimportant. A board's table is usually recovered from a driver
 * binary, which carries neither — so leaving one out is the normal case, and
 * the UI prints "—" for it rather than a guess.
 */
export interface SwitchTypeSpec {
  value: number
  name: string
  travelMm: number
  /**
   * False for an entry that decodes but must never be written — a value that
   * exists in a vendor table without a switch behind it.
   */
  selectable: boolean
  /**
   * Magnet strength as the switch's own spec sheet quotes it, in gauss.
   * (Sheets quoting millitesla: 1 mT = 10 G.)
   *
   * Nothing computes with it. Travel and actuation come off the board's own
   * ADC, already calibrated per key, so the magnet never enters the
   * arithmetic — this is here to tell two switches apart and to explain why
   * one of them feels different, and omitting it costs nothing.
   */
  magnetGauss?: number
  /**
   * Who makes it.
   *
   * Its own field rather than part of `name`, because the picker prints it on
   * a line of its own above the name: "GEONWORKS" over "RAW HE" reads as a
   * part from a maker, where one line of "GEONWORKS RAW HE" reads as a string.
   *
   * Description, like the two fields above — nothing is written from it — and
   * optional for the same reason. The stock driver's table is a list of names
   * with no maker attached to any of them, so whatever is here came from
   * somebody who knows the parts, not from the binary.
   */
  vendor?: string
  /**
   * The colour the switch is known by, as a hex colour the swatch is painted
   * with — `#f08a3c` and so on.
   *
   * Cosmetic, and only as trustworthy as whoever filled it in: it identifies a
   * row in a list, and no batch of switches is going to match it exactly.
   * Leave it out unless you have seen the switch — an invented swatch is read
   * as a fact about the part.
   */
  color?: string
}

export interface ReportRateSpec {
  value: number
  hz: number
}

export interface SlotMapSpec {
  /**
   * Slots inside the populated range that no key is wired to. Only the
   * fallback mapping uses them; the real one is read off the board.
   */
  unusedSlots: readonly number[]
  /**
   * How many keys short of the full set a keymap-derived mapping may come and
   * still be trusted. Past this the engine falls back and says so — a
   * half-resolved map puts most keys right and a few wrong, which is the
   * hardest kind of wrong to notice.
   */
  resolveTolerance: number
}

/** How far the protocol has been confirmed on real hardware. */
export type Confidence = 'confirmed' | 'partial' | 'guess' | 'none'

/**
 * How a board talks — and nothing about which board it is.
 *
 * This is the half a second keyboard can inherit: framing, command bytes,
 * block geometry, bit positions, timings. `src/device/protocols/` holds these
 * on their own, and `DeviceSpec` is one of them plus an identity, a key table
 * and the tables that belong to the hardware.
 *
 * The split is the point. "Which keys does it have" and "what does 0xa0 do"
 * are different questions with different evidence behind them, and a board can
 * share the answer to one without sharing the other.
 */
export interface ProtocolSpec {
  frame: FrameSpec
  commands: CommandSpec
  event: EventSpec
  keyPerf: KeyPerfSpec
  keymap: KeymapSpec
  global: GlobalSpec
  monitor: MonitorSpec
  factoryReset: FactoryResetSpec
  calibration: CalibrationSpec
  encoding: EncodingSpec
  slotMap: SlotMapSpec
  /** Default reply timeout for one packet. */
  requestTimeoutMs: number
}

/**
 * One keyboard: a protocol, plus everything that is true of the hardware.
 *
 * `id` is what the app stores and logs; `name` is what it shows. A built-in
 * spec may also carry `labelKey` / `notesKey` to pull its display text from
 * the translation bundles — a user-supplied one cannot, because `MessageKey`
 * is derived from those bundles at compile time, so it uses `name` / `notes`.
 */
export interface DeviceSpec extends ProtocolSpec {
  id: string
  name: string
  notes?: string
  /**
   * The spec whose protocol this one claims to share, when it was built by
   * `defineDevice` or loaded from JSON.
   *
   * Recorded rather than dropped after the merge, because it is a *claim*: it
   * says someone decided this board speaks another board's protocol. Nothing
   * in this app can check that, so the least it can do is remember who said
   * it. See `defineDevice`.
   */
  basedOn?: string
  /**
   * Translation keys for `name` and `notes`.
   *
   * Built-in specs only — `MessageKey` is derived from the reference bundle at
   * compile time, so a spec loaded from JSON has no way to name a key that
   * exists, and the validator rejects the attempt rather than letting a label
   * render blank.
   */
  labelKey?: MessageKey
  notesKey?: MessageKey
  confidence: Confidence
  /**
   * Where the spec came from, for the UI to be honest about. Set by the loader.
   *
   * `forced` is the debug-only case: not a definition of anything, but the
   * default protocol pointed at a device that has none. See `device/forced.ts`.
   */
  origin?: 'built-in' | 'user-json' | 'forced'
  usb: {
    vendorId: number
    /**
     * The product ids this spec speaks to. **Exact match, and nothing else.**
     *
     * There is deliberately no "any product of this vendor" option. One vendor
     * ships several boards, this app has been tested against one of them, and
     * a spec that claimed the vendor would drive an untested sibling with
     * another board's command bytes and key count. A device whose id is not
     * listed here gets no codec at all — see `probe` in protocol/engine.ts.
     *
     * Put an id here only once a board reporting it has actually answered.
     */
    productIds: readonly number[]
  }
  layout: LayoutSpec
  /**
   * Which magnetic switches this board reports, and what is known about each.
   * Built-in boards keep the rows in a `switches.json` beside the spec, loaded
   * and typed by a `switches.ts`.
   */
  switchTypes: readonly SwitchTypeSpec[]
  /** Which polling rates it accepts. */
  reportRates: readonly ReportRateSpec[]
  profileSupport: ProfileSupport
}
