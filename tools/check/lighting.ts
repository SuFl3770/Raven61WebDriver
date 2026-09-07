/**
 * Checks the lighting effect fields of the settings block. `npm run check`.
 *
 * These nine bytes were the last thing in this block anybody guessed at, and
 * one of them was recorded wrong for months: `payload[16]` was down as a sleep
 * timeout, on the strength of a `>= 23 -> 0xff` clamp in the stock driver's
 * read-back that looked like "23 minutes or never". It is the lighting effect,
 * and 23 is how many effects the board has.
 *
 * So the point of this file is not the arithmetic — the arithmetic is nine byte
 * copies and one subtraction. It is to pin the *layout* and the two encodings
 * that are not identity, against the two artifacts that established them:
 *
 *   - The stock driver's own database defaults (mode 6, brightness 100, speed
 *     **4**, direction 0, colorful 1, colorindex 0, color_value 255).
 *   - The firmware's factory block at flash 0x175b4, which reads
 *     `06 64 00 00 01 00 ff 00 00` for the same nine bytes.
 *
 * Those two disagree by exactly `4 - speed` on the speed byte and by exactly
 * "red is the low byte" on the colour, and neither table knows the other
 * exists. A change that breaks the inversion or the byte order fails here.
 *
 * Run it after touching lighting.ts or the lighting path in global.ts.
 */
import { DEFAULT_GLOBAL, FACTORY_GLOBAL, GLOBAL, globalWriteRequest, writtenOffsets } from '../../src/protocol/global'
import { MAGIC, OFFSET, PAYLOAD_LENGTH, checksum } from '../../src/protocol/frame'
import {
  LIGHT_CONTROL,
  LIGHT_LIMITS,
  LIGHT_MODE_OFF,
  decodeLighting,
  effectOf,
  emptyLightingPatch,
  hasLighting,
  supportsControl,
} from '../../src/protocol/lighting'
import { RAVEN61_LIGHT_EFFECTS } from '../../src/device/boards/raven61/lighting'
import { raven61Spec } from '../../src/device/boards/raven61/index'

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

/** The firmware's factory block, as flash 0x175b4 holds it. */
const FACTORY_BLOCK = [
  0x50, 0x00, 0xaa, 0xbb, 0x04, 0x01, 0x00, 0x03, 0x06, 0x64, 0x00, 0x00, 0x01, 0x00, 0xff, 0x00,
  0x00,
]

/** That table as a 0x05 reply — block byte *n* lands at payload[8 + n]. */
function factoryReply(): Uint8Array {
  const out = new Uint8Array(PAYLOAD_LENGTH)
  out[OFFSET.magic] = 0xaa
  out[OFFSET.command] = 0x05
  out[4] = GLOBAL.length
  FACTORY_BLOCK.forEach((b, i) => {
    out[8 + i] = b
  })
  return out
}

// --- the offsets are where the stock driver's write puts them ---
{
  ok('this board places the lighting bytes', hasLighting(DEFAULT_GLOBAL))
  /*
   * The order is the stock database's column order, because that is how the
   * driver's loader stores a row: SQLite column n at struct + 4n, and the write
   * reads them back out in order into consecutive bytes.
   */
  eq(
    'payload[16..24] in column order',
    [
      GLOBAL.lightMode,
      GLOBAL.brightness,
      GLOBAL.speed,
      GLOBAL.direction,
      GLOBAL.colorful,
      GLOBAL.colorIndex,
      GLOBAL.color,
    ],
    [16, 17, 18, 19, 20, 21, 22],
  )
  // Not 16. The byte that used to be called a sleep timeout is the mode, and
  // the field that was checked after a reset under that name is this one.
  eq('the factory default is an effect index', FACTORY_GLOBAL.lightMode, 6)
}

// --- decoding the firmware's own factory table ---
{
  const light = decodeLighting(factoryReply(), DEFAULT_GLOBAL)
  ok('it decodes', light !== null)
  eq('mode 6', light!.mode, 6)
  eq('brightness is a percentage', light!.brightness, 100)
  /*
   * The inversion, and the whole reason to have this check. The firmware's
   * table stores 0; the stock database's default for the same row is 4. Both
   * mean the fastest, and the only way both can be right is `wire = 4 - ui`.
   */
  eq('wire 0 decodes as the fastest speed', light!.speed, LIGHT_LIMITS.speedMax)
  eq('direction off', light!.direction, false)
  eq('colorful on', light!.colorful, true)
  eq('colorindex is carried, not interpreted', light!.colorIndex, 0)
  /*
   * And the byte order. `ff 00 00` against the database's `color_value = 255`
   * only agree if the low byte of that integer is red — which is also what the
   * firmware does with it, loading these three into the same R/G/B globals the
   * per-key block feeds.
   */
  eq('the first colour byte is red', light!.color, { r: 255, g: 0, b: 0 })
}

// --- a patch touches its own bytes and nothing else ---
{
  const reply = factoryReply()
  // Something in every other field, so anything the patch disturbs shows up.
  reply[GLOBAL.rate] = 0x21
  reply[GLOBAL.deadZone] = 7
  reply[GLOBAL.gameLock] = 0x03
  reply[GLOBAL.colorIndex] = 9

  const req = globalWriteRequest(reply, {
    lighting: { lightMode: 3, brightness: 50, speed: 1, direction: true, colorful: false, color: { r: 1, g: 2, b: 3 } },
  })

  eq('magic and command replaced', [req[OFFSET.magic], req[OFFSET.command]], [MAGIC, 0x06])
  eq('checksum recomputed', req[OFFSET.checksum], checksum(req))
  eq('mode written', req[GLOBAL.lightMode], 3)
  eq('brightness written', req[GLOBAL.brightness], 50)
  // 1 in, 3 on the wire. The one place this app has to run the driver's own
  // `mov al, 4 / sub al, speed` rather than pass a value through.
  eq('speed inverted on the way out', req[GLOBAL.speed], 3)
  eq('direction written', req[GLOBAL.direction], 1)
  eq('colorful cleared', req[GLOBAL.colorful], 0)
  eq(
    'colour written R then G then B',
    [req[GLOBAL.color], req[GLOBAL.color + 1], req[GLOBAL.color + 2]],
    [1, 2, 3],
  )
  /*
   * The undecoded byte. Nothing is known about what `colorindex` selects, so
   * the write puts the board's own back — sending a guess is how a setting
   * nobody understands gets quietly changed.
   */
  eq('colorindex carried through untouched', req[GLOBAL.colorIndex], 9)
  eq(
    'the other screens are untouched',
    [req[GLOBAL.rate], req[GLOBAL.deadZone], req[GLOBAL.gameLock], req[GLOBAL.flags]],
    [0x21, 7, 0x03, 0x03],
  )
}

// --- a patch that names nothing changes nothing ---
{
  const reply = factoryReply()
  const req = globalWriteRequest(reply, { lighting: {} })
  ok('an empty lighting patch is empty', emptyLightingPatch({}))
  eq(
    'and leaves all nine bytes alone',
    [...req.subarray(16, 25)],
    FACTORY_BLOCK.slice(8, 17),
  )
  // Which is also why the verify list stays short: checking nine bytes a write
  // never sent would report `colorIndex` as a mismatch on every other write.
  eq('so they are not verified either', writtenOffsets(DEFAULT_GLOBAL, { lighting: {} }).length, 2)
  ok(
    'but they are when the patch names one',
    writtenOffsets(DEFAULT_GLOBAL, { lighting: { brightness: 10 } }).length > 2,
  )
  ok(
    'and colorIndex is never in that list',
    !writtenOffsets(DEFAULT_GLOBAL, { lighting: { brightness: 10 } }).includes(GLOBAL.colorIndex),
  )
}

// --- values past the firmware's limits saturate rather than wrap ---
{
  const reply = factoryReply()
  const req = globalWriteRequest(reply, { lighting: { brightness: 400, speed: 99 } })
  /*
   * Saturating to the *firmware's* limits, not to a byte: the boot validation
   * rewrites a brightness above 100 to 100 and a speed above 4 to 2, so a value
   * past the end would not read back as itself and the verify would report a
   * mismatch the user could do nothing about.
   */
  eq('brightness saturates at 100', req[GLOBAL.brightness], LIGHT_LIMITS.brightnessMax)
  eq('speed saturates, then inverts to 0', req[GLOBAL.speed], 0)
  const low = globalWriteRequest(reply, { lighting: { brightness: -5, speed: -5 } })
  eq('and below zero clamps up', low[GLOBAL.brightness], 0)
  eq('speed 0 is the slowest wire value', low[GLOBAL.speed], LIGHT_LIMITS.speedMax)
}

// --- a wire speed the firmware would reject still decodes on the scale ---
{
  const reply = factoryReply()
  reply[GLOBAL.speed] = 200
  const light = decodeLighting(reply, DEFAULT_GLOBAL)
  // Clamped before the flip. Without that the panel would show a negative
  // speed on a slider that starts at zero.
  eq('a nonsense wire speed decodes to 0, not below', light!.speed, 0)
}

// --- the effect table ---
{
  const effects = raven61Spec.lightEffects!
  eq('the table is on the spec', effects, RAVEN61_LIGHT_EFFECTS)
  eq('23 effects, plus music and off', effects.length, 25)
  eq('modes are values, not indices', effectOf(effects, 128)?.name, 'Musical Rhythm')
  eq('the off row is 0xff', effectOf(effects, LIGHT_MODE_OFF)?.supports, 0)

  // Musical Rhythm is the one row the stock driver itself cannot reach — its
  // own read-back clamp turns anything >= 23 into 0xff — and it drives a layer
  // this project has not decoded. Carried as data, kept out of the picker.
  eq('music is not selectable', effectOf(effects, 128)?.selectable, false)
  ok(
    'everything else is',
    effects.filter((e) => e.selectable === false).length === 1,
  )

  /*
   * `supports` bits, against the three the stock UI's own code settles by the
   * value it pushes in beside the show: brightness, speed and the colour.
   */
  ok('static has a colour and no speed', (() => {
    const fx = effectOf(effects, 3)
    return supportsControl(fx, LIGHT_CONTROL.color) && !supportsControl(fx, LIGHT_CONTROL.speed)
  })())
  ok('spectrum has speed and no colour', (() => {
    const fx = effectOf(effects, 1)
    return supportsControl(fx, LIGHT_CONTROL.speed) && !supportsControl(fx, LIGHT_CONTROL.color)
  })())
  ok('wave has a direction', supportsControl(effectOf(effects, 6), LIGHT_CONTROL.direction))
  ok('breathing has none', !supportsControl(effectOf(effects, 4), LIGHT_CONTROL.direction))

  /*
   * Exactly one effect reads the per-key colour block, and the app finds it
   * through this bit rather than by hard-coding mode 0 — which is what lets the
   * colour section say where its colours show up.
   */
  const perKey = effects.filter((e) => supportsControl(e, LIGHT_CONTROL.perKey))
  eq('one effect paints the per-key block', perKey.length, 1)
  eq('and it is Custom Light', perKey[0]?.mode, 0)
  // No effect declares two direction pairs: the four bits choose which pair of
  // labels the stock page shows, not how many toggles there are.
  ok(
    'no effect claims two direction pairs',
    effects.every((e) => {
      const bits = [0x04, 0x08, 0x40, 0x80].filter((b) => (e.supports & b) !== 0)
      return bits.length <= 1
    }),
  )
}

if (fails.length > 0) {
  console.error(`lighting: ${pass} passed, ${fails.length} failed`)
  for (const f of fails) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`lighting: ${pass} passed, 0 failed`)
export {}
