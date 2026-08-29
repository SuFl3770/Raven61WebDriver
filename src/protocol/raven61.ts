import { RAVEN_PRODUCT_IDS, RAVEN_VENDOR_ID } from '../hid/filters'
import type { HidLink } from '../hid/link'
import type { Raven61Codec } from './codec'
import type { KeySample } from './types'
import { ACK, MAGIC, PAYLOAD_LENGTH, REPORT_ID, buildPacket, isAck, parseKeyEvent } from './frame'

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
   * The board streams analog key events on its own, so this only listens.
   * Nothing is written to the device, which makes the monitor safe to run
   * while the rest of the protocol is still unknown.
   */
  async startMonitor(link: HidLink, onSample: (samples: KeySample[]) => void) {
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
          depthMm: event.depthMm,
          raw: event.adc,
          pressed: event.pressed,
        },
      ])
    })
    return async () => {
      off()
    }
  },
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
  opts: { data?: ArrayLike<number>; magic?: number; timeoutMs?: number; note?: string } = {},
): Promise<TransactResult> {
  const request = buildPacket(command, { data: opts.data, magic: opts.magic ?? MAGIC })
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
