import { RAVEN_PRODUCT_IDS, RAVEN_VENDOR_ID } from '../hid/filters'
import type { HidLink } from '../hid/link'
import type { Raven61Codec } from './codec'
import type { KeySample } from './types'
import {
  ACK,
  COMMAND,
  OFFSET,
  MAGIC,
  PAYLOAD_LENGTH,
  REPORT_ID,
  buildPacket,
  isAck,
  parseKeyEvent,
} from './frame'

/**
 * Framing is decoded; the per-command data layouts are not. This codec
 * therefore identifies the device and provides `transact`, but implements no
 * capability yet — the feature panels stay honest about that.
 */
export const raven61Codec: Raven61Codec = {
  id: 'raven61-v1',
  label: 'Raven61 (프레임 해독됨)',
  confidence: 'partial',
  notes:
    '패킷 프레임과 아날로그 키 이벤트는 해독되었습니다. 모니터는 동작하며, ' +
    '설정 쓰기는 명령별 데이터 배치가 아직 미해독이라 비활성 상태입니다.',

  async probe(link: HidLink) {
    const d = link.device
    if (!d) return false
    // Identification only — a probe runs on every connect and must not write.
    return d.vendorId === RAVEN_VENDOR_ID
  },

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
      note: opts.note ?? `cmd 0x${command.toString(16).padStart(2, '0')}`,
    })
    return { request, reply: data, ack: isAck(data) }
  } catch {
    return { request, ack: false }
  }
}

export const FRAME_INFO = { ACK, MAGIC, PAYLOAD_LENGTH, REPORT_ID } as const
