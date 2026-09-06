/**
 * Checks the calibration grading against the firmware it was taken from.
 * `npm run check`.
 *
 * The grading used to be a guess: ADC swing against the board's median, with a
 * hand-set floor and two ratios that had never been compared with anything. It
 * has been replaced by the quantity the firmware actually stores — see
 * `src/protocol/calibration.ts`, and `tools/fw/calibration.py` for reading the
 * constants back out of `Raven FW/FW.exe`.
 *
 * So the checks worth having are no longer "is the constant still 3.0". They
 * are: does the record decoder match the bytes the firmware ships, does the
 * grade stay tied to the scale rather than drifting back to the state byte, and
 * does the bottom-out test stay in the switch-independent unit — that last one
 * being the bug that made the old mm threshold unreachable on short switches.
 */
import {
  CAL,
  CAL_STATE,
  CAL_TABLE_BYTES,
  WEAK_HEADROOM,
  gradeRecord,
  isBottomedOut,
  ledColor,
  parseCalRecord,
  parseCalTable,
  scaleHeadroom,
} from '../../src/protocol/calibration'
import { countBottomedOut } from '../../src/features/Calibration'
import { COMMAND, SAFE_COMMANDS, buildBlock, checksum } from '../../src/protocol/frame'
import { RAVEN61_SWITCH_TYPES as SWITCH_TYPES } from '../../src/device/boards/raven61/switches'

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

/** One record as the firmware ships it: scale 0.62, state 0, tag AA BB FF. */
const SHIPPED = [0x52, 0xb8, 0x1e, 0x3f, 0x00, 0xaa, 0xbb, 0xff]

// --- the record decoder against the bytes in the image ---------------------
{
  const rec = parseCalRecord(SHIPPED)
  ok('shipped scale decodes to the floor', Math.abs(rec.scale - CAL.scaleFloor) < 1e-6,
    String(rec.scale))
  eq('shipped state is the one the LED shows red for', rec.state, CAL_STATE.fresh)
  ok('shipped record carries the tag', rec.valid)

  // The boot path rewrites any record whose tag is missing, so a blank page of
  // flash must not read as a calibrated key.
  const blank = parseCalRecord([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  ok('an erased record is not trusted', !blank.valid)
  eq('and grades as unknown, not as calibrated', gradeRecord(blank), 'unknown')

  const table = parseCalTable(new Uint8Array(CAL_TABLE_BYTES))
  eq('a full table is 64 records', table.length, 64)
  eq('table size matches the block read', CAL_TABLE_BYTES, 64 * 8)
}

// --- grading is on the scale, not on the firmware's state byte -------------
{
  const at = (scale: number, state: number = CAL_STATE.done) => ({ scale, state, valid: true })

  eq('a record at the floor has never been calibrated',
    gradeRecord(at(CAL.scaleFloor)), 'uncalibrated')
  eq('the shipped record is the same thing', gradeRecord(parseCalRecord(SHIPPED)), 'uncalibrated')
  eq('a healthy scale is ok', gradeRecord(at(0.9)), 'ok')
  eq('missing record is unknown', gradeRecord(undefined), 'unknown')

  // The regression the whole module exists for. A board fresh from a firmware
  // update has every record at state 0, which the LED shows as red — but if the
  // scale is good the key is fine, and grading on the byte would call the whole
  // keyboard broken.
  eq('a good scale with the shipped state byte is still ok',
    gradeRecord(at(0.9, CAL_STATE.fresh)), 'ok')
  // And the other direction: the boot check latches 0xFF on records it has
  // just thrown away, so "calibrated" from the board means nothing.
  eq('the floor with a calibrated state byte is still uncalibrated',
    gradeRecord(at(CAL.scaleFloor, CAL_STATE.done)), 'uncalibrated')

  // Just off the floor is the "pressed, but not to the bottom" case.
  const span = CAL.scaleCeiling - CAL.scaleFloor
  eq('barely off the floor is weak',
    gradeRecord(at(CAL.scaleFloor + span * WEAK_HEADROOM * 0.5)), 'weak')
  eq('past the weak line is ok',
    gradeRecord(at(CAL.scaleFloor + span * WEAK_HEADROOM * 1.5)), 'ok')
  ok('the weak line sits above the firmware’s own calibrated threshold',
    CAL.scaleFloor + span * WEAK_HEADROOM > CAL.scaleCalibrated,
    `${CAL.scaleFloor + span * WEAK_HEADROOM} vs ${CAL.scaleCalibrated}`)

  eq('headroom is 0 at the floor', scaleHeadroom(CAL.scaleFloor), 0)
  // The stored float32 of the floor is a hair above 0.62; it still has to read
  // as no headroom at all, or the shipped record grades one step too kindly.
  eq('and 0 for the floor as float32', scaleHeadroom(parseCalRecord(SHIPPED).scale), 0)
  eq('and 1 at the ceiling', scaleHeadroom(CAL.scaleCeiling), 1)
  eq('a scale below the floor cannot go negative', scaleHeadroom(0.1), 0)
  eq('nor past 1 above the ceiling', scaleHeadroom(9), 1)
}

// --- the LED mirror --------------------------------------------------------
{
  eq('state 0 is the red the firmware paints', ledColor(CAL_STATE.fresh), '#FF0000')
  eq('state 1 is amber', ledColor(CAL_STATE.learning), '#FF8000')
  eq('a calibrated key is not lit', ledColor(CAL_STATE.done), undefined)
  // The overlay tests `state <= 1`, so the transient 2 is dark as well.
  eq('the transient state is dark too', ledColor(2), undefined)
}

// --- bottom-out is in the firmware's switch-independent unit ---------------
{
  ok('the bottom-out line is below full travel',
    CAL.bottomOutRaw < CAL.travelRawFull && CAL.bottomOutRaw > CAL.travelRawFull * 0.9,
    `${CAL.bottomOutRaw} of ${CAL.travelRawFull}`)
  ok('just under does not count', !isBottomedOut(CAL.bottomOutRaw - 1))
  ok('exactly on the line counts', isBottomedOut(CAL.bottomOutRaw))
  ok('a released key does not', !isBottomedOut(0))

  // The point of leaving millimetres behind: the same fraction of travel has to
  // count on every switch in the table, and it does, because the unit is a
  // fraction of travel. A millimetre threshold cannot manage that — the old
  // 3.96 mm one was unreachable on anything shorter than 4 mm.
  const shortest = Math.min(...SWITCH_TYPES.map((s) => s.travelMm))
  const longest = Math.max(...SWITCH_TYPES.map((s) => s.travelMm))
  ok('the switch table really does span different strokes', shortest < longest,
    `${shortest}..${longest} mm`)
  for (const s of SWITCH_TYPES) {
    const bottomed = Math.round(CAL.travelRawFull * 0.98)
    ok(`a bottomed-out ${s.travelMm} mm switch counts`, isBottomedOut(bottomed))
  }
  ok('and the old mm rule would have missed the short ones',
    3.96 > shortest, `3.96 mm threshold vs ${shortest} mm of stroke`)

  const raw = Uint16Array.from([0, 767, 768, 800, 100, 769])
  eq('counts at or past the line', countBottomedOut(raw), 3)
  eq('an empty pass counts nothing', countBottomedOut(new Uint16Array(61)), 0)
  eq('a full pass counts every key',
    countBottomedOut(new Uint16Array(61).fill(CAL.travelRawFull)), 61)
}

// --- the read command ------------------------------------------------------
{
  eq('the calibration read is 0xaa', COMMAND.readCalibration, 0xaa)
  ok('and is safe to send unprompted', SAFE_COMMANDS.includes(COMMAND.readCalibration))

  // Same block header as every other read, which is why readBlock needs no
  // special case: length at [4], offset little-endian at [5..6], nothing else.
  const req = buildBlock(COMMAND.readCalibration, 0x38, undefined, { length: 0x38 })
  eq('request is the standard block header',
    [req[0], req[1], req[4], req[5], req[6]], [0x55, 0xaa, 0x38, 0x38, 0x00])
  eq('and carries a valid checksum', req[3], checksum(req))
  ok('a chunk never exceeds what the firmware accepts', 0x38 <= 0x38)
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
