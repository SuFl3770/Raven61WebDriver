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
 */

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
  /** Reads the 32-byte global settings block that 0x06 writes back. */
  readGlobalSettings: 0x05,
  /** Sent by the function that reads reporte_rate, tick_rate, dead_zone, disable_win… */
  globalSettings: 0x06,
  /** Reads the wide (768-byte) keymap blob; 0x09 writes it. */
  readKeymapWide: 0x07,
  /** 512 bytes, 128 x 4, read with a caller-supplied base offset. Content unconfirmed. */
  readUnknown08: 0x08,
  writeKeymapWide: 0x09,
  /** Reads one 384-byte keymap layer; 0x0b writes it. */
  readKeymapLayer: 0x0a,
  writeKeymapLayer: 0x0b,
  unknown0d: 0x0d,
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
  unknownA3: 0xa3,
  unknownA5: 0xa5,
  unknownA7: 0xa7,
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
  /** Writes the per-key RGB blob. */
  writeLightRgb: 0xdd,
  /** Reads it back. */
  readLightRgb: 0xde,
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
} as const

export function checksum(payload: ArrayLike<number>): number {
  let sum = 0
  for (let i = CHECKSUM_RANGE.start; i < CHECKSUM_RANGE.end; i++) sum += payload[i] ?? 0
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

/** Bytes of blob data one packet can carry. */
export const BLOCK_CHUNK = PAYLOAD_LENGTH - BLOCK.data

/**
 * Builds one chunk of a block transfer. Pass no data to request a read.
 */
export function buildBlock(
  command: number,
  offset: number,
  data?: ArrayLike<number>,
  opts: { magic?: number; length?: number } = {},
): Uint8Array {
  const len = opts.length ?? data?.length ?? 0
  if (len > BLOCK_CHUNK) {
    throw new RangeError(`chunk of ${len} bytes exceeds the ${BLOCK_CHUNK}-byte limit`)
  }
  if (offset < 0 || offset > 0xffff) throw new RangeError(`offset ${offset} is out of range`)
  const payload = new Uint8Array(PAYLOAD_LENGTH)
  payload[OFFSET.magic] = opts.magic ?? MAGIC
  payload[OFFSET.command] = command
  payload[BLOCK.length] = len
  payload[BLOCK.offsetLo] = offset & 0xff
  payload[BLOCK.offsetHi] = (offset >> 8) & 0xff
  if (data) payload.set(Array.from(data as ArrayLike<number>), BLOCK.data)
  payload[OFFSET.checksum] = checksum(payload)
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
export function blockReplyData(payload: ArrayLike<number>, length: number): Uint8Array {
  const out = new Uint8Array(Math.min(length, BLOCK_CHUNK))
  for (let i = 0; i < out.length; i++) out[i] = payload[BLOCK.data + i] ?? 0
  return out
}

/** Offset and length the reply says it carries — useful for logging mismatches. */
export function blockReplyHeader(payload: ArrayLike<number>): BlockChunk {
  return {
    offset: ((payload[BLOCK.offsetHi] ?? 0) << 8) | (payload[BLOCK.offsetLo] ?? 0),
    length: payload[BLOCK.length] ?? 0,
  }
}

/**
 * Commands that answer with data rather than a bare ack.
 *
 * These go through the driver's second send-and-wait helper (0x45ab50) and are
 * believed read-only: their request carries a length and an offset but no data.
 * "Believed" because it has not been confirmed on hardware, so they are
 * deliberately left out of SAFE_COMMANDS — the prober still flags them.
 */
export const READ_COMMANDS: readonly number[] = [
  COMMAND.readGlobalSettings,
  COMMAND.readKeymapWide,
  COMMAND.readUnknown08,
  COMMAND.readKeymapLayer,
  COMMAND.readKeyPerf,
  COMMAND.readLightRgb,
  COMMAND.analogTestOff,
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
 */
export const SAFE_COMMANDS: readonly number[] = [0x01, 0x02, 0xa9]

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
}

/** Builds a complete 64-byte payload with a valid checksum. */
export function buildPacket(command: number, opts: PacketOptions = {}): Uint8Array {
  const { magic = MAGIC, reserved = 0, data, dataOffset = 0 } = opts
  const payload = new Uint8Array(PAYLOAD_LENGTH)
  payload[OFFSET.magic] = magic
  payload[OFFSET.command] = command
  payload[OFFSET.reserved] = reserved
  if (data) {
    const start = OFFSET.data + dataOffset
    if (start + data.length > PAYLOAD_LENGTH) {
      throw new RangeError(
        `data of ${data.length} bytes at offset ${dataOffset} overflows the ${PAYLOAD_LENGTH}-byte payload`,
      )
    }
    payload.set(Array.from(data as ArrayLike<number>), start)
  }
  payload[OFFSET.checksum] = checksum(payload)
  return payload
}

/** Recomputes the checksum of an existing payload in place. */
export function sign(payload: Uint8Array): Uint8Array {
  payload[OFFSET.checksum] = checksum(payload)
  return payload
}

export function isAck(payload: ArrayLike<number>): boolean {
  return payload[0] === ACK
}

/**
 * A command reply is the request echoed back with payload[0] replaced by 0xAA,
 * so the command byte comes back in payload[1]. Confirmed on hardware: sending
 * `55 a9 00 38 38 00 …` answers `aa a9 00 38 38 00 …`.
 */
export function isReplyTo(command: number, payload: ArrayLike<number>): boolean {
  return payload[0] === ACK && payload[1] === command
}

/**
 * The board also emits reports nobody asked for, starting with 0xA0. The stock
 * driver has a separate polling loop for them (0x42c8a0: read with a 10 ms
 * timeout, no write, then dispatch on payload[1..3]) — they are events, not
 * replies, and must not be mistaken for one.
 */
export function isEvent(payload: ArrayLike<number>): boolean {
  return payload[0] === REPLY_DATA
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
export function parseReply(payload: Uint8Array): Reply {
  if (payload[0] === ACK) return { kind: 'ack', command: payload[1] }
  if (payload[0] === REPLY_DATA) {
    const length = payload[1] ?? 0
    return {
      kind: 'data',
      length,
      data: payload.slice(OFFSET.data, Math.min(OFFSET.data + length, PAYLOAD_LENGTH)),
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
  /** Scaled sensor delta, BE16. Proportional to (baseline - live) by a per-key gain. */
  sensorDelta: 4,
  /** Travel, in the same 0.02 mm counts as the actuation settings. 0 = rest. */
  depth: 7,
  /** Unclear: tracks `depth` on a shallow press, diverges near the bottom. */
  unknown8: 8,
  /** 0x01 while pressing down, 0xff while releasing. */
  direction: 9,
  /**
   * Per-key sensor descriptor (Esc 8/6, A 7/2, Space 8/8). NOT an address, on
   * two counts: it is not unique — P and "/" were seen sharing a value — and it
   * is not even stable. LCtrl, recorded at 0x0805, was observed reporting
   * 0x0806 after a calibration pass.
   *
   * So it is a calibration output, most likely a curve or gain selector. Any
   * identity built on it, `adcBaseline` included, is only valid until the next
   * calibration. See docs/protocol.md §3.2.
   */
  sensorHi: 12,
  sensorLo: 13,
  /** Full travel in counts, BE16. Always 200 = 4.00 mm. */
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
   * False when the board reported no total stroke, which happens before it has
   * been calibrated. Travel then falls back to the nominal 200 counts, so the
   * depth shown is a guess rather than a measurement.
   */
  calibrated: boolean
  /** payload[12..13]. A calibration output — see EVENT.sensorHi. */
  sensorId: number
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
  sensorDelta: number
  pressed: boolean
}

const be16 = (p: ArrayLike<number>, i: number) => ((p[i] ?? 0) << 8) | (p[i + 1] ?? 0)

/** Counts are 0.02 mm, the same unit the actuation settings use. */
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
function usageOf(type: number, selector: number, usageByte: number): number {
  if (usageByte > 0x01) return usageByte
  if (type === EVENT_TYPE.fn || selector === FN_SELECTOR) return FN_USAGE
  // A single set bit is a modifier; anything else leaves the usage as it came.
  if (selector !== 0 && (selector & (selector - 1)) === 0) {
    return MODIFIER_BASE_USAGE + Math.log2(selector)
  }
  return usageByte
}

/**
 * Decodes an analog key event. Returns null for anything that is not one.
 *
 * The kind in `payload[1]` is what separates an event from a command reply —
 * both start with 0xA0. Total stroke is deliberately *not* used for that: an
 * uncalibrated board reports 0, and rejecting on it discarded every event until
 * a calibration pass had run, which looked exactly like a dead stream.
 */
export function parseKeyEvent(payload: ArrayLike<number>): KeyEvent | null {
  if (payload[0] !== REPLY_DATA) return null
  const type = payload[EVENT.type] ?? 0
  if (type !== EVENT_TYPE.key && type !== EVENT_TYPE.fn) return null
  const reported = be16(payload, EVENT.travel)
  const travelCounts = reported === 0 ? DEFAULT_TRAVEL_COUNTS : reported
  const depthCounts = payload[EVENT.depth] ?? 0
  const selector = payload[EVENT.modifiers] ?? 0
  const usage = usageOf(type, selector, payload[EVENT.usage] ?? 0)
  const sensorId = ((payload[EVENT.sensorHi] ?? 0) << 8) | (payload[EVENT.sensorLo] ?? 0)
  const adcBaseline = be16(payload, EVENT.adcBaseline)
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
    depthMm: depthCounts * COUNT_MM,
    travelCounts,
    travelMm: travelCounts * COUNT_MM,
    direction: payload[EVENT.direction] === 0x01 ? 'down' : 'up',
    adc: be16(payload, EVENT.adc),
    adcBaseline,
    sensorDelta: be16(payload, EVENT.sensorDelta),
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
