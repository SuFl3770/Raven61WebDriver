/**
 * Checks the auto-apply engine. `npm run check`.
 *
 * Writing used to be a button, so a write happened when a person decided one
 * should. It now happens on its own, which turns three things from tidiness
 * into correctness:
 *
 * - **Writing at once.** A checkbox has nothing to throttle, and the first cut
 *   made it wait 400 ms anyway because the slider needed to. That delay is the
 *   regression these checks guard against coming back.
 * - **The hold.** A slider fires a change per pixel and one write is about
 *   seventy packets, so the drag holds the write and releases it at the end.
 * - **Serialisation.** Reads and writes both move the whole 1024-byte block.
 *   Two of them in flight at once means a read returning a half-written block,
 *   or two read-modify-writes racing over the same base.
 *
 * None of them is visible in the UI when it goes wrong — the board just gets
 * slow, or laggy, or occasionally loses an edit — so they are checked here.
 */
import { BoardSync } from '../../src/state/sync'
import { configStore, defaultKeyConfig } from '../../src/state/config'
import type { HidLink } from '../../src/hid/link'
import type { KeyboardCodec } from '../../src/protocol/codec'

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A codec that records what it was asked to do and takes a while doing it.
const calls: string[] = []
let overlapping = 0
let maxOverlap = 0
const codec = {
  id: 'fake',
  labelKey: 'codec.raven61.label',
  confidence: 'confirmed',
  async probe() {
    return true
  },
  async readKeyConfigs() {
    return trace('read', () => configStore.all().map((c) => ({ ...c })))
  },
  async readKeyPerf() {
    return trace('read', () => ({ configs: configStore.all().map((c) => ({ ...c })) }))
  },
  async writeKeyPerf(_link: unknown, payload: readonly unknown[]) {
    const n = payload.filter(Boolean).length
    return trace(`write:${n}`, () => ({ mismatched: [], configs: configStore.all() }))
  },
  async readGlobalSettings() {
    return trace('read', () => globalReply())
  },
  /*
   * The board-wide block. It records the patch it was handed, because the thing
   * worth checking about this path is not that a write happened but *what the
   * write carried*: a drag that queues twenty writes and a drag that merges
   * them into one look identical from anywhere else.
   */
  async writeGlobalSettings(_link: unknown, patch: Record<string, unknown>) {
    return trace(`global:${describe(patch)}`, () => ({
      before: globalReply(),
      after: globalReply(),
      mismatched: [],
      unchanged: false,
    }))
  },
}

/** A settings reply the store will accept. Only the shape matters here. */
function globalReply() {
  return {
    raw: new Uint8Array(64),
    reportRate: 4,
    tickRate: 0,
    deadZone: 0,
    disableWin: false,
    disableAltTab: false,
    disableAltF4: false,
    tachyon: false,
    bottomOutTrigger: false,
    actuationCheck: false,
    magnetTest: false,
    debounceLevel: 0,
    lighting: null,
  }
}

/** A patch's lighting fields, in a form a check can compare against a string. */
function describe(patch: Record<string, unknown>): string {
  const light = patch.lighting as Record<string, unknown> | undefined
  if (!light) return Object.keys(patch).sort().join('+') || 'empty'
  return Object.entries(light)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .sort()
    .join(',')
}

/** The pending patch's lighting half, for the checks that read it back. */
function pendingLight(): Record<string, unknown> | undefined {
  const p = boardSync.current().pendingGlobal as { lighting?: Record<string, unknown> } | null
  return p?.lighting
}

async function trace<T>(what: string, result: () => T): Promise<T> {
  calls.push(what)
  overlapping++
  maxOverlap = Math.max(maxOverlap, overlapping)
  await sleep(30)
  overlapping--
  return result()
}

const boardSync = new BoardSync({
  codec: () => codec as unknown as KeyboardCodec,
  connected: () => true,
  link: () => ({}) as HidLink,
})

// The live engine subscribes to the store in its own module; this one has to be
// wired up by hand, which is the same line.
configStore.subscribe(() => {
  if (configStore.dirtyIndices().length > 0) boardSync.schedule()
})

// --- a discrete change goes out immediately ---------------------------------
{
  calls.length = 0
  configStore.load(Array.from({ length: 61 }, defaultKeyConfig))
  configStore.update([0], (c) => ({ ...c, actuationMm: 0.5 }))
  // No settle delay: a checkbox has nothing to throttle, and waiting for one
  // made every toggle feel slow. 60 ms is the fake write, not a debounce.
  await sleep(80)
  eq('one write, straight away', calls, ['write:1'])
  eq('the key is no longer dirty', configStore.dirtyIndices().length, 0)
}

// --- edits to several keys in one update are one write ----------------------
{
  calls.length = 0
  configStore.update([1, 2, 3], (c) => ({ ...c, actuationMm: 1.2 }))
  await sleep(80)
  eq('one write for three keys', calls, ['write:3'])
}

// --- the number reported is the number written ------------------------------
// It is what the confirmation toast says out loud (ui/ApplyToast.tsx), so it
// has to be the keys this write covered and not, say, all sixty-one.
{
  calls.length = 0
  configStore.update([10, 11, 12, 13], (c) => ({ ...c, actuationMm: 1.6 }))
  await sleep(80)
  eq('four keys in one write', calls, ['write:4'])
  eq('and four is what it reports', boardSync.current().appliedKeys, 4)
}

// --- a drag holds the write until the handle is let go ----------------------
{
  calls.length = 0
  boardSync.hold()
  // Twenty ticks of a slider drag.
  for (let i = 0; i < 20; i++) {
    configStore.update([0], (c) => ({ ...c, actuationMm: 0.5 + i * 0.02 }))
    await sleep(5)
  }
  eq('nothing sent while the handle is held', calls.length, 0)
  boardSync.release()
  await sleep(80)
  eq('one write on release', calls, ['write:1'])
  eq('carrying the value it ended on', configStore.all()[0]!.actuationMm, 0.5 + 19 * 0.02)
}

// --- two controls held at once wait for the last of them --------------------
{
  calls.length = 0
  boardSync.hold()
  boardSync.hold()
  configStore.update([8], (c) => ({ ...c, actuationMm: 2.5 }))
  boardSync.release()
  await sleep(80)
  eq('still held by the second', calls.length, 0)
  boardSync.release()
  await sleep(80)
  eq('and goes when that one lets go too', calls, ['write:1'])
}

// --- releasing with nothing to send does not write --------------------------
{
  calls.length = 0
  boardSync.hold()
  boardSync.release()
  await sleep(80)
  eq('an empty gesture sends nothing', calls, [])
  // A stray release must not take the count below zero, or the next hold would
  // not hold.
  boardSync.release()
  boardSync.hold()
  configStore.update([9], (c) => ({ ...c, actuationMm: 1.4 }))
  await sleep(80)
  eq('the count did not go negative', calls, [])
  boardSync.release()
  await sleep(80)
  eq('and it still sends on release', calls, ['write:1'])
}

// --- a read never overlaps a write ------------------------------------------
{
  calls.length = 0
  maxOverlap = 0
  configStore.update([4], (c) => ({ ...c, actuationMm: 2.0 }))
  // Ask for a read while the write is running, then again behind it.
  const a = boardSync.read()
  const b = boardSync.flush()
  const c = boardSync.read()
  await Promise.all([a, b, c])
  await sleep(200)
  eq('one at a time, never two', maxOverlap, 1)
  ok('the write happened', calls.some((x) => x.startsWith('write')), calls.join(','))
}

// --- a read is skipped while an edit is still pending -----------------------
{
  calls.length = 0
  boardSync.hold()
  configStore.update([5], (c) => ({ ...c, actuationMm: 3.0 }))
  await boardSync.read()
  eq('the read does not clobber the held edit', calls, [])
  ok('and the edit is still queued', configStore.dirtyIndices().includes(5))
  boardSync.release()
  await sleep(120)
  eq('which then goes out', calls, ['write:1'])
}

// --- an edit during a write stays dirty for the next one --------------------
{
  calls.length = 0
  configStore.update([6], (c) => ({ ...c, actuationMm: 1.0 }))
  // Land this while the write above is in its 30 ms.
  await sleep(10)
  configStore.update([7], (c) => ({ ...c, actuationMm: 1.0 }))
  await sleep(200)
  eq('two writes, one key each', calls, ['write:1', 'write:1'])
  eq('and nothing left dirty', configStore.dirtyIndices().length, 0)
}

// --- a dragged board-wide control holds its write too -----------------------
/*
 * The regression this file exists for, in the half that did not have it.
 * `applyGlobal` used to send every patch as its own write, on the reasoning
 * that the block held nothing that could be dragged. The lighting effect put
 * two sliders and a colour in it, and a drag then queued a read-modify-write
 * per pixel — each with a settle delay — so the board fell seconds behind the
 * pointer and the app felt stuck.
 */
{
  calls.length = 0
  boardSync.hold()
  // Forty ticks of a brightness drag, which is a short one.
  for (let i = 0; i < 40; i++) {
    void boardSync.applyGlobal({ lighting: { brightness: i } })
    await sleep(2)
  }
  eq('nothing sent while the handle is held', calls.length, 0)
  ok('but the panel can see what it will send', boardSync.current().pendingGlobal !== null)
  eq('and it is the value under the pointer', pendingLight()?.brightness, 39)
  boardSync.release()
  await sleep(150)
  eq('one write on release', calls, ['global:brightness=39'])
  eq('nothing left pending', boardSync.current().pendingGlobal, null)
}

// --- the control keeps its value for the length of the write ---------------
/*
 * The glitch this guards against: clearing the pending edit when the write
 * *starts* rather than when the board confirms it. A board-wide write is a
 * read, a write, a 400 ms settle and a verify read, so for that half-second the
 * store still holds the old value — and a slider reading from the store alone
 * snapped back to where it was and jumped forward again once the read landed.
 * It looks exactly like the edit being lost.
 */
{
  calls.length = 0
  void boardSync.applyGlobal({ lighting: { brightness: 88 } })
  // Mid-write: the fake codec takes 30 ms per exchange, so this lands inside.
  await sleep(15)
  eq('the phase says a write is running', boardSync.current().phase, 'writing')
  eq('and the value is still shown', pendingLight()?.brightness, 88)
  await sleep(200)
  eq('only once the board confirms does it clear', boardSync.current().pendingGlobal, null)
  eq('and one write carried it', calls, ['global:brightness=88'])
}

// --- patches merge rather than replace one another --------------------------
{
  calls.length = 0
  boardSync.hold()
  void boardSync.applyGlobal({ lighting: { color: { r: 1, g: 2, b: 3 } } })
  void boardSync.applyGlobal({ lighting: { brightness: 50 } })
  void boardSync.applyGlobal({ lighting: { brightness: 60 } })
  boardSync.release()
  await sleep(150)
  // The colour survives the two brightness patches that followed it: a drag
  // must not throw away a value set a moment earlier.
  eq('one write carrying both fields', calls, ['global:brightness=60,color={"r":1,"g":2,"b":3}'])
}

// --- an undragged control still goes at once --------------------------------
{
  calls.length = 0
  void boardSync.applyGlobal({ lighting: { colorful: true } })
  await sleep(150)
  // A checkbox has nothing to throttle. Making it wait was the first cut's
  // mistake on the per-key path, and it should not be repeated here.
  eq('a switch is not delayed', calls, ['global:colorful=true'])
}

// --- changes during a write leave in the next one, not one write each -------
{
  calls.length = 0
  void boardSync.applyGlobal({ lighting: { brightness: 10 } })
  // Land these while the write above is in its 30 ms.
  await sleep(10)
  void boardSync.applyGlobal({ lighting: { brightness: 20 } })
  void boardSync.applyGlobal({ lighting: { speed: 2 } })
  await sleep(300)
  eq('two writes, and the second carries both later changes', calls, [
    'global:brightness=10',
    'global:brightness=20,speed=2',
  ])
}

// --- a failed board-wide write keeps the edit -------------------------------
{
  calls.length = 0
  const write = codec.writeGlobalSettings
  codec.writeGlobalSettings = async () => {
    throw new Error('board said no')
  }
  void boardSync.applyGlobal({ lighting: { brightness: 77 } })
  await sleep(150)
  // Left pending on purpose, the same way a failed per-key write leaves its
  // keys dirty: the board does not have the value, so something still must.
  ok('the error is reported', boardSync.current().error !== null)
  eq('and the edit is still pending', pendingLight()?.brightness, 77)
  codec.writeGlobalSettings = write
  calls.length = 0
  await boardSync.flush()
  await sleep(150)
  eq('so the retry can send it', calls, ['global:brightness=77'])
}

// --- a board-wide write never overlaps a per-key one ------------------------
{
  calls.length = 0
  maxOverlap = 0
  configStore.update([20], (c) => ({ ...c, actuationMm: 1.1 }))
  void boardSync.applyGlobal({ lighting: { brightness: 5 } })
  await sleep(350)
  // Both are read-modify-writes over a whole block. Two at once means one of
  // them reading a half-written base.
  eq('one at a time, never two', maxOverlap, 1)
  ok('and both happened', calls.length >= 2, calls.join(','))
}

console.log(`${pass} checks passed, ${fails.length} failed`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
