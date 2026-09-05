/**
 * Checks the firmware identity read — command 0x03. `npm run check`.
 *
 * The fake board here is the firmware's own handler (0x667c) written out in
 * TypeScript: three NUL-terminated strings copied into `payload[8..]` joined by
 * commas, with the total length in `payload[4]`. If this app ever stops reading
 * the reply the way the firmware writes it, that is what these catch.
 *
 * The rest is about not over-trusting the shape. The three-part split is what
 * one build does, not a promise the protocol makes, so a reply that does not
 * split has to survive as itself rather than being torn into wrong fields.
 */
import type { HidLink } from '../../src/hid/link'
import {
  BLOCK,
  COMMAND,
  MAGIC,
  OFFSET,
  PAYLOAD_LENGTH,
  SAFE_COMMANDS,
  checksum,
} from '../../src/protocol/frame'
import { decodeFirmwareIdentity, readFirmware } from '../../src/protocol/raven61'

let pass = 0
const fails: string[] = []
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else fails.push(`${name} — ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}

/** What the board this was read from answers with. */
const REAL = 'HALL_HS_USB_KB,Nov 13 2024,11:05:59'

const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))

// --- decode ---
{
  const id = decodeFirmwareIdentity(bytes(REAL))
  eq('raw kept whole', id.raw, REAL)
  eq('name', id.name, 'HALL_HS_USB_KB')
  eq('build date', id.buildDate, 'Nov 13 2024')
  eq('build time', id.buildTime, '11:05:59')
}

{
  // The handler writes exactly `length` bytes, but a reply padded with the
  // buffer's zeros must not carry them into the last field.
  const padded = new Uint8Array(56)
  padded.set(bytes(REAL))
  const id = decodeFirmwareIdentity(padded)
  eq('trailing NULs dropped', id.buildTime, '11:05:59')
  eq('and out of raw too', id.raw, REAL)
}

{
  // A firmware that answers with something else keeps its answer intact rather
  // than having a name and a date invented out of the pieces.
  const id = decodeFirmwareIdentity(bytes('SOMETHING ELSE'))
  eq('unsplittable reply survives', [id.raw, id.name], ['SOMETHING ELSE', 'SOMETHING ELSE'])
  eq('no date is claimed', id.buildDate, undefined)
}

{
  const id = decodeFirmwareIdentity(bytes('ONE,TWO'))
  eq('two parts is not three', id.name, 'ONE,TWO')
  eq('and claims no time', id.buildTime, undefined)
}

// --- the command itself ---
eq('0x03 is the read', COMMAND.readFirmware, 0x03)
eq(
  'and is safe to send — its handler only writes the reply buffer',
  SAFE_COMMANDS.includes(COMMAND.readFirmware),
  true,
)

// --- end to end against a fake board ---
class FakeBoard {
  sent: number[] = []

  constructor(private readonly answer = REAL) {}

  handle(payload: Uint8Array): Uint8Array {
    if (payload[OFFSET.checksum] !== checksum(payload)) throw new Error('bad checksum')
    const command = payload[OFFSET.command]!
    this.sent.push(command)
    const reply = new Uint8Array(PAYLOAD_LENGTH)
    reply[OFFSET.magic] = 0xaa
    reply[OFFSET.command] = command
    if (command === COMMAND.readFirmware) {
      const data = bytes(this.answer)
      reply[BLOCK.length] = data.length
      reply.set(data, BLOCK.data)
    }
    return reply
  }
}

function fakeLink(board: FakeBoard): HidLink {
  return {
    log: { note: () => {} },
    async request(data: Uint8Array) {
      return { reportId: 0, data: board.handle(data) }
    },
  } as unknown as HidLink
}

{
  const board = new FakeBoard()
  const id = await readFirmware(fakeLink(board))
  eq('read end to end', id.raw, REAL)
  eq('inside a transaction, like every other read', board.sent, [0x01, 0x03, 0x02])
}

{
  // The request carries no data: the handler fills the length in itself, and
  // sending a length would be sending a block-read request this command is not.
  const board = new FakeBoard()
  let request: Uint8Array | null = null
  const link = {
    log: { note: () => {} },
    async request(data: Uint8Array) {
      if (data[OFFSET.command] === COMMAND.readFirmware) request = data.slice()
      return { reportId: 0, data: board.handle(data) }
    },
  } as unknown as HidLink
  await readFirmware(link)
  const sent = request as unknown as Uint8Array
  eq('magic and command', [sent[OFFSET.magic], sent[OFFSET.command]], [MAGIC, COMMAND.readFirmware])
  eq('no data area', [...sent.subarray(OFFSET.data)].every((b) => b === 0), true)
}

{
  // A board that answers with an empty payload is a failure, not a firmware
  // whose name is the empty string.
  const board = new FakeBoard('')
  let threw = false
  try {
    await readFirmware(fakeLink(board))
  } catch {
    threw = true
  }
  eq('an empty answer throws', threw, true)
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
