/**
 * Checks that the link serialises what it puts on the wire. `npm run check`.
 *
 * The bug this exists for is in a capture, not in a theory. Entering
 * calibration ran `readCalTable` and `readSlotMap` together under a
 * `Promise.all`, and the two multi-packet reads collided on their first
 * packet:
 *
 *   361138.100 out  55 aa 00 38 38 00   calibration table: read 56B @ 0
 *   361138.100 out  55 01 00 00 00 00   keymap: begin
 *   361143.400 in   aa 01               ← only the second one is answered
 *
 * The board has a single HID packet buffer (`gp + 0x134`), so the second write
 * replaced the first before the firmware picked it up. The calibration read
 * then spent its 300 ms timeout watching fourteen keymap chunks succeed beside
 * it, and reported "the board would not give me its calibration table" — about
 * a command that answers in 5 ms when it is asked on its own.
 *
 * `FakeBoard` below is that firmware: one buffer, one packet at a time, last
 * write before a poll wins. The checks are that the fake still reproduces the
 * failure when written to directly, and that nothing routed through `HidLink`
 * can trigger it any more — `send` included, since a fire-and-forget packet
 * (the 1500 ms calibration re-arm) clobbers an in-flight request exactly as
 * well as a request does.
 */
import { HidLink } from '../../src/hid/link'
import { ACK, MAGIC, OFFSET, PAYLOAD_LENGTH, buildPacket, isReplyTo } from '../../src/protocol/frame'

let pass = 0
const fails: string[] = []
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else fails.push(`${name} — ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++
  else fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

const REPORT_ID = 0
/** How long the fake takes to notice a packet, in ms. */
const SERVICE_MS = 4

/**
 * The board as the capture shows it: one packet buffer, serviced on a timer.
 *
 * Deliberately not `implements Partial<HIDDevice>` — the WebHID listener types
 * are overloaded past what a stand-in can satisfy, and `withBoard` is where the
 * shape is asserted.
 *
 * A write lands in the buffer whether or not the previous packet has been
 * serviced. When it has not, the previous packet is gone — not rejected, not
 * NAKed, gone, which is why the symptom is silence rather than an error.
 */
class FakeBoard {
  opened = true
  readonly vendorId = 0x0000
  readonly productId = 0x0000
  readonly productName = 'fake board'
  /** Every packet the host handed us, clobbered or not. */
  readonly written: number[][] = []
  /** Commands that actually got serviced, in order. */
  readonly serviced: number[] = []

  private buffer: Uint8Array | null = null
  private listeners = new Set<(e: { reportId: number; data: DataView }) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null

  readonly collections = [
    {
      usagePage: 0xff00,
      usage: 1,
      inputReports: [{ reportId: REPORT_ID, items: [{ reportSize: 8, reportCount: PAYLOAD_LENGTH }] }],
      outputReports: [{ reportId: REPORT_ID, items: [{ reportSize: 8, reportCount: PAYLOAD_LENGTH }] }],
      featureReports: [],
      children: [],
    },
  ] as unknown as HIDDevice['collections']

  async open(): Promise<void> {}
  async close(): Promise<void> {
    this.opened = false
  }

  addEventListener(_type: string, fn: (e: { reportId: number; data: DataView }) => void): void {
    this.listeners.add(fn)
  }
  removeEventListener(_type: string, fn: (e: { reportId: number; data: DataView }) => void): void {
    this.listeners.delete(fn)
  }

  async sendReport(_reportId: number, data: Uint8Array): Promise<void> {
    this.written.push(Array.from(data))
    // The clobber. No branch for "the buffer is full" because the firmware has
    // none — it is a memcpy into a fixed address.
    this.buffer = data
    if (this.timer === null) this.timer = setTimeout(() => this.service(), SERVICE_MS)
  }

  private service(): void {
    this.timer = null
    const packet = this.buffer
    this.buffer = null
    if (!packet) return
    const command = packet[OFFSET.command] ?? 0
    this.serviced.push(command)
    const reply = new Uint8Array(PAYLOAD_LENGTH)
    reply[0] = ACK
    reply[1] = command
    for (const fn of this.listeners) {
      fn({ reportId: REPORT_ID, data: new DataView(reply.buffer) })
    }
  }
}

async function withBoard<T>(fn: (link: HidLink, board: FakeBoard) => Promise<T>): Promise<T> {
  const board = new FakeBoard()
  const link = new HidLink()
  await link.open(board as unknown as HIDDevice)
  try {
    return await fn(link, board)
  } finally {
    await link.close()
  }
}

const exchange = (link: HidLink, command: number, note: string) =>
  link.request(buildPacket(command), {
    reportId: REPORT_ID,
    timeoutMs: 300,
    match: (_id, data) => isReplyTo(command, data),
    note,
  })

// --- the fake still models the bug ------------------------------------------
//
// Without this the rest proves nothing: a board that answers everything would
// pass the queue checks with the queue removed.
await withBoard(async (link, board) => {
  const answered: number[] = []
  const off = link.onInput((_id, data) => {
    if (data[0] === ACK) answered.push(data[1] ?? 0)
  })
  // Two raw writes in one tick, exactly as the capture has them.
  await Promise.all([
    (link.device as unknown as FakeBoard).sendReport(REPORT_ID, buildPacket(0xaa)),
    (link.device as unknown as FakeBoard).sendReport(REPORT_ID, buildPacket(0x01)),
  ])
  await new Promise((r) => setTimeout(r, SERVICE_MS * 4))
  off()
  eq('unqueued writes: both reach the device', board.written.length, 2)
  eq('unqueued writes: only one is serviced', board.serviced, [0x01])
  eq('unqueued writes: 0xaa is never answered', answered, [0x01])
})

// --- what the calibration tab actually did ----------------------------------
await withBoard(async (link, board) => {
  const [cal, begin] = await Promise.all([
    exchange(link, 0xaa, 'calibration table').then(
      (r) => r.data[1],
      () => 'timeout',
    ),
    exchange(link, 0x01, 'keymap: begin').then(
      (r) => r.data[1],
      () => 'timeout',
    ),
  ])
  eq('concurrent requests: 0xaa is answered', cal, 0xaa)
  eq('concurrent requests: 0x01 is answered', begin, 0x01)
  eq('concurrent requests: both serviced, in call order', board.serviced, [0xaa, 0x01])
})

// --- a fire-and-forget packet must not overtake an exchange -----------------
//
// The calibration re-arm is a bare `send` on a 1500 ms interval, and it lands
// wherever it lands.
await withBoard(async (link, board) => {
  const inFlight = exchange(link, 0x07, 'keymap: read')
  const rearm = link.send(buildPacket(0xa8), REPORT_ID, 'calibration re-arm')
  const reply = await inFlight
  await rearm
  // The queue is released when the write returns, not when the board has
  // finished with it — a bare `send` has no reply to wait for. So the re-arm
  // is still in the buffer here, and the wait is the fake's service tick, not
  // slack in the test. It is also why `armAnalogStream` sends its 0xa8 as a
  // request and waits for the acknowledgement: measured, that gap is 15.9 ms
  // of a board that answers nothing.
  await new Promise((r) => setTimeout(r, SERVICE_MS * 2))
  eq('re-arm: the read is answered', reply.data[1], 0x07)
  eq('re-arm: nothing is clobbered', board.serviced, [0x07, 0xa8])
})

// --- a failed exchange must not take the queue with it ----------------------
//
// The chain is shared, so a rejection that propagated into it would strand
// every later caller — a worse failure than the one being fixed.
await withBoard(async (link, board) => {
  const dead = await link
    .request(buildPacket(0x0d), {
      reportId: REPORT_ID,
      timeoutMs: 40,
      // Nothing will ever match this.
      match: () => false,
      note: 'never answered',
    })
    .then(() => 'answered', () => 'timeout')
  const after = await exchange(link, 0x05, 'read global settings')
  eq('after a timeout: the dead exchange rejects', dead, 'timeout')
  eq('after a timeout: the queue still runs', after.data[1], 0x05)
  eq('after a timeout: both packets went out', board.serviced, [0x0d, 0x05])
})

// --- the queue does not reorder ---------------------------------------------
await withBoard(async (link, board) => {
  const commands = [0x01, 0x07, 0x07, 0x07, 0x02, 0xaa]
  const replies = await Promise.all(commands.map((c, i) => exchange(link, c, `chunk ${i}`)))
  eq('order: replies match their requests', replies.map((r) => r.data[1]), commands)
  eq('order: the board saw them in call order', board.serviced, commands)
  ok(
    'order: no packet was written twice',
    board.written.length === commands.length,
    `${board.written.length} writes for ${commands.length} commands`,
  )
  ok('order: magic is intact', board.written.every((p) => p[OFFSET.magic] === MAGIC))
})

console.log(fails.length === 0 ? `ok (${pass})` : `FAIL (${pass} passed)`)
for (const f of fails) console.log('  ' + f)
process.exit(fails.length === 0 ? 0 : 1)
