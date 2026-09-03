import { RAVEN_PRODUCT_IDS, RAVEN_VENDOR_ID } from '../hid/filters'
import type { HidLink } from '../hid/link'
import { t } from '../i18n'
import { RAVEN61_KEYS } from '../keyboard/raven61'
import type { Raven61Codec } from './codec'
import type { GlobalSettings, KeyConfig, KeyPerfSnapshot, KeySample } from './types'
import {
  ACK,
  COMMAND,
  OFFSET,
  MAGIC,
  PAYLOAD_LENGTH,
  REPORT_ID,
  blockReplyData,
  buildBlock,
  buildPacket,
  chunkPlan,
  isAck,
  isReplyTo,
  parseKeyEvent,
} from './frame'
import { KEY_PERF, decodeKeyPerfRecord, isEmptySlot, toKeyConfig } from './keyPerf'
import { KEYMAP, fallbackSlotMap, slotMapFromKeymap, type SlotMap } from './slotMap'

/**
 * Framing is decoded; the per-command data layouts are not. This codec
 * therefore identifies the device and provides `transact`, but implements no
 * capability yet — the feature panels stay honest about that.
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

  readGlobalSettings,

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
 * The other 0x06 call site (0x428a30, applying global settings) writes a
 * disjoint range, payload[16..24], and leaves payload[12..15] zero. Since
 * switching tabs in the stock driver plainly does not reset the report rate,
 * the firmware must treat these as independent fields — so writing only
 * payload[15] is what the driver itself does, not a clobber of everything else.
 *
 * Bits 0-1, 2 and 5 of that byte *are* user settings though, and a value of
 * 0x0c clears them. Re-applying settings in the stock driver restores them.
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
 * Writes the analog-reporting flag, wrapped in the driver's own transaction.
 *
 * This is a settings write, so it is never done implicitly — the monitor offers
 * it as an explicit action.
 */
export async function enableAnalogReport(
  link: HidLink,
  flags: number = ANALOG_REPORT.both,
): Promise<void> {
  await transact(link, COMMAND.begin, { note: 'analog report: begin' })
  await transact(link, COMMAND.globalSettings, {
    data: [flags],
    dataOffset: ANALOG_REPORT.offset - OFFSET.data,
    note: `analog report: flags 0x${flags.toString(16).padStart(2, '0')}`,
  })
  await new Promise((r) => setTimeout(r, ANALOG_REPORT.settleMs))
  await transact(link, COMMAND.end, { note: 'analog report: apply' })
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
  await link.send(buildPacket(MONITOR.arm), REPORT_ID, 'analog report on')

  if (!opts.keepAlive) {
    // Leave the mode at once. Reporting is already latched on.
    await link.send(buildPacket(MONITOR.disarm), REPORT_ID, 'leave test mode')
    return async () => {}
  }

  const timer = setInterval(() => {
    // A failed re-arm is not fatal: the device may have gone away, and the
    // disconnect path already tears the listener down.
    void link.send(buildPacket(MONITOR.arm), REPORT_ID, 'calibration re-arm').catch(() => {})
  }, MONITOR.rearmMs)

  let released = false
  const release = async () => {
    if (released) return
    released = true
    clearInterval(timer)
    window.removeEventListener('pagehide', onPageHide)
    try {
      await link.send(buildPacket(MONITOR.disarm), REPORT_ID, 'leave test mode')
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

  const emptySlots: number[] = []
  for (let slot = 0; slot < KEY_PERF.slots; slot++) {
    if (isEmptySlot(blob, slot)) emptySlots.push(slot)
  }

  const configs = RAVEN61_KEYS.map((k) => {
    const slot = map.slotByKey.get(k.index)
    return toKeyConfig(decodeKeyPerfRecord(blob, slot ?? KEY_PERF.slots))
  })

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
 * Reads the global settings block.
 *
 * Single chunk, so it does not go through `readBlock`: the fields we know are
 * documented at payload offsets 12-16, and keeping the whole reply payload lets
 * the panel show the raw bytes next to the decoded ones.
 */
export async function readGlobalSettings(link: HidLink): Promise<GlobalSettings> {
  await transact(link, COMMAND.begin, { note: 'global settings: begin' })
  try {
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
  } finally {
    await transact(link, COMMAND.end, { note: 'global settings: end' })
  }
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
