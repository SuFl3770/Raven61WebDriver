import { RAVEN_PRODUCT_IDS, RAVEN_VENDOR_ID } from '../hid/filters'
import type { HidLink } from '../hid/link'
import { t } from '../i18n'
import { RAVEN61_KEYS } from '../keyboard/raven61'
import { CAL_TABLE_BYTES, parseCalTable, type CalRecord } from './calibration'
import type { Raven61Codec } from './codec'
import type {
  FirmwareIdentity,
  GlobalSettings,
  KeyConfig,
  KeyPerfSnapshot,
  KeySample,
} from './types'
import {
  ACK,
  COMMAND,
  DANGEROUS_COMMANDS,
  OFFSET,
  MAGIC,
  PAYLOAD_LENGTH,
  REPORT_ID,
  blockReplyData,
  blockReplyHeader,
  buildBlock,
  buildPacket,
  chunkPlan,
  isAck,
  isReplyTo,
  parseKeyEvent,
  sign,
} from './frame'
import {
  KEY_PERF,
  changedSlots,
  decodeKeyPerfRecord,
  fromKeyConfig,
  isEmptySlot,
  patchSlot,
  recordHex,
  toKeyConfig,
} from './keyPerf'
import { KEYMAP, fallbackSlotMap, slotMapFromKeymap, type SlotMap } from './slotMap'

/**
 * Framing and the per-key performance block are decoded and confirmed on
 * hardware; the keymap, lighting and advanced-key blocks are not.
 *
 * So this codec reads and writes per-key performance settings and streams
 * analog travel, and implements nothing else — the feature panels check with
 * `supports()` and say so rather than showing controls that do nothing.
 */
export const raven61Codec: Raven61Codec = {
  id: 'raven61-v1',
  labelKey: 'codec.raven61.label',
  confidence: 'partial',
  notesKey: 'codec.raven61.notes',

  async probe(link: HidLink) {
    const d = link.device
    if (!d) return false
    // Identification only — a probe runs on every connect and must not write.
    return d.vendorId === RAVEN_VENDOR_ID
  },

  readKeyPerf: readKeyPerfSnapshot,

  async readKeyConfigs(link: HidLink): Promise<KeyConfig[]> {
    return (await readKeyPerfSnapshot(link)).configs
  },

  writeKeyPerf: writeKeyPerfConfigs,

  /**
   * The plain write, for callers that only need "did it work". Throws when the
   * board did not read back what was written, so a failure cannot pass for
   * success — see writeKeyPerfConfigs.
   */
  async writeKeyConfigs(link: HidLink, configs: readonly (KeyConfig | null)[]): Promise<void> {
    const result = await writeKeyPerfConfigs(link, configs)
    if (result.unmapped.length > 0) {
      throw new Error(
        t('raven61.writeUnmapped', {
          count: result.unmapped.length,
          keys: result.unmapped.map((k) => k.label).join(', '),
        }),
      )
    }
    if (result.mismatched.length > 0) {
      throw new Error(
        t('raven61.writeMismatch', {
          count: result.mismatched.length,
          detail: result.mismatched
            .map((m) => `#${m.slot} ${m.wanted} → ${m.got}`)
            .join(', '),
        }),
      )
    }
  },

  restoreKeyPerf: writeKeyPerfBlob,

  readFirmware,
  readGlobalSettings,
  writeGlobalSettings,
  factoryReset,

  /**
   * Enables analog reporting and decodes what comes back.
   *
   * The board does *not* stream on its own — an earlier note in
   * docs/protocol.md §3.2 claiming otherwise was wrong, and only looked right
   * because the stock driver had already enabled it in the same session.
   * See MONITOR and `armAnalogStream` for what gets written.
   */
  async startMonitor(
    link: HidLink,
    onSample: (samples: KeySample[]) => void,
    opts: { arm?: boolean; keepAlive?: boolean } = {},
  ) {
    const off = link.onInput((_reportId, data) => {
      const event = parseKeyEvent(data)
      if (!event) return
      onSample([
        {
          usage: event.usage,
          fingerprint: event.fingerprint,
          sensorId: event.sensorId,
          adcBaseline: event.adcBaseline,
          usageIsReal: event.usageIsReal,
          identifiable: event.identifiable,
          depthMm: event.depthMm,
          raw: event.adc,
          pressed: event.pressed,
        },
      ])
    })
    if (opts.arm === false) return async () => off()
    // Enable before anything else, so a failure here surfaces as a start error
    // rather than as a monitor that silently shows nothing.
    const disarm = await armAnalogStream(link, { keepAlive: opts.keepAlive })
    return async () => {
      off()
      await disarm()
    }
  },
}

/**
 * Analog reporting is a mode the board has to be put into.
 *
 * From the stock driver (`Raven Driver.exe`, 32-bit MFC):
 *
 *   0x429f20  builds a bare packet — magic 0x55, one command byte, 62 zero
 *             bytes — and picks the command from a UI mode flag:
 *               cmp [this+0x541fc], 0 / sete al / add al, 0xa8
 *             so flag 0 sends 0xa9 and flag 1 sends 0xa8.
 *
 *   0x42c8a0  is the event poll loop. Its tail re-sends that packet whenever
 *             more than 0x76c = 1900 ms have passed (0x42cb70), but only while
 *             the UI sits on tab 7 (0x42cb11) — the performance tab.
 *
 * That gating is exactly the reported symptom: a freshly connected board looks
 * dead, and only starts reporting travel once the stock driver's performance
 * tab has been opened.
 *
 * Hardware settled the rest, over two corrections:
 *
 * - 0xa8 turns analog reporting on **and** enters a test mode in which the
 *   board stops typing. Reporting latches; the mode does not.
 * - 0xa9 leaves the mode and gives typing back. Reporting stays on — a board
 *   that has seen one 0xa8 keeps reporting travel afterwards with no further
 *   packets, which is how the monitor can run without killing the keyboard.
 * - Repeating 0xa8 holds the mode, and that is calibration: typing stays off
 *   and every key pressed to the bottom has its baseline rewritten. The stock
 *   driver's 1900 ms loop (0x42cb80) is gated on its own analog-mode flag
 *   (0x42cb1a) and belongs to that path, not to plain monitoring.
 *
 * So one command covers both behaviours, and the difference is how long the
 * mode is held. `armAnalogStream` takes `keepAlive` for the calibration case.
 */
export const MONITOR = {
  /**
   * Enables analog reporting — which latches — and enters the test mode that
   * suppresses typing, which does not. Bare packet, no data, checksum 0.
   */
  arm: COMMAND.analogTestOn,
  /** Leaves the test mode. Typing returns; reporting stays on. */
  disarm: COMMAND.analogTestOff,
  /**
   * Re-send period for calibration mode only. The driver uses 1900 ms
   * (0x42cb70); stay comfortably inside it.
   */
  rearmMs: 1500,
  /**
   * How long to wait for a mode packet to be acknowledged.
   *
   * Measured worst case is 0xa9's flash write at 34.5 ms, so this is an order
   * of magnitude of headroom rather than a tight bound — the point is to hold
   * the link queue until the board is listening again, not to time it.
   */
  ackMs: 400,
} as const

/**
 * The flag byte the stock driver writes when its performance tab opens.
 *
 * NOT required to start the stream — hardware showed that no value of this byte
 * makes travel arrive without 0xa8, and that 0xa8 works without it. Kept as a
 * record of what the stock driver does on a tab change, and as something the
 * monitor can send deliberately:
 *
 *   0x43933c  entering tab 7 queues job 0x0e
 *   0x442f00  job 0x0e dispatches to 0x429560
 *   0x429560  sends 0x01, then 0x06, waits 400 ms, then 0x02
 *
 * That 0x06 packet carries four data bytes, at payload[12..15], and payload[15]
 * is built from UI state: bits 0-1 from `perf_bottomrapidtrigger_mode`, bit 2
 * from `actuation_check`, bit 3 from the magnet-axis test, bit 5 from
 * `debounce_level`. The analog-mode flag forces bits 2 and 3 on together
 * (`or bl, 0xc` at 0x42994e), which is the state a calibration pass leaves.
 *
 * ⚠ **The "independent fields" reasoning that used to be here was wrong.** It
 * claimed the other 0x06 call site (0x428a30) leaves payload[12..15] zero, and
 * that switching tabs therefore cannot be resetting the report rate. In fact
 * both call sites copy the 0x05 reply into the write buffer before editing it
 * (0x42960a and 0x428b13), so neither writes a sparse block and nothing was
 * ever shown about field independence. See `writeGlobalSettings`.
 *
 * Bits 0-1, 2 and 5 of that byte are user settings, so a patch must set only
 * the bits it means — `patchGlobalFlags` does that.
 */
export const ANALOG_REPORT = {
  /** Byte offset inside the 0x06 payload. */
  offset: 15,
  /** `actuation_check` — the flag that looks like "report analog travel". */
  actuationCheck: 0x04,
  /** The magnet-axis test. */
  magnetTest: 0x08,
  /** Both, which is what the driver sends while its analog mode is on. */
  both: 0x0c,
  /** The driver sleeps this long between the 0x06 and the closing 0x02. */
  settleMs: 400,
} as const

/**
 * Sets the analog-reporting flags, preserving the rest of the global block.
 *
 * **Corrected.** This used to send a `0x06` with nothing but `payload[15]`
 * set — every other byte zero — on the reasoning that the stock driver's two
 * call sites write disjoint ranges, so the firmware must take each field
 * independently. Reading those call sites through settled it: both of them
 * copy the `0x05` reply into the write buffer first (`0x42960a`, `0x428b13`),
 * so neither ever sends a mostly-zero block and there was no evidence for
 * field independence. Whatever the firmware does with the other bytes, this
 * was writing zeros over the report rate, the dead zone, the game-lock bits
 * and the sleep timeout on every call.
 *
 * It now goes through `writeGlobalSettings`, which reads first.
 *
 * This is a settings write, so it is never done implicitly — the monitor offers
 * it as an explicit action.
 */
export async function enableAnalogReport(
  link: HidLink,
  flags: number = ANALOG_REPORT.both,
): Promise<void> {
  await writeGlobalSettings(link, {
    actuationCheck: (flags & ANALOG_REPORT.actuationCheck) !== 0,
    magnetTest: (flags & ANALOG_REPORT.magnetTest) !== 0,
  })
}

/**
 * Sends a mode packet and waits for the board to acknowledge it.
 *
 * Not pedantry — both of these leave the board busy for far longer than a
 * write takes to return, and the link queue only holds a turn while an
 * exchange is outstanding. A capture measured it: the first 0xa8 took 15.9 ms
 * to acknowledge (its slot sweep) and 0xa9 took 34.5 ms (it writes the
 * calibration table to flash, §3.3). Both were followed by packets fired into
 * a board that had not answered yet — one of which, the calibration read, was
 * never answered at all.
 *
 * A missing acknowledgement is not fatal. Neither packet was waited on before
 * this, so a firmware that stays silent must keep working the way it did;
 * it costs the timeout once and is recorded in the log.
 */
async function sendMode(link: HidLink, command: number, note: string): Promise<void> {
  try {
    await link.request(buildPacket(command), {
      reportId: REPORT_ID,
      timeoutMs: MONITOR.ackMs,
      match: (_id, data) => isReplyTo(command, data),
      note,
    })
  } catch (e) {
    link.log.note(
      t('raven61.modeNoAck', {
        command: `0x${command.toString(16)}`,
        reason: e instanceof Error ? e.message : String(e),
      }),
    )
  }
}

/**
 * Turns analog reporting on, and off again when the returned function runs.
 *
 * Shared by the monitor, the events tab and the sensors tab, so there is one
 * place that decides what is written to the board while it is streaming.
 *
 * 0xa8 does two things at once: it enables analog reporting, and it enters the
 * test mode that stops the board acting as a keyboard. Only the first latches —
 * so for plain monitoring the mode is entered and left again immediately, which
 * leaves reporting on with typing intact. That is the state the board was in
 * when travel kept arriving after a single 0xa8 and Windows still saw keys.
 *
 * With `keepAlive` the mode is held instead, by repeating 0xa8 on
 * MONITOR.rearmMs the way the stock driver's calibration path does. Typing
 * stays suppressed and every key pressed to the bottom is recalibrated, so it
 * is opt-in and never the default.
 */
export async function armAnalogStream(
  link: HidLink,
  opts: { keepAlive?: boolean } = {},
): Promise<() => Promise<void>> {
  await sendMode(link, MONITOR.arm, 'analog report on')

  if (!opts.keepAlive) {
    // Leave the mode at once. Reporting is already latched on.
    await sendMode(link, MONITOR.disarm, 'leave test mode')
    return async () => {}
  }

  const timer = setInterval(() => {
    // A failed re-arm is not fatal: the device may have gone away, and the
    // disconnect path already tears the listener down.
    void sendMode(link, MONITOR.arm, 'calibration re-arm').catch(() => {})
  }, MONITOR.rearmMs)

  let released = false
  const release = async () => {
    if (released) return
    released = true
    clearInterval(timer)
    window.removeEventListener('pagehide', onPageHide)
    try {
      await sendMode(link, MONITOR.disarm, 'leave test mode')
    } catch {
      // Best-effort, but this is the packet that hands typing back.
    }
  }

  function onPageHide() {
    void release()
  }
  // A reload unloads the page without unmounting anything, and WebHID closes
  // the device from under us — this is the last chance to leave reporting off.
  window.addEventListener('pagehide', onPageHide)

  return release
}

/**
 * Reads a firmware blob, one 56-byte chunk per packet.
 *
 * The stock driver's read loops are all this shape: build a block header with a
 * length and an offset, send it through the second send-and-wait helper, and
 * copy payload[8..63] of the reply into its own cursor. It never trusts the
 * echoed offset, and neither does this — a firmware that pads or rounds the
 * header cannot shift the blob.
 *
 * The reply match is on `isReplyTo`, not "the next input report". With the
 * monitor running the board is streaming 0xA0 events, and 0xA0 is also the
 * per-key read command — matching loosely would splice an event into the blob.
 */
export async function readBlock(
  link: HidLink,
  command: number,
  totalBytes: number,
  opts: { timeoutMs?: number; note?: string } = {},
): Promise<Uint8Array> {
  const out = new Uint8Array(totalBytes)
  const plan = chunkPlan(totalBytes)
  const label = opts.note ?? `cmd 0x${command.toString(16).padStart(2, '0')}`
  for (const [i, chunk] of plan.entries()) {
    const request = buildBlock(command, chunk.offset, undefined, { length: chunk.length })
    let reply: Uint8Array
    try {
      const answer = await link.request(request, {
        reportId: REPORT_ID,
        timeoutMs: opts.timeoutMs ?? 300,
        match: (_id, data) => isReplyTo(command, data),
        note: `${label}: read ${chunk.length}B @ ${chunk.offset}`,
      })
      reply = answer.data
    } catch (e) {
      throw new Error(
        t('raven61.chunkTimeout', {
          label,
          index: i + 1,
          total: plan.length,
          offset: chunk.offset,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
    }
    out.set(blockReplyData(reply, chunk.length), chunk.offset)
  }
  return out
}

/**
 * The 1024-byte per-key performance blob, wrapped in the driver's transaction.
 *
 * The stock driver reads this on connect, on a profile switch and whenever the
 * board pushes an unsolicited 0xA2 report — not on entering its performance
 * tab, which only rewrites the global block. The values its tab shows were
 * already read and cached, which is why they appear instantly.
 */
export async function readKeyPerfBlob(link: HidLink): Promise<Uint8Array> {
  await transact(link, COMMAND.begin, { note: 'key perf: begin' })
  try {
    return await readBlock(link, COMMAND.readKeyPerf, KEY_PERF.blobSize, { note: 'key perf' })
  } finally {
    // Closes the transaction even on a failed chunk: leaving one open is how
    // the next command ends up answering the wrong request.
    await transact(link, COMMAND.end, { note: 'key perf: end' })
  }
}

/**
 * The keymap block the slot mapping comes from: 0x07, 768 bytes, 256 x 3.
 *
 * This is the block the stock driver caches at `this+0x8a4` and walks to build
 * its slot maps (0x427ac0 reads it, 0x426344 consumes it). The 0x0a block is a
 * different, shorter one — it reads back all zeros on this board, which is what
 * an unassigned Fn layer looks like, and it sent the first attempt at this
 * mapping down the fallback path.
 */
export async function readKeymapBlob(link: HidLink): Promise<Uint8Array> {
  await transact(link, COMMAND.begin, { note: 'keymap: begin' })
  try {
    return await readBlock(link, COMMAND.readKeymapWide, KEYMAP.blobSize, { note: 'keymap' })
  } finally {
    await transact(link, COMMAND.end, { note: 'keymap: end' })
  }
}

/**
 * The board's own calibration table — 64 records of 8 bytes, the ones the
 * firmware lights the key LEDs from. See protocol/calibration.ts.
 *
 * A plain block read: the 0xaa handler at firmware 0x711c takes the same
 * length-and-offset header every other read command takes, with flash 0x20300
 * hard-wired as the base, so `readBlock` needs nothing special. Nine chunks of
 * 56 bytes and a short one.
 *
 * No 0x01 / 0x02 transaction around it. Those bracket writes; this reads a blob
 * the firmware maintains for itself, and there is no stock-driver call site to
 * copy since the stock driver never sends 0xaa at all.
 */
export async function readCalTable(link: HidLink): Promise<CalRecord[]> {
  const blob = await readBlock(link, COMMAND.readCalibration, CAL_TABLE_BYTES, {
    note: 'calibration table',
  })
  return parseCalTable(blob)
}

/**
 * Asks the board which key each slot is.
 *
 * Falls back to the layout-order guess if the keymap read fails or resolves too
 * few keys to be believable — a half-resolved map would put most keys in the
 * right place and a few in the wrong one, which is the hardest kind of wrong to
 * notice.
 */
export async function readSlotMap(link: HidLink): Promise<{ map: SlotMap; blob?: Uint8Array }> {
  try {
    const blob = await readKeymapBlob(link)
    const map = slotMapFromKeymap(blob)
    if (map.slotByKey.size >= RAVEN61_KEYS.length - 4) return { map, blob }
    link.log.note(
      t('raven61.slotMapPartial', { found: map.slotByKey.size, total: RAVEN61_KEYS.length }),
    )
    return { map: fallbackSlotMap(), blob }
  } catch (e) {
    link.log.note(
      t('raven61.slotMapFailed', { reason: e instanceof Error ? e.message : String(e) }),
    )
    return { map: fallbackSlotMap() }
  }
}

/**
 * Reads the performance block and decodes it, keeping the bytes.
 *
 * Two reads: the keymap first, because it says which slot is which key, then
 * the performance block itself. Indexing it from the layout file was wrong
 * twice over — see keyPerf.ts and slotMap.ts.
 */
export async function readKeyPerfSnapshot(link: HidLink): Promise<KeyPerfSnapshot> {
  const { map, blob: keymap } = await readSlotMap(link)
  const blob = await readKeyPerfBlob(link)

  const emptySlots = emptySlotsOf(blob)
  const configs = decodePerKey(blob, map)

  const missing = RAVEN61_KEYS.filter((k) => map.slotByKey.get(k.index) === undefined)
  if (missing.length > 0) {
    link.log.note(
      t('raven61.keysWithoutSlot', {
        count: missing.length,
        keys: missing.map((k) => k.label).join(', '),
      }),
    )
  }
  const mappedEmpty = RAVEN61_KEYS.filter((k) => {
    const slot = map.slotByKey.get(k.index)
    return slot !== undefined && emptySlots.includes(slot)
  })
  if (mappedEmpty.length > 0) {
    // A zeroed record decodes to "actuation 0.02 mm, rapid trigger off, switch
    // type 0", which is plausible enough to pass for a real setting. Say so.
    link.log.note(
      t('raven61.emptySlots', {
        count: mappedEmpty.length,
        keys: mappedEmpty
          .map((k) => t('raven61.emptySlotEntry', { key: k.label, slot: map.slotByKey.get(k.index)! }))
          .join(', '),
      }),
    )
  }

  return { blob, keymap, slotMap: map, configs, emptySlots }
}

/** Slots whose 8 bytes are all zero. */
export function emptySlotsOf(blob: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let slot = 0; slot < KEY_PERF.slots; slot++) {
    if (isEmptySlot(blob, slot)) out.push(slot)
  }
  return out
}

/**
 * Decodes the blob into this project's key order.
 *
 * A key the map has no slot for reads slot 128, which is past the end of the
 * blob and so decodes as zeros. That is deliberate: the alternative is a hole
 * in the array, and every caller would then need to handle it. The callers that
 * care about the difference check `slotByKey` instead.
 */
export function decodePerKey(blob: ArrayLike<number>, map: SlotMap): KeyConfig[] {
  return RAVEN61_KEYS.map((k) =>
    toKeyConfig(decodeKeyPerfRecord(blob, map.slotByKey.get(k.index) ?? KEY_PERF.slots)),
  )
}

/**
 * Writes the 1024-byte performance blob back, one 56-byte chunk per packet.
 *
 * The stock driver's write is job 0x0d at 0x42c390, and it is the read plan run
 * backwards: 0x01, then 19 chunks of 0xa1 at ascending offsets — eighteen of 56
 * bytes and a last one of 16 — then 0x02. Recovered instruction by instruction:
 * the chunk length is 0x38 with a `cmove` to 0x10 on the nineteenth
 * (0x42c73f), the offset is `i * 56` little-endian at payload[5..6]
 * (0x42c70f-0x42c735), and the data is four SSE moves of 16+16+16+8 bytes into
 * payload[8..63] (0x42c704-0x42c760).
 *
 * Every chunk is acknowledged, and a chunk that is not aborts the write. The
 * closing 0x02 still runs — leaving a transaction open is how the next command
 * ends up answering the wrong request.
 */
export async function writeKeyPerfBlob(link: HidLink, blob: Uint8Array): Promise<void> {
  if (blob.length !== KEY_PERF.blobSize) {
    throw new Error(t('raven61.blobSize', { size: blob.length, expected: KEY_PERF.blobSize }))
  }
  await transact(link, COMMAND.begin, { note: 'key perf write: begin' })
  try {
    const plan = chunkPlan(KEY_PERF.blobSize)
    for (const [i, chunk] of plan.entries()) {
      const packet = buildBlock(
        COMMAND.writeKeyPerf,
        chunk.offset,
        blob.subarray(chunk.offset, chunk.offset + chunk.length),
      )
      const note = `key perf write: ${chunk.length}B @ ${chunk.offset}`
      let reply: Uint8Array
      try {
        const answer = await link.request(packet, {
          reportId: REPORT_ID,
          timeoutMs: 300,
          match: (_id, data) => isReplyTo(COMMAND.writeKeyPerf, data),
          note,
        })
        reply = answer.data
      } catch (e) {
        throw new Error(
          t('raven61.chunkTimeout', {
            label: 'key perf write',
            index: i + 1,
            total: plan.length,
            offset: chunk.offset,
            reason: e instanceof Error ? e.message : String(e),
          }),
        )
      }
      if (!isAck(reply)) {
        throw new Error(
          t('raven61.chunkNak', { index: i + 1, total: plan.length, offset: chunk.offset }),
        )
      }
    }
  } finally {
    await transact(link, COMMAND.end, { note: 'key perf write: end' })
  }
}

/** What a write actually did, so the UI can report it rather than assume it. */
export interface KeyPerfWriteResult {
  /** Slots whose bytes the patch changed. Empty means nothing was sent. */
  slots: number[]
  /** Keys that were written, with the slot each landed in. */
  keys: { index: number; label: string; slot: number }[]
  /** Keys the slot map has no slot for, so they could not be written. */
  unmapped: { index: number; label: string }[]
  /** The blob as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The blob read back afterwards. */
  after: Uint8Array
  /** Slots that did not read back as written. Empty on a verified write. */
  mismatched: { slot: number; wanted: string; got: string }[]
  /**
   * The board's state after the write, decoded. The verify read has it anyway,
   * and handing it back saves the caller a third read of the same block just to
   * show what the board now holds.
   */
  configs: KeyConfig[]
}

/**
 * Applies per-key settings to the board, and checks that they took.
 *
 * Read-modify-write, deliberately. The blob is 128 slots wide and only 61 of
 * them are keys; slots 126 and 127 hold something that is not a key record at
 * all, and three channels inside 0..63 are unused. Building a blob from this
 * app's model would send zeros for all of those. Patching the blob the board
 * just returned touches only the slots the user changed.
 *
 * The verify read is not decoration. A write that is acknowledged and silently
 * ignored looks exactly like a write that worked, and the first cut of the read
 * path proved that a plausible-looking decode can be wrong in a way no amount
 * of staring at the UI reveals. So: write, read back, compare the bytes.
 */
export async function writeKeyPerfConfigs(
  link: HidLink,
  configs: readonly (KeyConfig | null)[],
): Promise<KeyPerfWriteResult> {
  const { map } = await readSlotMap(link)
  // A read may fall back to the layout-order guess and stay useful — the values
  // land on the wrong keys but nothing breaks. A write on that map would put
  // settings on the wrong keys of the actual board, and the guess is *known*
  // wrong: the row-per-actuation test showed the board groups slots quite
  // differently (see slotMap.ts). So this refuses rather than degrades.
  if (map.source !== 'keymap') throw new Error(t('raven61.writeNeedsKeymap'))

  const before = await readKeyPerfBlob(link)

  let next = before
  const keys: KeyPerfWriteResult['keys'] = []
  const unmapped: KeyPerfWriteResult['unmapped'] = []
  for (const key of RAVEN61_KEYS) {
    const config = configs[key.index]
    if (!config) continue
    const slot = map.slotByKey.get(key.index)
    if (slot === undefined) {
      unmapped.push({ index: key.index, label: key.label })
      continue
    }
    // The board's own record supplies switch_type and the three unknown bits of
    // rec[0]: this app sets neither, and must not overwrite them with zeros.
    next = patchSlot(next, slot, fromKeyConfig(config, decodeKeyPerfRecord(next, slot)))
    keys.push({ index: key.index, label: key.label, slot })
  }

  const slots = changedSlots(before, next)
  if (slots.length === 0) {
    // Nothing to send. Reporting that is better than a write that does nothing
    // and still says "applied".
    return {
      slots,
      keys,
      unmapped,
      before,
      after: before,
      mismatched: [],
      configs: decodePerKey(before, map),
    }
  }

  await writeKeyPerfBlob(link, next)
  const after = await readKeyPerfBlob(link)
  const mismatched = changedSlots(next, after).map((slot) => ({
    slot,
    wanted: recordHex(next, slot),
    got: recordHex(after, slot),
  }))
  return { slots, keys, unmapped, before, after, mismatched, configs: decodePerKey(after, map) }
}

/**
 * Turns the 0x03 reply's bytes into the three fields the firmware joined with
 * commas — see COMMAND.readFirmware.
 *
 * Anything that does not split into three parts is kept whole in `raw` and put
 * in `name`, rather than guessing which piece is missing. A board with a
 * different build would still be identified; only the split would be lost.
 */
export function decodeFirmwareIdentity(data: Uint8Array): FirmwareIdentity {
  // Trailing NULs are the firmware's string terminators, not content.
  const raw = new TextDecoder('ascii')
    .decode(data)
    .replace(/\0+$/, '')
    .trim()
  const parts = raw.split(',')
  if (parts.length < 3) return { raw, name: raw }
  return { raw, name: parts[0]!.trim(), buildDate: parts[1]!.trim(), buildTime: parts[2]!.trim() }
}

/**
 * Asks the board which firmware it is running.
 *
 * A single packet with no data — the handler ignores every request field and
 * fills in the length itself. Wrapped in the driver's transaction anyway, since
 * every other read on this board is, and 0x01 / 0x02 cost nothing.
 */
export async function readFirmware(link: HidLink): Promise<FirmwareIdentity> {
  await transact(link, COMMAND.begin, { note: 'firmware: begin' })
  try {
    const { data } = await link.request(buildPacket(COMMAND.readFirmware), {
      reportId: REPORT_ID,
      timeoutMs: 300,
      match: (_id, d) => isReplyTo(COMMAND.readFirmware, d),
      note: 'read firmware identity',
    })
    const identity = decodeFirmwareIdentity(blockReplyData(data, blockReplyHeader(data).length))
    if (identity.raw === '') throw new Error(t('raven61.firmwareEmpty'))
    return identity
  } finally {
    await transact(link, COMMAND.end, { note: 'firmware: end' })
  }
}

/** Byte offsets inside the 0x05 / 0x06 payload. See GlobalSettings. */
export const GLOBAL = {
  /** Block length the stock driver asks for. */
  length: 0x20,
  rate: 12,
  deadZone: 13,
  gameLock: 14,
  flags: 15,
  sleep: 16,
} as const

/** Bits of `payload[15]`. */
export const GLOBAL_FLAGS = {
  tachyon: 0x01,
  bottomOutTrigger: 0x02,
  actuationCheck: 0x04,
  magnetTest: 0x08,
  debounceShift: 5,
  debounceMask: 0x03,
} as const

export function decodeGlobalSettings(payload: Uint8Array): GlobalSettings {
  const rate = payload[GLOBAL.rate] ?? 0
  const lock = payload[GLOBAL.gameLock] ?? 0
  const flags = payload[GLOBAL.flags] ?? 0
  return {
    raw: payload.slice(),
    reportRate: rate & 0x0f,
    tickRate: (rate >> 4) & 0x0f,
    deadZone: payload[GLOBAL.deadZone] ?? 0,
    disableWin: (lock & 0x01) !== 0,
    disableAltTab: (lock & 0x02) !== 0,
    disableAltF4: (lock & 0x04) !== 0,
    tachyon: (flags & GLOBAL_FLAGS.tachyon) !== 0,
    bottomOutTrigger: (flags & GLOBAL_FLAGS.bottomOutTrigger) !== 0,
    actuationCheck: (flags & GLOBAL_FLAGS.actuationCheck) !== 0,
    magnetTest: (flags & GLOBAL_FLAGS.magnetTest) !== 0,
    debounceLevel: (flags >> GLOBAL_FLAGS.debounceShift) & GLOBAL_FLAGS.debounceMask,
    sleepMinutes: payload[GLOBAL.sleep] ?? 0,
  }
}

/**
 * The bare `0x05` read, with no transaction of its own.
 *
 * Single chunk, so it does not go through `readBlock`: the fields we know are
 * documented at payload offsets 12-16, and keeping the whole reply payload lets
 * the panel show the raw bytes next to the decoded ones — and lets a write
 * build its request out of it.
 */
export async function readGlobalBlock(link: HidLink): Promise<GlobalSettings> {
  const request = buildBlock(COMMAND.readGlobalSettings, 0, undefined, {
    length: GLOBAL.length,
  })
  const { data } = await link.request(request, {
    reportId: REPORT_ID,
    timeoutMs: 300,
    match: (_id, d) => isReplyTo(COMMAND.readGlobalSettings, d),
    note: 'read global settings',
  })
  return decodeGlobalSettings(data)
}

/** The same read, wrapped in the driver's transaction. */
export async function readGlobalSettings(link: HidLink): Promise<GlobalSettings> {
  await transact(link, COMMAND.begin, { note: 'global settings: begin' })
  try {
    return await readGlobalBlock(link)
  } finally {
    await transact(link, COMMAND.end, { note: 'global settings: end' })
  }
}

/**
 * The fields of the global block this app is willing to change.
 *
 * Deliberately not "the whole block": most of it is settings that belong to
 * other screens, and one byte of it is the analog-test pair that stops the
 * board typing. A patch names what it means to change and nothing else.
 */
export interface GlobalPatch {
  /**
   * `perf_bottomrapidtrigger_mode` — the stock UI's "always trigger when
   * bottoming out". The one rapid-trigger setting that is board-wide rather
   * than per key.
   */
  bottomOutTrigger?: boolean
  /** `actuation_check`. */
  actuationCheck?: boolean
  /** The magnet-axis test bit. */
  magnetTest?: boolean
  /** `debounce_level`, 0-3. */
  debounceLevel?: number
  /**
   * `reporte_rate` — the USB polling rate, as the low nibble of `payload[12]`.
   * See REPORT_RATES for what the four values mean.
   *
   * The one patch field that is not a bit of the flags byte, and the one with a
   * side effect worth knowing about: the rate the board enumerates at is the
   * rate the host polls it at, so a change here may take a replug — or may drop
   * the WebHID handle outright — before it shows.
   */
  reportRate?: number
}

/**
 * Applies a patch to the rate byte. `tick_rate` shares it as the high nibble
 * and belongs to another screen, so it is carried through untouched.
 */
export function patchGlobalRate(rate: number, patch: GlobalPatch): number {
  if (patch.reportRate === undefined) return rate
  return ((rate & 0xf0) | (patch.reportRate & 0x0f)) & 0xff
}

/** Applies a patch to the flags byte, leaving the bits it does not name alone. */
export function patchGlobalFlags(flags: number, patch: GlobalPatch): number {
  let out = flags
  const set = (mask: number, on: boolean) => {
    out = on ? out | mask : out & ~mask & 0xff
  }
  if (patch.bottomOutTrigger !== undefined) {
    set(GLOBAL_FLAGS.bottomOutTrigger, patch.bottomOutTrigger)
  }
  if (patch.actuationCheck !== undefined) set(GLOBAL_FLAGS.actuationCheck, patch.actuationCheck)
  if (patch.magnetTest !== undefined) set(GLOBAL_FLAGS.magnetTest, patch.magnetTest)
  if (patch.debounceLevel !== undefined) {
    const shifted = (patch.debounceLevel & GLOBAL_FLAGS.debounceMask) << GLOBAL_FLAGS.debounceShift
    out = (out & ~(GLOBAL_FLAGS.debounceMask << GLOBAL_FLAGS.debounceShift) & 0xff) | shifted
  }
  return out
}

export interface GlobalWriteResult {
  before: GlobalSettings
  after: GlobalSettings
  /** Byte offsets inside the payload that came back different from what was sent. */
  mismatched: { offset: number; wanted: number; got: number }[]
  /** True when the patch was already the board's state, so nothing was sent. */
  unchanged: boolean
}

/**
 * Changes global settings the way the stock driver does — by editing the block
 * it just read.
 *
 * This is not a design choice, it is what the binary does. Both `0x06` call
 * sites (`0x429560`, the performance tab; `0x428a30`, the general settings
 * page) run the same five steps:
 *
 *   1. `0x01`
 *   2. `0x05` with `payload[4] = 0x20`, through the read helper
 *   3. **copy the 65-byte reply into the write buffer** — four SSE moves at
 *      `0x42960a`-`0x42964d` — then overwrite `payload[0..1]` with `55 06` and
 *      edit only its own fields
 *   4. send, then `Sleep(400)` (`push 0x190` at `0x4299e9`)
 *   5. `0x02`
 *
 * An earlier note in this file had it wrong. It said the two call sites write
 * disjoint ranges and leave the rest zero, and concluded the firmware must
 * treat each field independently. Neither call site ever sends a mostly-zero
 * block, so there was never any evidence for that — and `enableAnalogReport`
 * was built on it, which means it has been zeroing the report rate, the dead
 * zone, the game-lock bits and the sleep timeout every time it ran.
 */
export async function writeGlobalSettings(
  link: HidLink,
  patch: GlobalPatch,
): Promise<GlobalWriteResult> {
  await transact(link, COMMAND.begin, { note: 'global settings write: begin' })
  try {
    const before = await readGlobalBlock(link)
    const request = globalWriteRequest(before.raw, patch)
    // Nothing to do beyond the two header bytes means the patch is a no-op.
    if (sameData(request, before.raw)) {
      return { before, after: before, mismatched: [], unchanged: true }
    }
    const { data } = await link.request(request, {
      reportId: REPORT_ID,
      timeoutMs: 300,
      match: (_id, d) => isReplyTo(COMMAND.globalSettings, d),
      note: 'write global settings',
    })
    if (!isAck(data)) throw new Error(t('raven61.globalNak'))
    await new Promise((r) => setTimeout(r, ANALOG_REPORT.settleMs))
    const after = await readGlobalBlock(link)
    const mismatched: GlobalWriteResult['mismatched'] = []
    for (const offset of GLOBAL_WRITTEN) {
      const wanted = request[offset] ?? 0
      const got = after.raw[offset] ?? 0
      if (wanted !== got) mismatched.push({ offset, wanted, got })
    }
    return { before, after, mismatched, unchanged: false }
  } finally {
    await transact(link, COMMAND.end, { note: 'global settings write: end' })
  }
}

/**
 * Builds the `0x06` request from a `0x05` reply, which is where the read-modify
 * -write happens: every byte the patch does not name is the byte the board
 * just reported.
 */
export function globalWriteRequest(reply: ArrayLike<number>, patch: GlobalPatch): Uint8Array {
  const out = new Uint8Array(PAYLOAD_LENGTH)
  for (let i = 0; i < PAYLOAD_LENGTH; i++) out[i] = reply[i] ?? 0
  out[OFFSET.magic] = MAGIC
  out[OFFSET.command] = COMMAND.globalSettings
  out[GLOBAL.rate] = patchGlobalRate(out[GLOBAL.rate] ?? 0, patch)
  out[GLOBAL.flags] = patchGlobalFlags(out[GLOBAL.flags] ?? 0, patch)
  return sign(out)
}

/**
 * The bytes a patch can touch — the only ones worth verifying.
 *
 * Both are checked whichever fields the patch named. A byte the patch left
 * alone was copied out of the board's own reply, so reading it back different
 * is worth hearing about too.
 */
const GLOBAL_WRITTEN: readonly number[] = [GLOBAL.rate, GLOBAL.flags]

function sameData(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  // From payload[4] on: the header differs by construction (0x55/0x06 against
  // 0xaa/0x05) and its checksum with it.
  for (let i = OFFSET.data; i < PAYLOAD_LENGTH; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return false
  }
  return true
}


/**
 * ⚠⚠ Factory reset — `0xee`.
 *
 * The one command in this file that throws the board's settings away, and the
 * only reason it is reachable at all is that a person asked for it twice.
 *
 * ## What the board actually does
 *
 * The handler (firmware `0x76c6`) does almost nothing: it sets a byte at
 * `gp-0x791` and falls straight into the reply path, so the ack comes back
 * immediately and means only "request received". The work happens afterwards in
 * the main loop, at `0x1450c`, which clears the flag and then rewrites flash —
 * settings and keymap from default tables baked into the image, and several
 * blobs to zero:
 *
 *   0x20100  64 B    global settings   <- defaults at 0x175b4
 *   0x20700  1024 B  keymap            <- defaults at 0x17ff4
 *   0x20b00  1024 B  per-key perf      <- defaults at 0x177f4
 *   0x20f00  512 B                     <- defaults at 0x175f4
 *   0x21100+         lighting blobs    <- zeroed
 *
 * **The calibration table at 0x20300 is not in that list.** The reset routine
 * never writes it, so what the board learned about each switch survives — which
 * is worth saying plainly, because it is the one thing here that could not be
 * recovered by re-applying settings.
 *
 * ## Why the waits are what they are
 *
 * They are the stock driver's, not a guess: job `0x0c` (`0x443540`) sends the
 * packet bare — no `0x01` / `0x02` around it — then `Sleep(1000)`,
 * `Sleep(5000)`, and only then re-reads every blob. Six seconds of erasing and
 * rewriting flash is what that is allowing for, and reading sooner is reading
 * a board that is still working.
 */
export const FACTORY_RESET = {
  /** `Sleep(1000)` at 0x443585. */
  firstWaitMs: 1000,
  /** `Sleep(5000)` at 0x443590, before the driver reads anything back. */
  secondWaitMs: 5000,
} as const

/**
 * What the global block holds once the firmware has reset it — read out of the
 * defaults table at flash 0x175b4, the source the reset routine copies from.
 *
 * Used to check the reset landed, not to decide whether it worked: this is one
 * firmware build's table, and another build may ship different numbers. A board
 * that comes back with something else is reported as exactly that, rather than
 * as a failure.
 *
 * Two of these are worth reading twice. `reportRate: 4` is 1000 Hz under
 * REPORT_RATES, which is the sane thing for a factory default to be and so is
 * independent support for that table. And `flags: 0x03` has both Tachyon and
 * "always trigger when bottoming" *on*, where the stock driver's own database
 * defaults them off — the firmware and the driver disagree about what default
 * means, and the firmware is the one that wins a reset.
 */
export const FACTORY_GLOBAL = {
  /** `reporte_rate` 4 — 1000 Hz. */
  reportRate: 4,
  tickRate: 0,
  deadZone: 1,
  /** `payload[15]`: Tachyon and bottom-out trigger on, debounce level 0. */
  flags: 0x03,
  debounceLevel: 0,
  sleepMinutes: 6,
} as const

export interface FactoryResetResult {
  /** Milliseconds waited before reading anything back. */
  waitedMs: number
  /** The global block afterwards, or null if the board was not answering yet. */
  after: GlobalSettings | null
  /**
   * Fields that came back different from this firmware's defaults table. Empty
   * when `after` is null: nothing was compared, which is not the same as
   * everything matching.
   */
  unexpected: { field: string; wanted: number; got: number }[]
}

/** Where a reset has got to, for a caller that wants to say so. */
export type FactoryResetStage = 'sending' | 'waiting' | 'reading'

/**
 * Sends it, waits the driver's six seconds, and reads the block back.
 *
 * The ack is not evidence of anything beyond delivery — see above — so the
 * read afterwards is the only part that can tell whether the board did it. A
 * board that does not answer that read is reported as unread rather than as
 * failed: it may still be busy, and saying "the reset failed" about a board
 * that has just wiped itself would be the worse of the two wrong answers.
 */
export async function factoryReset(
  link: HidLink,
  onStage?: (stage: FactoryResetStage) => void,
): Promise<FactoryResetResult> {
  onStage?.('sending')
  // Deliberately not COMMAND.factoryReset: the byte lives in DANGEROUS_COMMANDS
  // so that it cannot reach KNOWN_COMMANDS and be swept by the prober.
  const sent = await transact(link, DANGEROUS_COMMANDS.factoryReset, {
    note: 'factory reset',
  })
  if (!sent.ack) throw new Error(t('raven61.resetNak'))

  onStage?.('waiting')
  const waitedMs = FACTORY_RESET.firstWaitMs + FACTORY_RESET.secondWaitMs
  await new Promise((r) => setTimeout(r, FACTORY_RESET.firstWaitMs))
  await new Promise((r) => setTimeout(r, FACTORY_RESET.secondWaitMs))

  onStage?.('reading')
  let after: GlobalSettings | null = null
  try {
    after = await readGlobalBlock(link)
  } catch {
    // Still busy, or gone from the bus. Either way there is nothing to compare.
    return { waitedMs, after: null, unexpected: [] }
  }
  const unexpected: FactoryResetResult['unexpected'] = []
  const check = (field: keyof typeof FACTORY_GLOBAL, got: number) => {
    if (FACTORY_GLOBAL[field] !== got) {
      unexpected.push({ field, wanted: FACTORY_GLOBAL[field], got })
    }
  }
  check('reportRate', after.reportRate)
  check('tickRate', after.tickRate)
  check('deadZone', after.deadZone)
  check('flags', after.raw[GLOBAL.flags] ?? 0)
  check('sleepMinutes', after.sleepMinutes)
  return { waitedMs, after, unexpected }
}

export function isKnownProduct(device: HIDDevice): boolean {
  return (
    device.vendorId === RAVEN_VENDOR_ID &&
    (RAVEN_PRODUCT_IDS as readonly number[]).includes(device.productId)
  )
}

export interface TransactResult {
  request: Uint8Array
  reply?: Uint8Array
  ack: boolean
}

/**
 * Sends one framed command and waits for the reply, mirroring what the stock
 * driver does: write 65 bytes, then read with a short timeout and check that
 * the first byte is 0xAA.
 */
export async function transact(
  link: HidLink,
  command: number,
  opts: {
    data?: ArrayLike<number>
    /** Where in the data area `data` goes, for commands with sparse payloads. */
    dataOffset?: number
    magic?: number
    timeoutMs?: number
    note?: string
  } = {},
): Promise<TransactResult> {
  const request = buildPacket(command, {
    data: opts.data,
    dataOffset: opts.dataOffset,
    magic: opts.magic ?? MAGIC,
  })
  try {
    const { data } = await link.request(request, {
      reportId: REPORT_ID,
      timeoutMs: opts.timeoutMs ?? 300,
      // Match the command back, not just "the next input report": the board
      // streams analog events unprompted once reporting has been enabled, and
      // one of those arriving mid-transaction would be read as the reply.
      match: (_id, data) => isReplyTo(command, data),
      note: opts.note ?? `cmd 0x${command.toString(16).padStart(2, '0')}`,
    })
    return { request, reply: data, ack: isAck(data) }
  } catch {
    return { request, ack: false }
  }
}

export const FRAME_INFO = { ACK, MAGIC, PAYLOAD_LENGTH, REPORT_ID } as const
