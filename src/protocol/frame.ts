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
 * Commands observed at the 52 call sites of the driver's send-and-wait helper.
 * Only `begin`, `end` and `globalSettings` are identified with confidence; the
 * rest are recorded so the prober can try them deliberately rather than blindly.
 */
export const COMMAND = {
  /** Opens every transaction in every command function. */
  begin: 0x01,
  /** Closes every transaction. Likely "apply" or "commit". */
  end: 0x02,
  /** Sent by the function that reads reporte_rate, tick_rate, dead_zone, disable_win… */
  globalSettings: 0x06,
  unknown09: 0x09,
  unknown0b: 0x0b,
  unknown0d: 0x0d,
  unknownA1: 0xa1,
  unknownA3: 0xa3,
  unknownA5: 0xa5,
  unknownA7: 0xa7,
  /**
   * The driver picks 0xa9 or 0xa8 from a runtime flag, so they are a toggle
   * pair. On hardware 0xa8 answers with a bare ack while 0xa9 answers with
   * data, which fits 0xa9 = start / read and 0xa8 = stop.
   */
  readA9: 0xa9,
  stopA8: 0xa8,
  unknownDD: 0xdd,
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

/** The only command observed to answer with data rather than a bare ack. */
export const READ_COMMANDS: readonly number[] = [0xa9]

/**
 * Commands with no observed side effect, safe to send repeatedly.
 *
 * Everything else is a block transfer, and an all-zero payload is still a
 * write — it just writes zeros at offset 0. That is the likely cause of the LED
 * configuration changing during a blind sweep: the lighting blob's first bytes
 * were overwritten. Excluding 0xa5 / 0xa7 / 0xdd was not enough, because the
 * rest of the family writes too.
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
   * Per-key sensor descriptor (Esc 8/6, A 7/2, Space 8/8). NOT unique — P and
   * "/" were observed sharing a value — so it identifies a key only together
   * with `adcBaseline`. Probably a calibration curve or gain selector rather
   * than an address.
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

export interface KeyEvent {
  /**
   * HID usage of the key, or a placeholder. Modifiers report 0x00 and Fn
   * reports 0x01 — they have no keycode-array usage, since HID carries
   * modifiers in a bitmask instead. Use `sensorId` to tell those apart.
   */
  usage: number
  /** payload[12..13]. Stable per key but shared between some keys. */
  sensorId: number
  /**
   * Identity for a key the event does not name: the sensor descriptor plus the
   * resting ADC baseline, which differs per key. Only meaningful when
   * `usageIsReal` is false.
   */
  fingerprint: string
  /** True when `usage` is a real HID usage rather than a 0x00 / 0x01 placeholder. */
  usageIsReal: boolean
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

/** Decodes an analog key event. Returns null for anything that is not one. */
export function parseKeyEvent(payload: ArrayLike<number>): KeyEvent | null {
  if (payload[0] !== REPLY_DATA) return null
  const travelCounts = be16(payload, EVENT.travel)
  if (travelCounts === 0) return null
  const depthCounts = payload[EVENT.depth] ?? 0
  const usage = payload[EVENT.usage] ?? 0
  const sensorId = ((payload[EVENT.sensorHi] ?? 0) << 8) | (payload[EVENT.sensorLo] ?? 0)
  const adcBaseline = be16(payload, EVENT.adcBaseline)
  return {
    usage,
    sensorId,
    fingerprint: `${sensorId.toString(16).padStart(4, '0')}:${adcBaseline}`,
    usageIsReal: usage > 0x01,
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
