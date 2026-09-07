/**
 * Checks the factory reset — command 0xee. `npm run check`.
 *
 * This is the one command in the codebase that destroys the board's settings,
 * so what is worth pinning down is not that it works but that it cannot happen
 * by accident and cannot lie about the outcome:
 *
 *  - the byte stays out of `KNOWN_COMMANDS`, so no sweep can reach it;
 *  - the packet goes bare, the way the stock driver sends it — a `0x01` before
 *    it would be this app inventing a transaction the driver does not use;
 *  - the six seconds of waiting are the driver's own two sleeps, in order;
 *  - a board that does not answer the read afterwards is reported as unread,
 *    never as "everything matched". That distinction is the whole point of the
 *    read-back: an empty `unexpected` list on a board nobody heard from would
 *    read as a clean reset.
 *
 * `setTimeout` is stubbed so the checks do not actually sit for six seconds.
 * The stub records what was asked for, which is how the waits get asserted.
 */
import type { HidLink } from '../../src/hid/link'
import {
  BLOCK,
  DANGEROUS_COMMANDS,
  KNOWN_COMMANDS,
  MAGIC,
  OFFSET,
  PAYLOAD_LENGTH,
  SAFE_COMMANDS,
  checksum,
} from '../../src/protocol/frame'
import { FACTORY_GLOBAL, GLOBAL } from '../../src/protocol/global'
import { factoryReset } from '../../src/protocol/raven61'

let pass = 0
const fails: string[] = []
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else fails.push(`${name} — ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}

// --- the byte itself ---
eq('0xee is the reset', DANGEROUS_COMMANDS.factoryReset, 0xee)
eq('and is not a known command', KNOWN_COMMANDS.includes(0xee), false)
eq('and certainly not a safe one', SAFE_COMMANDS.includes(0xee), false)

// --- a board that answers ---
interface BoardOpts {
  /** Reply to 0xee with something other than an ack. */
  nak?: boolean
  /** Do not answer the 0x05 that follows. */
  silentRead?: boolean
  /** Values the block comes back with. Defaults to the firmware's own. */
  block?: Partial<
    Record<
      'rate' | 'deadZone' | 'gameLock' | 'flags' | 'lightMode' | 'brightness' | 'speed' | 'colorful',
      number
    >
  >
}

class FakeBoard {
  sent: number[] = []
  requests: Uint8Array[] = []

  constructor(private readonly opts: BoardOpts = {}) {}

  handle(payload: Uint8Array): Uint8Array | null {
    if (payload[OFFSET.checksum] !== checksum(payload)) throw new Error('bad checksum')
    const command = payload[OFFSET.command]!
    this.sent.push(command)
    this.requests.push(payload.slice())
    if (command === 0xee) {
      if (this.opts.nak) return null
      const echo = payload.slice()
      echo[OFFSET.magic] = 0xaa
      return echo
    }
    if (command === 0x05) {
      if (this.opts.silentRead) return null
      const b = this.opts.block ?? {}
      const reply = new Uint8Array(PAYLOAD_LENGTH)
      reply[OFFSET.magic] = 0xaa
      reply[OFFSET.command] = 0x05
      reply[BLOCK.length] = GLOBAL.length
      // The firmware's defaults table, as flash 0x175b4 holds it.
      reply[GLOBAL.rate] = b.rate ?? 0x04
      reply[GLOBAL.deadZone] = b.deadZone ?? 0x01
      reply[GLOBAL.gameLock] = b.gameLock ?? 0x00
      reply[GLOBAL.flags] = b.flags ?? 0x03
      // The lighting bytes are part of that table too — a reset puts the board
      // back on effect 6 at full brightness, and the check reports them.
      reply[GLOBAL.lightMode] = b.lightMode ?? 6
      reply[GLOBAL.brightness] = b.brightness ?? 100
      reply[GLOBAL.speed] = b.speed ?? 0
      reply[GLOBAL.colorful] = b.colorful ?? 1
      return reply
    }
    return null
  }
}

function fakeLink(board: FakeBoard): HidLink {
  return {
    log: { note: () => {} },
    async request(data: Uint8Array) {
      const reply = board.handle(data)
      if (!reply) throw new Error('no reply')
      return { reportId: 0, data: reply }
    },
  } as unknown as HidLink
}

/** Runs `fn` with the clock skipped, returning the delays that were asked for. */
async function withoutWaiting<T>(fn: () => Promise<T>): Promise<{ value: T; delays: number[] }> {
  const real = globalThis.setTimeout
  const delays: number[] = []
  // Only the reset's own sleeps go through here; nothing else in this check
  // schedules anything.
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    queueMicrotask(cb)
    return 0
  }) as unknown as typeof setTimeout
  try {
    return { value: await fn(), delays }
  } finally {
    globalThis.setTimeout = real
  }
}

{
  const board = new FakeBoard()
  const { value, delays } = await withoutWaiting(() => factoryReset(fakeLink(board)))
  // No 0x01 / 0x02: the driver sends this one bare (0x443540).
  eq('sent bare, then the read-back', board.sent, [0xee, 0x05])
  eq("the driver's own two sleeps, in order", delays, [1000, 5000])
  eq('reported as six seconds', value.waitedMs, 6000)
  eq('read back', value.after?.reportRate, FACTORY_GLOBAL.reportRate)
  eq('debounce back to level 0', value.after?.debounceLevel, FACTORY_GLOBAL.debounceLevel)
  eq('nothing unexpected', value.unexpected, [])

  const request = board.requests[0]!
  eq('magic and command', [request[OFFSET.magic], request[OFFSET.command]], [MAGIC, 0xee])
  eq('checksum', request[OFFSET.checksum], checksum(request))
  eq('no data area', [...request.subarray(OFFSET.data)].every((x) => x === 0), true)
}

{
  // A board that comes back with something else is named, not passed.
  const board = new FakeBoard({ block: { rate: 0x01, flags: 0x00 } })
  const { value } = await withoutWaiting(() => factoryReset(fakeLink(board)))
  eq('the read still happened', value.after?.reportRate, 1)
  eq(
    'both differences are reported',
    value.unexpected,
    [
      { field: 'reportRate', wanted: 4, got: 1 },
      { field: 'flags', wanted: 3, got: 0 },
    ],
  )
}

{
  // Silence after the reset is "unread", not "clean".
  const board = new FakeBoard({ silentRead: true })
  const { value } = await withoutWaiting(() => factoryReset(fakeLink(board)))
  eq('nothing was read', value.after, null)
  eq('and nothing is claimed to have matched', value.unexpected, [])
  eq('the wait still happened', value.waitedMs, 6000)
}

{
  // Not acknowledged: nothing was started, and the read must not follow.
  const board = new FakeBoard({ nak: true })
  let threw = false
  await withoutWaiting(async () => {
    try {
      await factoryReset(fakeLink(board))
    } catch {
      threw = true
    }
  })
  eq('an unacknowledged reset throws', threw, true)
  eq('and does not go on to read', board.sent, [0xee])
}

{
  // The stage callback is what a UI shows while the board is busy, so it has to
  // arrive in order and before the thing it describes.
  const board = new FakeBoard()
  const stages: string[] = []
  await withoutWaiting(() => factoryReset(fakeLink(board), (s) => stages.push(s)))
  eq('stages in order', stages, ['sending', 'waiting', 'reading'])
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
