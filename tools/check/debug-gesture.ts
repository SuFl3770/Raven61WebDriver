/**
 * Checks the Shift gesture that toggles debug mode. `npm run check`.
 *
 * Putting a gesture on Shift is only safe because of three rules, and each one
 * exists to stop a specific false positive:
 *
 *  - a non-Shift key zeroes the run, because typing `HELLO` by tapping Shift
 *    before each letter is otherwise five Shift presses inside a second;
 *  - auto-repeat does not count, or leaning on the key would arm it;
 *  - taps further apart than the gap start a new run, because "quickly" is the
 *    whole difference between a gesture and someone using the keyboard.
 *
 * The counter was pulled out of the hook so all three can be checked here
 * rather than only by hand in a browser. The false-positive direction is the
 * one that matters: a gesture that will not fire is annoying, one that fires
 * under a person typing moves the tab strip out from under them.
 */
import {
  DEBUG_GESTURE,
  GESTURE_START,
  advanceGesture,
  type GestureRun,
} from '../../src/state/debugGesture'

let pass = 0
const fails: string[] = []
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else fails.push(`${name} — ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}

/**
 * Plays a sequence through the counter and returns how many times it fired.
 *
 * `keys` is what was pressed; `gapMs` is how long between each. A `+` prefix
 * marks an auto-repeat keydown.
 */
function play(keys: readonly string[], gapMs = 100, run: GestureRun = GESTURE_START) {
  let time = 10_000
  let fires = 0
  for (const raw of keys) {
    const repeat = raw.startsWith('+')
    const key = repeat ? raw.slice(1) : raw
    time += gapMs
    const step = advanceGesture(run, { key, repeat, timeStamp: time })
    run = step.next
    if (step.fire) fires++
  }
  return { fires, run }
}

const shift = (n: number) => Array.from({ length: n }, () => 'Shift')

// --- the gesture itself -----------------------------------------------------
eq('five quick taps fire once', play(shift(5)).fires, 1)
eq('four do not fire', play(shift(4)).fires, 0)
eq('ten quick taps fire twice, not six', play(shift(10)).fires, 2)
eq(
  'the count needed is the one the UI advertises',
  play(shift(DEBUG_GESTURE.presses)).fires,
  1,
)

// --- typing must not fire it ------------------------------------------------
eq(
  'typing HELLO with a shift per letter',
  play(['Shift', 'H', 'Shift', 'E', 'Shift', 'L', 'Shift', 'L', 'Shift', 'O']).fires,
  0,
)
eq(
  'a letter in the middle of a run breaks it',
  play(['Shift', 'Shift', 'Shift', 'Shift', 'x', 'Shift']).fires,
  0,
)
eq(
  'and the run really restarts, rather than resuming',
  play(['Shift', 'Shift', 'Shift', 'Shift', 'x', ...shift(4)]).fires,
  0,
)
eq(
  'ctrl+shift, six times over',
  play(['Control', 'Shift', 'Control', 'Shift', 'Control', 'Shift', 'Control', 'Shift', 'Control', 'Shift', 'Control', 'Shift']).fires,
  0,
)

// --- held down --------------------------------------------------------------
eq('auto-repeat never counts', play(['+Shift', '+Shift', '+Shift', '+Shift', '+Shift', '+Shift']).fires, 0)
eq(
  'one real press plus a stream of repeats is still one press',
  play(['Shift', '+Shift', '+Shift', '+Shift', '+Shift', '+Shift', '+Shift']).fires,
  0,
)
eq(
  'and repeats between taps do not break the run either',
  play(['Shift', '+Shift', 'Shift', '+Shift', 'Shift', 'Shift', 'Shift']).fires,
  1,
)

// --- timing -----------------------------------------------------------------
eq('taps just inside the gap fire', play(shift(5), DEBUG_GESTURE.gapMs).fires, 1)
eq('taps just outside it do not', play(shift(5), DEBUG_GESTURE.gapMs + 1).fires, 0)
eq('nor do slow taps, however many', play(shift(20), DEBUG_GESTURE.gapMs + 1).fires, 0)

// --- the first tap of a fresh page ------------------------------------------
{
  // `timeStamp` counts from page load, so an early tap is a small number. With
  // `last` seeded to 0 rather than null this fired on four taps.
  let run = GESTURE_START
  let fires = 0
  for (const timeStamp of [120, 220, 320, 420]) {
    const step = advanceGesture(run, { key: 'Shift', repeat: false, timeStamp })
    run = step.next
    if (step.fire) fires++
  }
  eq('four taps in the first half-second do not fire', fires, 0)
  const fifth = advanceGesture(run, { key: 'Shift', repeat: false, timeStamp: 520 })
  eq('the fifth does', fifth.fire, true)
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
