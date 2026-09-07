/**
 * Raven61 packet framing, recovered by static analysis of the stock driver
 * (`Raven Driver.exe`, 32-bit MFC). See docs/protocol.md §2 for the evidence.
 *
 * The stock driver never calls HidD_SetFeature — it opens the HID device with
 * CreateFile and uses WriteFile / ReadFile, i.e. plain OUTPUT and INPUT reports.
 * WebHID's sendReport / inputreport map onto that exactly.
 *
 * Wire layout, per 65-byte buffer handed to WriteFile:
 *
 *   [0]      HID report id (0)
 *   [1]      magic 0x55
 *   [2]      command
 *   [3]      unused in every call site seen so far
 *   [4]      checksum = sum(buffer[5..64]) & 0xFF
 *   [5..64]  60 bytes of command data
 *
 * Dropping the report id, in payload terms (what WebHID hands us):
 *
 *   payload[0]     magic 0x55
 *   payload[1]     command
 *   payload[2]     unused
 *   payload[3]     checksum over payload[4..63]
 *   payload[4..63] data
 *
 * ## Constants and specs
 *
 * The constants below are the *family baseline* — what the Raven61 does, and
 * what a sibling board inherits unless its spec says otherwise. Every function
 * here takes an optional `FrameSpec` / `EventSpec` and falls back to that
 * baseline, so a board that moves the checksum byte or renumbers a command is
 * a spec change rather than a fork of this file. See `src/device/spec.ts`.
 */

import type { CommandSpec, EventSpec, FrameSpec } from '../device/spec'

export const REPORT_ID = 0
export const PAYLOAD_LENGTH = 64

export const MAGIC = 0x55
/** Firmware update uses its own magic. */
export const MAGIC_FIRMWARE = 0x5f
/** First byte of a bare acknowledgement. */
export const ACK = 0xaa
/**
 * First byte of a reply that carries data rather than a bare ack. Observed on
 * hardware for command 0xa9; `payload[1]` then holds the data length.
 */
export const REPLY_DATA = 0xa0

export const OFFSET = {
  magic: 0,
  command: 1,
  reserved: 2,
  checksum: 3,
  data: 4,
} as const

/** Bytes covered by the checksum: payload[4] through payload[63]. */
export const CHECKSUM_RANGE = { start: OFFSET.data, end: PAYLOAD_LENGTH }

/**
 * The framing every function here assumes when a caller names no spec.
 *
 * Declared after the constants rather than instead of them so the evidence
 * above stays attached to the numbers it explains.
 */
export const DEFAULT_FRAME: FrameSpec = {
  reportId: REPORT_ID,
  payloadLength: PAYLOAD_LENGTH,
  magic: MAGIC,
  ack: ACK,
  replyData: REPLY_DATA,
  offsets: { ...OFFSET },
  // BLOCK is declared below; spelled out here to keep this a plain literal.
  block: { length: 4, offsetLo: 5, offsetHi: 6, data: 8 },
}

/**
 * Commands the stock driver sends.
 *
 * The first pass over the binary only followed one send-and-wait helper
 * (0x45a940) and so found only writes. There is a second helper at 0x45ab50,
 * used for exactly the same framing, and **every read command hangs off it** —
 * which is why the earlier table had no way to get anything back off the board.
 *
 * Reads and writes come in pairs, `read = write - 1` for most of them:
 *
 *   0x05 / 0x06   32-byte global settings
 *   0x07 / 0x09   768-byte keymap blob (two layers' worth)
 *   0x0a / 0x0b   384-byte keymap blob (one layer, 128 x 3)
 *   0xa0 / 0xa1   1024-byte per-key performance blob (128 x 8)
 *   0xde / 0xdd   384-byte per-key RGB blob (128 x 3)
 */
export const COMMAND = {
  /** Opens every transaction in every command function. */
  begin: 0x01,
  /** Closes every transaction. Likely "apply" or "commit". */
  end: 0x02,
  /**
   * Reads the firmware's own build identity — the only thing on the board that
   * answers "which firmware is this".
   *
   * The stock driver never sends it, so the first pass over the binary did not
   * find it. It came out of the firmware: the dispatch table at 0x157b0 sends
   * 0x03 to 0x667c, which copies three NUL-terminated strings out of flash into
   * the reply and joins them with commas —
   *
   *   0x15658  `HALL_HS_USB_KB`   the build's own name
   *   0x15668  `Nov 13 2024`      the compiler's __DATE__
   *   0x15674  `11:05:59`         the compiler's __TIME__
   *
   * then writes the total length to `payload[4]`, so the reply is shaped like
   * any other block read: length at BLOCK.length, bytes from BLOCK.data.
   *
   * There is no version *number* anywhere in it. The build date is the whole of
   * what the board can say about itself, which is why this app shows exactly
   * that and does not dress it up as a version.
   *
   * The handler only ever stores into the reply buffer — no flash write, no
   * state — so unlike the rest of the table this one is safe to send.
   */
  readFirmware: 0x03,
  /**
   * Reads the 256-byte identity page at flash 0x20000: VID, PID, bcdDevice,
   * then the build date and time as NUL-padded strings. 0xb0 is the same read
   * and 0xb1 writes it, which is why 0xb1 is in DANGEROUS_COMMANDS.
   *
   * Handler 0x74de, a plain block read with the base as a constant. [fw]
   */
  readDeviceId: 0x04,
  /** Reads the 32-byte global settings block that 0x06 writes back. */
  readGlobalSettings: 0x05,
  /** Sent by the function that reads reporte_rate, tick_rate, dead_zone, disable_win… */
  globalSettings: 0x06,
  /**
   * Reads the *factory default* keymap out of code flash (0x177f4), not the
   * keymap the board is running. The two handlers are byte-identical apart
   * from their base address: 0x68d0 reads 0x177f4, and 0x08's handler at
   * 0x694c reads the live blob at 0x20b00. [fw]
   *
   * That makes it the stable source for the slot map (spec 4.6) — remapping a
   * key cannot move it — but it is the wrong command to show a user their own
   * layout with. Use readKeymapLive for that.
   */
  readKeymapDefaults: 0x07,
  /** Reads the live keymap: 2 layers x 512 bytes at flash 0x20b00. [fw] */
  readKeymapLive: 0x08,
  /** Writes it back. The handler caps the transfer at 0x400, i.e. both layers. [fw] */
  writeKeymapLive: 0x09,
  /**
   * Per-key custom RGB: 128 entries x 3 bytes at flash 0x20f00, capped at 0x180.
   *
   * An earlier pass called this a keymap layer, because it is 384 bytes of
   * 3-byte records in the same address range and reads back all zero. The LED
   * path settles it: 0x135f8 loads [key*3+0..2] straight into the R/G/B
   * registers. All zero means no custom colours, not an unassigned layer. [fw]
   */
  readKeyRgb: 0x0a,
  writeKeyRgb: 0x0b,
  /** Macro storage: a 32-slot u16 offset table then bodies, 4 KB at 0x21100. [fw] */
  readMacros: 0x0c,
  writeMacros: 0x0d,
  /**
   * Reads the 1024-byte per-key performance blob — actuation, rapid trigger,
   * dead zones and switch type for all 128 key slots. See keyPerf.ts.
   *
   * Shares its byte with REPLY_DATA, the marker on unsolicited analog events.
   * Direction disambiguates: a reply to this command starts with 0xAA, an event
   * starts with 0xA0, so `isReplyTo` never confuses the two.
   */
  readKeyPerf: 0xa0,
  /** Writes the same blob back. Whole-blob replacement, not per-key. */
  writeKeyPerf: 0xa1,
  /**
   * DKS records: 1 KB at flash 0x22100, 42 of 24 bytes.
   *
   * Read out of the firmware rather than the driver, which is why an earlier
   * pass had 0xa3 down as lighting. A keymap entry of type 0x90 indexes this
   * table by record — `0x22100 + entry[1] * 24` at 0x88b6 — and 1024 / 24 = 42
   * matches the driver's "40 advanced keys per profile" limit with two
   * spare. [fw]
   */
  readAdvancedDks: 0xa2,
  writeAdvancedDks: 0xa3,
  /**
   * The other half of the advanced keys, **not lighting**: 256 bytes at flash
   * 0x224f0, 42 records of 6 for MT, RS, SOCD and OKS.
   *
   * Two things settle it. The stock driver never sends 0xa5 on its own — all
   * three of its apply paths (0x429a60, 0x42a740, 0x42b560) send 0xa3, 0xa5 and
   * 0xa7 in a row. And in the firmware the only code that reads 0x224f0 is the
   * MT handler at 0x8e72 and the RS/SOCD/OKS handlers at 0x9a52, 0x9c48 and
   * 0x9d94; no LED path touches it. See `protocol/advancedKeys.ts`. [fw]
   */
  readAdvancedPair: 0xa4,
  writeAdvancedPair: 0xa5,
  /**
   * The third advanced-key table: 256 bytes at flash 0x225f0, 42 records of 3,
   * one keymap record each, read only by the toggle handler at 0x8cca. [fw]
   */
  readAdvancedToggle: 0xa6,
  writeAdvancedToggle: 0xa7,
  /**
   * Analog test mode, confirmed on hardware.
   *
   * The driver picks one of these from a runtime flag (0x429f20), so they are a
   * toggle pair. 0xa8 puts the board into the mode that streams analog key
   * events; 0xa9 returns it to normal. The earlier guess had them the other way
   * round, on the reasoning that 0xa9 answers with data — but the data was an
   * analog event, not a reply.
   *
   * While in analog test mode the board stops acting as a keyboard: keys report
   * travel but type nothing. That is what the stock driver's magnet-axis test
   * needs, and it is why leaving the mode on is not harmless.
   */
  analogTestOn: 0xa8,
  analogTestOff: 0xa9,
  /**
   * Reads the board's calibration table — 64 records of 8 bytes, the ones the
   * firmware lights the key LEDs from. See protocol/calibration.ts.
   *
   * The stock driver never sends this, which is why the first pass over the
   * binary did not find it. It came out of the firmware instead: the handler at
   * 0x711c is a plain block read of flash 0x20300, the address the boot path at
   * 0xa5aa loads the calibration table from. Nothing else is reachable through
   * it — the base is a constant in the handler — so it cannot write and cannot
   * read anything but that one blob.
   */
  readCalibration: 0xaa,
  /**
   * Writes the per-key RGB blob into RAM at 0x20002624, which the idle task
   * flushes to flash 0x20f00 — the same bytes readKeyRgb / writeKeyRgb reach
   * directly. [fw]
   */
  writeLightRgb: 0xdd,
  /**
   * Reads the *live* LED frame from RAM at 0x200024a4, one buffer earlier than
   * the one 0xdd writes. So it returns what the board is displaying right now,
   * effects included — not the stored custom layer. That is what the periodic
   * 0xde poll in findings.md #20 was watching. [fw]
   */
  readLightRgb: 0xde,
  /**
   * 1 KB at flash 0x226f0. Zeroed by the factory reset and referenced by
   * nothing else in the image: storage the firmware itself never consults. [fw]
   */
  readReserved: 0xf1,
  writeReserved: 0xf2,
} as const

/**
 * Commands that must never end up in a sweep, kept out of COMMAND so they
 * cannot reach KNOWN_COMMANDS and the prober by accident.
 *
 * 0xee is a factory reset. The stock driver sends it alone from job 0x0c
 * (0x443540), sleeps 1 s then 5 s, and re-reads every blob afterwards.
 */
export const DANGEROUS_COMMANDS = {
  factoryReset: 0xee,
  /**
   * 0xb1 writes the identity page at flash 0x20000 — VID, PID, bcdDevice.
   * Handler 0x70b6. Nothing here needs it, and a bad write is not something a
   * factory reset undoes: the reset routine at 0x14500 never touches 0x20000.
   */
  writeDeviceId: 0xb1,
} as const

export function checksum(payload: ArrayLike<number>, frame: FrameSpec = DEFAULT_FRAME): number {
  let sum = 0
  for (let i = frame.offsets.data; i < frame.payloadLength; i++) sum += payload[i] ?? 0
  return sum & 0xff
}

/**
 * Block transfer layout, recovered from the 0x0b command builder at 0x429130.
 *
 * Most commands are not standalone operations at all: they move a byte range in
 * or out of a firmware blob, one 56-byte chunk per packet.
 *
 *   payload[4]     chunk length (0x38 = 56; the final chunk is shorter)
 *   payload[5..6]  destination offset inside the blob, little-endian 16-bit
 *   payload[7]     unused
 *   payload[8..63] the chunk data
 *
 * The driver's 0x0b transfer is 7 chunks: six of 56 bytes and a last one of 48,
 * so 384 bytes total. Several command builders loop to 128, which makes 384 a
 * clean 128 slots x 3 bytes — and 128 covers the whole key address space, since
 * key indices run to 109.
 */
export const BLOCK = {
  length: 4,
  offsetLo: 5,
  offsetHi: 6,
  data: 8,
} as const

/** Bytes of blob data one packet can carry, with the default framing. */
export const BLOCK_CHUNK = PAYLOAD_LENGTH - BLOCK.data

/** The same, for a board whose payload or header offsets differ. */
export function blockChunkSize(frame: FrameSpec = DEFAULT_FRAME): number {
  return frame.payloadLength - frame.block.data
}

/**
 * Builds one chunk of a block transfer. Pass no data to request a read.
 */
export function buildBlock(
  command: number,
  offset: number,
  data?: ArrayLike<number>,
  opts: { magic?: number; length?: number; frame?: FrameSpec } = {},
): Uint8Array {
  const frame = opts.frame ?? DEFAULT_FRAME
  const limit = blockChunkSize(frame)
  const len = opts.length ?? data?.length ?? 0
  if (len > limit) {
    throw new RangeError(`chunk of ${len} bytes exceeds the ${limit}-byte limit`)
  }
  if (offset < 0 || offset > 0xffff) throw new RangeError(`offset ${offset} is out of range`)
  const payload = new Uint8Array(frame.payloadLength)
  payload[frame.offsets.magic] = opts.magic ?? frame.magic
  payload[frame.offsets.command] = command
  payload[frame.block.length] = len
  payload[frame.block.offsetLo] = offset & 0xff
  payload[frame.block.offsetHi] = (offset >> 8) & 0xff
  if (data) payload.set(Array.from(data as ArrayLike<number>), frame.block.data)
  payload[frame.offsets.checksum] = checksum(payload, frame)
  return payload
}

/**
 * Splits a blob into the chunk sequence the stock driver uses: full 56-byte
 * chunks with a shorter final one, at ascending offsets.
 *
 * Matches every read loop in the binary — 0xa0 becomes 18 x 56 + 16 = 1024,
 * 0x07 becomes 13 x 56 + 40 = 768, 0x0a 6 x 56 + 48 = 384.
 */
export interface BlockChunk {
  offset: number
  length: number
}

export function chunkPlan(total: number, chunk: number = BLOCK_CHUNK): BlockChunk[] {
  if (total < 0) throw new RangeError(`blob size ${total} is negative`)
  const out: BlockChunk[] = []
  for (let offset = 0; offset < total; offset += chunk) {
    out.push({ offset, length: Math.min(chunk, total - offset) })
  }
  return out
}

/**
 * Extracts the data a block-read reply carries.
 *
 * A reply is NOT the request layout: the read wrapper strips the leading report
 * id, so the buffer starts at payload[0] = 0xAA. The header then repeats in the
 * same slots as the request — command at [1], length at [4], offset at [5..6] —
 * and the chunk sits at payload[8..63], exactly where a write would put it.
 *
 * The declared length is only trusted as far as the caller's expectation: the
 * stock driver ignores it and copies into its own cursor, so a firmware that
 * pads or rounds cannot shift the blob.
 */
export function blockReplyData(
  payload: ArrayLike<number>,
  length: number,
  frame: FrameSpec = DEFAULT_FRAME,
): Uint8Array {
  const out = new Uint8Array(Math.min(length, blockChunkSize(frame)))
  for (let i = 0; i < out.length; i++) out[i] = payload[frame.block.data + i] ?? 0
  return out
}

/** Offset and length the reply says it carries — useful for logging mismatches. */
export function blockReplyHeader(
  payload: ArrayLike<number>,
  frame: FrameSpec = DEFAULT_FRAME,
): BlockChunk {
  return {
    offset: ((payload[frame.block.offsetHi] ?? 0) << 8) | (payload[frame.block.offsetLo] ?? 0),
    length: payload[frame.block.length] ?? 0,
  }
}

/**
 * Commands that answer with data rather than a bare ack.
 *
 * These go through the driver's second send-and-wait helper (0x45ab50) and are
 * believed read-only: their request carries a length and an offset but no data.
 * "Believed" because it has not been confirmed on hardware, so they are
 * deliberately left out of SAFE_COMMANDS — the prober still flags them.
 *
 * The exceptions are 0x03 and 0xaa, whose handlers were read in the firmware
 * rather than inferred from the driver. Those two are in SAFE_COMMANDS.
 */
export const READ_COMMANDS: readonly number[] = [
  COMMAND.readFirmware,
  COMMAND.readGlobalSettings,
  COMMAND.readDeviceId,
  COMMAND.readKeymapDefaults,
  COMMAND.readKeymapLive,
  COMMAND.readKeyRgb,
  COMMAND.readMacros,
  COMMAND.readKeyPerf,
  COMMAND.readAdvancedDks,
  COMMAND.readAdvancedPair,
  COMMAND.readAdvancedToggle,
  COMMAND.readLightRgb,
  COMMAND.readReserved,
  COMMAND.analogTestOff,
  COMMAND.readCalibration,
]

/**
 * Commands with no observed side effect, safe to send repeatedly.
 *
 * Everything else is a block transfer, and an all-zero payload is still a
 * write — it just writes zeros at offset 0. That is the likely cause of the LED
 * configuration changing during a blind sweep: the lighting blob's first bytes
 * were overwritten. Excluding 0xa5 / 0xa7 / 0xdd was not enough, because the
 * rest of the family writes too.
 *
 * 0xa8 is deliberately not here. It writes nothing, but it stops the board from
 * typing until 0xa9 follows, which is not something a sweep should do behind
 * the user's back.
 *
 * 0xaa and 0x03 are here on stronger grounds than the rest: both handlers were
 * read in the firmware (0x711c, 0x667c) and only copy bytes out of flash into
 * the reply. There is no path through either that writes.
 *
 * ⚠ 0xa9 is *not* as harmless as its name suggests, and it is here anyway. As
 * well as leaving the test mode it sets the flag at gp-0x72a, which the main
 * loop turns into a flash write of the whole calibration table (0x14810). That
 * is what the mode is for — a calibration pass that was not saved would be
 * pointless — but it does mean 0xa9 commits whatever the pass learned.
 */
export const SAFE_COMMANDS: readonly number[] = [0x01, 0x02, 0x03, 0xa9, 0xaa]

/** All command bytes the driver is known to send, in ascending order. */
export const KNOWN_COMMANDS: readonly number[] = Object.values(COMMAND).sort((a, b) => a - b)

/** Commands that may overwrite a firmware blob when sent with an empty payload. */
export const WRITES_STATE: readonly number[] = KNOWN_COMMANDS.filter(
  (c) => !SAFE_COMMANDS.includes(c),
)


export interface PacketOptions {
  magic?: number
  reserved?: number
  /** Placed at payload[4] onwards. Longer input is rejected, not truncated. */
  data?: ArrayLike<number>
  /** Offset within the data area to place `data` at. */
  dataOffset?: number
  frame?: FrameSpec
}

/** Builds a complete 64-byte payload with a valid checksum. */
export function buildPacket(command: number, opts: PacketOptions = {}): Uint8Array {
  const frame = opts.frame ?? DEFAULT_FRAME
  const { magic = frame.magic, reserved = 0, data, dataOffset = 0 } = opts
  const payload = new Uint8Array(frame.payloadLength)
  payload[frame.offsets.magic] = magic
  payload[frame.offsets.command] = command
  payload[frame.offsets.reserved] = reserved
  if (data) {
    const start = frame.offsets.data + dataOffset
    if (start + data.length > frame.payloadLength) {
      throw new RangeError(
        `data of ${data.length} bytes at offset ${dataOffset} overflows the ${frame.payloadLength}-byte payload`,
      )
    }
    payload.set(Array.from(data as ArrayLike<number>), start)
  }
  payload[frame.offsets.checksum] = checksum(payload, frame)
  return payload
}

/** Recomputes the checksum of an existing payload in place. */
export function sign(payload: Uint8Array, frame: FrameSpec = DEFAULT_FRAME): Uint8Array {
  payload[frame.offsets.checksum] = checksum(payload, frame)
  return payload
}

export function isAck(payload: ArrayLike<number>, frame: FrameSpec = DEFAULT_FRAME): boolean {
  return payload[0] === frame.ack
}

/**
 * A command reply is the request echoed back with payload[0] replaced by 0xAA,
 * so the command byte comes back in payload[1]. Confirmed on hardware: sending
 * `55 a9 00 38 38 00 …` answers `aa a9 00 38 38 00 …`.
 */
export function isReplyTo(
  command: number,
  payload: ArrayLike<number>,
  frame: FrameSpec = DEFAULT_FRAME,
): boolean {
  return payload[0] === frame.ack && payload[1] === command
}

/**
 * The board also emits reports nobody asked for, starting with 0xA0. The stock
 * driver has a separate polling loop for them (0x42c8a0: read with a 10 ms
 * timeout, no write, then dispatch on payload[1..3]) — they are events, not
 * replies, and must not be mistaken for one.
 */
export function isEvent(payload: ArrayLike<number>, frame: FrameSpec = DEFAULT_FRAME): boolean {
  return payload[0] === frame.replyData
}

export interface Reply {
  kind: 'ack' | 'data' | 'unknown'
  /** For an ack, the command being acknowledged. */
  command?: number
  /** For a data reply, the declared length and the bytes themselves. */
  length?: number
  data?: Uint8Array
}

/**
 * Classifies a reply. Two shapes have been seen on hardware:
 *   aa <cmd> 00 …        bare acknowledgement
 *   a0 <len> 00 <?> …    data reply, `len` bytes starting at payload[4]
 */
export function parseReply(payload: Uint8Array, frame: FrameSpec = DEFAULT_FRAME): Reply {
  if (payload[0] === frame.ack) return { kind: 'ack', command: payload[1] }
  if (payload[0] === frame.replyData) {
    const length = payload[1] ?? 0
    const start = frame.offsets.data
    return {
      kind: 'data',
      length,
      data: payload.slice(start, Math.min(start + length, frame.payloadLength)),
    }
  }
  return { kind: 'unknown' }
}

/**
 * Field layout of an analog key event, established by cross-checking Esc, A and
 * Space presses on hardware. Multi-byte fields are big-endian here, unlike the
 * little-endian offset in a block transfer.
 */
export const EVENT = {
  /** Event kind — see EVENT_TYPE. Not a length, despite looking like one. */
  type: 1,
  /**
   * HID modifier bitmask, and the answer to "how do you identify a modifier".
   *
   * Recovered from the stock driver's event resolver at 0x426050: it indexes a
   * 128-byte table at 0x426110 with `payload[2] - 1`, and the only entries that
   * are not the default sit at indices 0, 1, 3, 7, 15, 31, 63 and 127 — that is,
   * at `payload[2]` of 1, 2, 4, 8, 16, 32, 64 and 128. Each returns one usage
   * from 0xE0 to 0xE7, in the standard HID modifier order.
   */
  modifiers: 2,
  /** HID usage of the key — the same addressing the stock database uses. */
  usage: 3,
  /**
   * Linearised travel, BE16, 0 … 800 — the firmware calls the same quantity
   * into being as `delta / scale` and clamps it at 800 (0xe7ac).
   *
   * "Proportional to (baseline − live) by a per-key gain" was the right shape
   * with the factor upside down: the gain measured on hardware (Esc 1.151, A
   * 1.371, Space 1.135) is 1 / `calScale`. This is the quantity the depth in
   * `depth` is derived from, through a per-switch-type lookup table.
   */
  travelRaw: 4,
  /** Travel, in the same 0.02 mm counts as the actuation settings. 0 = rest. */
  depth: 7,
  /** Unclear: tracks `depth` on a shallow press, diverges near the bottom. */
  unknown8: 8,
  /** 0x01 while pressing down, 0xff while releasing. */
  direction: 9,
  /**
   * The firmware's own calibration verdict for this key — the byte it lights
   * the key LED from. See protocol/calibration.ts for the state machine.
   *
   * Read out of the firmware's event builder at 0xdec2, which copies it
   * straight from the calibration record. The stock driver's debug format
   * string calls this field `check_count`, which is where the earlier name came
   * from; the firmware never counts anything into it.
   */
  calState: 10,
  /**
   * `calScale` as three decimal digits: units, tenths, hundredths.
   *
   * The firmware builds them at 0xdeda by truncating the float and multiplying
   * the remainder by ten, twice. The stock driver reassembles them with a
   * `"%d%d%d"` format, which is why its UI shows a bare integer — 62 for a key
   * still at the shipped 0.62.
   *
   * This is what the earlier "per-key sensor descriptor" was: Esc 8/6 is
   * scale 0.86, A 7/2 is 0.72, Space 8/8 is 0.88. It explained itself — two
   * keys can share a value because two keys can have the same scale, and LCtrl
   * moving from 0x0805 to 0x0806 after a pass was its scale improving from
   * 0.85 to 0.86, which is exactly what a pass is supposed to do.
   */
  scaleUnits: 11,
  scaleTenths: 12,
  scaleHundredths: 13,
  /**
   * Full travel in counts, BE16.
   *
   * Not always 200: the firmware reads it from the stroke table at 0x15e08
   * indexed by the key's switch type (0xdd62), so it is 200 for the 4.00 mm
   * switches and 167 / 170 / 175 / 190 for the shorter ones. Every key on the
   * boards sampled so far happened to be a 4.00 mm type.
   */
  travel: 14,
  /** Live ADC reading, BE16. Falls as the key goes down. */
  adc: 16,
  /** Resting ADC baseline for this key, BE16. Constant per key. */
  adcBaseline: 18,
} as const

/** `payload[1]`. The two event kinds the stock driver's resolver accepts. */
export const EVENT_TYPE = {
  /** A travel event for one key. */
  key: 0x10,
  /** Fn. It has no HID usage at all, so it gets its own kind. */
  fn: 0xf0,
} as const

/** `payload[2]` for an Fn event, and the usage this project gives Fn. */
export const FN_SELECTOR = 0xff
export const FN_USAGE = 0xff

/** Bit n of `payload[2]` is HID usage 0xE0 + n: LCtrl, LShift, LAlt, LGui, R…. */
export const MODIFIER_BASE_USAGE = 0xe0

/** Full travel, used when the board has not been calibrated and reports none. */
export const DEFAULT_TRAVEL_COUNTS = 200

/** The event layout `parseKeyEvent` assumes when a caller names no spec. */
export const DEFAULT_EVENT: EventSpec = {
  ...EVENT,
  kind: { ...EVENT_TYPE },
  fnSelector: FN_SELECTOR,
  modifierBaseUsage: MODIFIER_BASE_USAGE,
  defaultTravelCounts: DEFAULT_TRAVEL_COUNTS,
}

/**
 * The command table as a spec section.
 *
 * `COMMAND` above is a catalog of everything the family is known to answer to,
 * including the blocks this app does not decode yet; this is the subset the
 * engine dispatches on, named by job. `factoryReset` comes from
 * DANGEROUS_COMMANDS rather than COMMAND for the reason given there — it must
 * not reach the prober's sweep.
 */
export const DEFAULT_COMMANDS: CommandSpec = {
  begin: COMMAND.begin,
  end: COMMAND.end,
  readFirmware: COMMAND.readFirmware,
  readGlobalSettings: COMMAND.readGlobalSettings,
  writeGlobalSettings: COMMAND.globalSettings,
  readKeymapDefaults: COMMAND.readKeymapDefaults,
  readKeymapLive: COMMAND.readKeymapLive,
  writeKeymapLive: COMMAND.writeKeymapLive,
  readKeyPerf: COMMAND.readKeyPerf,
  writeKeyPerf: COMMAND.writeKeyPerf,
  readKeyRgb: COMMAND.readKeyRgb,
  writeKeyRgb: COMMAND.writeKeyRgb,
  readAdvancedDks: COMMAND.readAdvancedDks,
  writeAdvancedDks: COMMAND.writeAdvancedDks,
  readAdvancedPair: COMMAND.readAdvancedPair,
  writeAdvancedPair: COMMAND.writeAdvancedPair,
  readAdvancedToggle: COMMAND.readAdvancedToggle,
  writeAdvancedToggle: COMMAND.writeAdvancedToggle,
  readLightFrame: COMMAND.readLightRgb,
  readCalibration: COMMAND.readCalibration,
  analogTestOn: COMMAND.analogTestOn,
  analogTestOff: COMMAND.analogTestOff,
  factoryReset: DANGEROUS_COMMANDS.factoryReset,
}

export interface KeyEvent {
  /**
   * HID usage of the key. Real for every key, including the modifiers and Fn:
   * `payload[3]` carries it for ordinary keys, and for the eight that leave it
   * at 0x00 / 0x01 the modifier bitmask in `payload[2]` supplies it instead.
   */
  usage: number
  /** `payload[1]`. */
  type: number
  /** `payload[2]` — the modifier bitmask, 0 or non-single-bit for other keys. */
  modifierBits: number
  /**
   * False when the board reported no total stroke at all, so travel falls back
   * to the nominal 200 counts and the depth shown is a guess.
   *
   * The name is now known to be wrong, and it is kept only because the
   * fallback it drives is still right. The firmware fills payload[14..15] from
   * the switch-stroke table indexed by the key's switch type (0xdd62), and the
   * only entry that is 0 is type 7 — which the config validator should never
   * let through, since it forces anything above 6 back to 1 (0xe288). So a zero
   * here means the board is reporting a switch type it should not have, not
   * that the key is uncalibrated. For calibration, read `calState` and
   * `calScale`, or the table via COMMAND.readCalibration.
   */
  calibrated: boolean
  /**
   * payload[12..13] — the tenths and hundredths digits of `calScale`, kept as
   * one number because that is what identifies a key that reports no usage.
   *
   * Not an address, and now we know why it drifts: it is two digits of a
   * calibrated value, so it moves whenever the calibration improves. Anything
   * built on it, `fingerprint` included, is valid until the next pass and no
   * longer. See EVENT.scaleUnits.
   */
  sensorId: number
  /**
   * The firmware's calibration verdict for this key: 0 and 1 are the states it
   * lights the LED red and amber for, 0xFF means calibrated. See
   * protocol/calibration.ts.
   */
  calState: number
  /**
   * ADC counts the sensor moves per 1/800 of full travel, as the board has
   * learned it. Reassembled from payload[11..13], so it carries two decimals.
   *
   * This is the number a calibration pass is actually changing.
   */
  calScale: number
  /**
   * Identity for a key the event does not name: the sensor descriptor plus the
   * resting ADC baseline, which differs per key. Only meaningful when
   * `usageIsReal` is false.
   */
  fingerprint: string
  /** True when `usage` is a real HID usage rather than a 0x00 / 0x01 placeholder. */
  usageIsReal: boolean
  /**
   * False for an event that cannot name a key by any route: no usage, no
   * modifier bit, and no resting ADC to fingerprint against.
   *
   * The board emits these — `0601:0` shows up steadily on a working keyboard
   * with every key reporting normally. Whatever they are, they are not key
   * travel, and treating them as an unbound sensor produced a warning that
   * could never be acted on. Consumers that identify keys should skip them;
   * the diagnostic tabs still show them, labelled.
   */
  identifiable: boolean
  /** Travel in 0.02 mm counts, 0 … travelCounts. */
  depthCounts: number
  depthMm: number
  /** Full travel in counts (200) and mm (4.00). */
  travelCounts: number
  travelMm: number
  direction: 'down' | 'up'
  adc: number
  adcBaseline: number
  /**
   * Linearised travel, 0 … 800, before the switch-type curve turns it into
   * `depthCounts`. Equals `(adcBaseline - adc) / calScale`, clamped.
   */
  travelRaw: number
  pressed: boolean
}

const be16 = (p: ArrayLike<number>, i: number) => ((p[i] ?? 0) << 8) | (p[i + 1] ?? 0)

/**
 * Counts are 0.02 mm, the same unit the actuation settings use.
 *
 * The default matches `COUNTS_PER_MM` in encoding.ts; a board with a different
 * step passes its own through `parseKeyEvent`'s `countsPerMm`.
 */
const COUNT_MM = 0.02

/**
 * HID usage for an event, from the two fields that carry it.
 *
 * `payload[3]` names ordinary keys. The seven modifiers leave it at 0x00 and Fn
 * at 0x01, because HID has no keycode-array usage for them — and `payload[2]`
 * carries the modifier bit instead. The stock driver reads it the same way
 * (0x426050), except that it lets the bitmask win outright; here `payload[3]`
 * wins whenever it holds a real usage, so a modifier held down during another
 * key's event cannot rename that key.
 */
function usageOf(type: number, selector: number, usageByte: number, event: EventSpec): number {
  if (usageByte > 0x01) return usageByte
  if (type === event.kind.fn || selector === event.fnSelector) return FN_USAGE
  // A single set bit is a modifier; anything else leaves the usage as it came.
  if (selector !== 0 && (selector & (selector - 1)) === 0) {
    return event.modifierBaseUsage + Math.log2(selector)
  }
  return usageByte
}

/**
 * Decodes an analog key event. Returns null for anything that is not one.
 *
 * The kind in `payload[1]` is what separates an event from a command reply —
 * both start with 0xA0. Total stroke is deliberately *not* used for that: a
 * board was seen reporting 0 there, and rejecting on it discarded every event
 * until a calibration pass had run, which looked exactly like a dead stream.
 * (Why it was 0 is still open — see `calibrated`.)
 */
export function parseKeyEvent(
  payload: ArrayLike<number>,
  event: EventSpec = DEFAULT_EVENT,
  frame: FrameSpec = DEFAULT_FRAME,
  countsPerMm = 1 / COUNT_MM,
): KeyEvent | null {
  const countMm = 1 / countsPerMm
  if (payload[0] !== frame.replyData) return null
  const type = payload[event.type] ?? 0
  if (type !== event.kind.key && type !== event.kind.fn) return null
  const reported = be16(payload, event.travel)
  const travelCounts = reported === 0 ? event.defaultTravelCounts : reported
  const depthCounts = payload[event.depth] ?? 0
  const selector = payload[event.modifiers] ?? 0
  const usage = usageOf(type, selector, payload[event.usage] ?? 0, event)
  const tenths = payload[event.scaleTenths] ?? 0
  const hundredths = payload[event.scaleHundredths] ?? 0
  const sensorId = (tenths << 8) | hundredths
  const adcBaseline = be16(payload, event.adcBaseline)
  return {
    usage,
    type,
    modifierBits: selector,
    calibrated: reported !== 0,
    sensorId,
    fingerprint: `${sensorId.toString(16).padStart(4, '0')}:${adcBaseline}`,
    usageIsReal: usage > 0x01,
    // A key always has a stored resting ADC. Without one, and without a usage,
    // there is nothing left to identify it by.
    identifiable: usage > 0x01 || adcBaseline !== 0,
    depthCounts,
    depthMm: depthCounts * countMm,
    travelCounts,
    travelMm: travelCounts * countMm,
    direction: payload[event.direction] === 0x01 ? 'down' : 'up',
    adc: be16(payload, event.adc),
    adcBaseline,
    travelRaw: be16(payload, event.travelRaw),
    calState: payload[event.calState] ?? 0,
    // Digits, not a fixed-point number: the firmware truncates each one, so
    // reassembling them is exact to two decimals and no further.
    calScale: (payload[event.scaleUnits] ?? 0) + tenths / 10 + hundredths / 100,
    pressed: depthCounts > 0,
  }
}

export function describePacket(payload: ArrayLike<number>): string {
  const cmd = payload[OFFSET.command] ?? 0
  const name = Object.entries(COMMAND).find(([, v]) => v === cmd)?.[0]
  const ok = payload[OFFSET.checksum] === checksum(payload)
  return `magic=0x${(payload[OFFSET.magic] ?? 0).toString(16)} cmd=0x${cmd
    .toString(16)
    .padStart(2, '0')}${name ? ` (${name})` : ''} checksum ${ok ? 'ok' : 'MISMATCH'}`
}
