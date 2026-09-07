/**
 * A keyboard in software: the firmware side of the demo.
 *
 * This is not a mock of the app's codec. It is a mock of the *board* — it takes
 * 64-byte output payloads and answers with 64-byte input reports, so everything
 * above the wire runs unchanged: the codec is selected by probing USB ids, the
 * blocks are read chunk by chunk, every write is read back and verified, and
 * the analog stream has to be armed with 0xa8 before a single event arrives.
 * A bug in the engine shows up here the same way it would on hardware, which is
 * the whole reason for doing it at this layer rather than by stubbing methods.
 *
 * What it does not claim to be is a *record* of the hardware. The blobs below
 * are plausible, not captured: the numbers come from the constants the protocol
 * modules already document (the factory global block, the 0.62 calibration
 * floor, 1.5 mm actuation) and the rest is invented so that every panel has
 * something to show. Nothing here should ever be read as evidence about the
 * real firmware — `docs/protocol.md` is that, and this file is downstream of it.
 *
 * The one thing that is genuinely live is travel: the demo board reports the
 * keys of the keyboard the reader is typing on. See `keys.ts`.
 *
 * Which board it is is `spec.ts` — an 87-key tenkeyless answering the protocol
 * decoded from a Raven61. Nothing below names a key count or a slot: the layout
 * and the block geometry are read off the spec, the same way the engine reads
 * them for real hardware.
 */

import { layoutOf, type Layout } from '../device/layout'
import type { KeyDef } from '../device/spec'
import { CAL, CAL_STATE, ledColor } from '../protocol/calibration'
import { mmToCounts } from '../protocol/encoding'
import { COMMAND, DANGEROUS_COMMANDS, EVENT, sign } from '../protocol/frame'
import { FACTORY_GLOBAL } from '../protocol/global'
import { encodeKeyPerfRecord } from '../protocol/keyPerf'
import { keyRgbBlobSize } from '../protocol/keyRgb'
import {
  LIGHT_CONTROL,
  LIGHT_LIMITS,
  LIGHT_MODE_OFF,
  decodeLighting,
  effectOf,
  supportsControl,
} from '../protocol/lighting'
import { encodeRecord, factoryBinding } from '../protocol/keymap'
import { fallbackSlotMap } from '../protocol/slotMap'
import { demoSpec } from './spec'
import { isModifierUsage, modifierBit, usageForCode } from './keys'

/**
 * What the demo board's firmware calls itself.
 *
 * The same three fields the real 0x03 handler joins with commas — build name,
 * `__DATE__`, `__TIME__` — with a name that could not be mistaken for a real
 * image, so nobody reads a screenshot of the demo as a report about firmware
 * anybody is running.
 */
const FIRMWARE_IDENTITY = 'DEMO_TKL_87,Jan 01 2025,00:00:00'

/** How long the flash rewrite behind a factory reset takes to land. */
const RESET_APPLY_MS = 900

/** One tick of the event generator. ~60 Hz, like a board that is scanning. */
const TICK_MS = 16

/**
 * How long a key takes to travel from rest to the bottom, in ms.
 *
 * The host only says "down" and "up", so the stroke in between is drawn here.
 * 45 ms is about what a deliberate press measures at, and it is slow enough
 * that the intermediate depths are visible in the monitor rather than being one
 * frame of animation.
 */
const STROKE_MS = 45

/** Key travel the firmware treats as bottomed out, as a fraction. */
const BOTTOM_OUT = CAL.bottomOutRaw / CAL.travelRawFull

interface Press {
  key: KeyDef
  /** 0 at rest, 1 at the bottom. */
  depth: number
  /** Where the stroke is heading — 1 while held, 0 once released. */
  target: number
}

export class DemoBoard {
  private readonly spec = demoSpec
  private readonly layout = layoutOf(demoSpec.layout)
  /** key index -> slot, and the inverse. The demo board's own wiring. */
  private readonly slotByKey: Map<number, number>
  private readonly keyBySlot: Map<number, KeyDef>

  // The blobs, exactly as the commands address them.
  private global!: Uint8Array
  private keyPerf!: Uint8Array
  private keymapLive!: Uint8Array
  private keymapDefaults!: Uint8Array
  /** The stored per-key custom colour layer — see protocol/keyRgb.ts. */
  private keyRgb!: Uint8Array
  /** Never restored by a factory reset — see FACTORY_RESET_DEFAULTS. */
  private calibration!: Uint8Array

  /** Latched by 0xa8 and never cleared, the way the real board behaves. */
  private reporting = false
  /** Held only while 0xa8 keeps arriving. Calibration learns in this mode. */
  private testMode = false
  private testModeUntil = 0

  private pressed = new Map<number, Press>()
  /** Advances once per tick; the only thing the resting-ADC jitter varies with. */
  private scan = 0
  private tick: ReturnType<typeof setInterval> | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()

  /** Set by the device wrapper; every input report goes through it. */
  emit: (payload: Uint8Array) => void = () => {}

  constructor() {
    const map = fallbackSlotMap(this.layout, this.spec.slotMap.unusedSlots)
    this.slotByKey = map.slotByKey
    this.keyBySlot = map.keyBySlot
    this.calibration = this.buildCalibration()
    this.resetBlobs()
  }

  // --- lifecycle -----------------------------------------------------------

  start(): void {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.stopTicking()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.pressed.clear()
    this.reporting = false
    this.testMode = false
  }

  // --- the wire ------------------------------------------------------------

  /**
   * One output report from the host, answered on a microtask.
   *
   * Not on a timer, and the reason is worth writing down because the first
   * version was: this board used to answer after a couple of milliseconds, with
   * the two mode packets taking the 15.9 ms and 34.5 ms a capture measured for
   * them. It worked until the browser tab went to the background, where
   * `setTimeout` is clamped to a second — every reply then arrived long after
   * the engine's 300 ms request timeout, and reading a blob turned into a
   * screenful of chunk timeouts for anyone who switched tabs mid-read.
   *
   * A real board does not care whether its host is on screen, so neither can
   * this one. A microtask is the only wait that is never throttled, and it
   * still lands strictly after the write it answers — `HidLink.request`
   * registers its waiter before writing, so nothing is racing to be first.
   */
  handle(payload: Uint8Array): void {
    const f = this.spec.frame
    if (payload[f.offsets.magic] !== f.magic) return
    const command = payload[f.offsets.command] ?? 0
    const reply = this.reply(command, payload)
    if (!reply) return
    queueMicrotask(() => this.emit(reply))
  }

  /** The answer to one command, or null for a command this firmware does not have. */
  private reply(command: number, request: Uint8Array): Uint8Array | null {
    switch (command) {
      // The transaction brackets. The firmware acknowledges and little else.
      case COMMAND.begin:
      case COMMAND.end:
        return this.ack(request)

      case COMMAND.readFirmware:
        return this.identityReply(command)

      case COMMAND.readDeviceId:
        // The identity page at flash 0x20000: VID, PID and bcdDevice, LE16 each.
        return this.blockReply(request, command, this.deviceIdPage())

      // The global block is the one read that is not a block transfer: the
      // settings sit at their own payload offsets, and a write copies the whole
      // reply back. See protocol/global.ts.
      case COMMAND.readGlobalSettings:
        return this.globalReply(command)
      case COMMAND.globalSettings: {
        // Read-modify-write, from the board's side: the host sent back the
        // whole reply with its own fields edited, so the data area replaces the
        // block wholesale rather than field by field.
        const data = this.spec.frame.offsets.data
        this.global.set(request.subarray(data, this.spec.frame.payloadLength), data)
        return this.ack(request)
      }

      case COMMAND.readKeymapDefaults:
        return this.blockReply(request, command, this.keymapDefaults)
      case COMMAND.readKeymapLive:
        return this.blockReply(request, command, this.keymapLive)
      case COMMAND.writeKeymapLive:
        this.blockWrite(request, this.keymapLive)
        return this.ack(request)

      case COMMAND.readKeyPerf:
        return this.blockReply(request, command, this.keyPerf)
      case COMMAND.writeKeyPerf:
        this.blockWrite(request, this.keyPerf)
        return this.ack(request)

      case COMMAND.readKeyRgb:
        return this.blockReply(request, command, this.keyRgb)
      case COMMAND.writeKeyRgb:
        this.blockWrite(request, this.keyRgb)
        return this.ack(request)

      // The live frame is a different memory: the stored layer with whatever
      // the firmware paints over it. Here that is the calibration overlay,
      // which is the one override this project has decoded (docs §3.3) — and
      // simulating it is what makes the difference between the two blocks
      // visible in the demo instead of only described in the panel.
      case COMMAND.readLightRgb:
        return this.blockReply(request, command, this.ledFrame())

      case COMMAND.readCalibration:
        return this.blockReply(request, command, this.calibration)

      case COMMAND.analogTestOn:
        this.armReporting()
        return this.ack(request)
      case COMMAND.analogTestOff:
        this.testMode = false
        return this.ack(request)

      case DANGEROUS_COMMANDS.factoryReset:
        // The ack means "request received". The flash rewrite happens after,
        // which is why the driver waits six seconds before reading anything.
        this.after(RESET_APPLY_MS, () => this.resetBlobs())
        return this.ack(request)

      default:
        // Blocks this app has not decoded. The board answers them; it simply
        // has nothing here worth putting in them, so they read back as zeros.
        if (UNDECODED_READS.includes(command)) {
          return this.blockReply(request, command, ZERO_BLOB)
        }
        if (UNDECODED_WRITES.includes(command)) return this.ack(request)
        // Anything else is a command this firmware does not have. Silence is
        // what the prober should see, not a fabricated acknowledgement.
        return null
    }
  }

  // --- reply shapes --------------------------------------------------------

  /** The request echoed back with payload[0] replaced by 0xAA. */
  private ack(request: Uint8Array): Uint8Array {
    const f = this.spec.frame
    const out = request.slice()
    out[0] = f.ack
    return sign(out, f)
  }

  /** A block-read reply: the header echoed, the chunk at BLOCK.data. */
  private blockReply(request: Uint8Array, command: number, blob: Uint8Array): Uint8Array {
    const f = this.spec.frame
    const { offset, length } = this.blockHeader(request)
    const out = new Uint8Array(f.payloadLength)
    out[0] = f.ack
    out[f.offsets.command] = command
    out[f.block.length] = length
    out[f.block.offsetLo] = offset & 0xff
    out[f.block.offsetHi] = (offset >> 8) & 0xff
    for (let i = 0; i < length && f.block.data + i < f.payloadLength; i++) {
      out[f.block.data + i] = blob[offset + i] ?? 0
    }
    return sign(out, f)
  }

  private blockWrite(request: Uint8Array, blob: Uint8Array): void {
    const f = this.spec.frame
    const { offset, length } = this.blockHeader(request)
    for (let i = 0; i < length; i++) {
      if (offset + i >= blob.length) break
      blob[offset + i] = request[f.block.data + i] ?? 0
    }
  }

  private blockHeader(request: Uint8Array): { offset: number; length: number } {
    const b = this.spec.frame.block
    return {
      offset: ((request[b.offsetHi] ?? 0) << 8) | (request[b.offsetLo] ?? 0),
      length: Math.min(request[b.length] ?? 0, this.spec.frame.payloadLength - b.data),
    }
  }

  /**
   * 0x03: the handler ignores every request field and writes its own length.
   *
   * Shaped like a block read all the same — length at BLOCK.length, bytes from
   * BLOCK.data — which is why the engine can decode it with `blockReplyData`.
   */
  private identityReply(command: number): Uint8Array {
    const f = this.spec.frame
    const room = f.payloadLength - f.block.data
    const bytes = new TextEncoder().encode(FIRMWARE_IDENTITY).subarray(0, room)
    const out = new Uint8Array(f.payloadLength)
    out[0] = f.ack
    out[f.offsets.command] = command
    out[f.block.length] = bytes.length
    out.set(bytes, f.block.data)
    return sign(out, f)
  }

  /**
   * 0x05: the settings block, at the payload offsets `decodeGlobalSettings`
   * reads — not at BLOCK.data, because this one is not a block transfer.
   */
  private globalReply(command: number): Uint8Array {
    const f = this.spec.frame
    const out = this.global.slice()
    out[0] = f.ack
    out[f.offsets.command] = command
    return sign(out, f)
  }

  private deviceIdPage(): Uint8Array {
    const out = new Uint8Array(this.spec.frame.payloadLength)
    const { vendorId, productIds } = this.spec.usb
    const pid = productIds[0] ?? 0
    out.set([vendorId & 0xff, vendorId >> 8, pid & 0xff, pid >> 8, 0x10, 0x01])
    return out
  }

  // --- the blobs -----------------------------------------------------------

  /**
   * Everything a factory reset rewrites, put back the way it ships.
   *
   * The calibration table is not in here, and that is not an oversight: the
   * reset routine never writes it, so what the board learned about each switch
   * survives. The demo behaves the same, which is the point — someone trying
   * the reset button should see the same thing survive that would survive on
   * hardware.
   */
  private resetBlobs(): void {
    this.global = this.buildGlobal()
    this.keyPerf = this.buildKeyPerf()
    this.keymapDefaults = this.buildKeymapDefaults()
    this.keymapLive = this.buildKeymapLive()
    /*
     * Zeroed, which on this block means *no custom colour* rather than black.
     *
     * The real reset copies a defaults table out of code flash (0x175f4) whose
     * contents nobody has dumped, so a demo that invented colours there would
     * be inventing evidence. An empty layer is the one thing the block is known
     * to say.
     */
    this.keyRgb = new Uint8Array(keyRgbBlobSize(this.spec.keyRgb))
  }

  private buildGlobal(): Uint8Array {
    const f = this.spec.frame
    const o = this.spec.global.offsets
    // A board whose spec does not state its own resets to the family's.
    const d = this.spec.global.factoryDefaults ?? FACTORY_GLOBAL
    const out = new Uint8Array(f.payloadLength)
    // Byte 4 is the block length in a request, and the read reply carries it in
    // the same slot. A write copies the reply wholesale, so keeping it here is
    // what makes the round trip stable.
    out[f.block.length] = this.spec.global.length
    out[o.rate] = ((d.tickRate & 0x0f) << 4) | (d.reportRate & 0x0f)
    out[o.deadZone] = d.deadZone
    out[o.gameLock] = 0
    out[o.flags] = d.flags
    /*
     * The lighting bytes, from the same defaults table the real reset copies.
     *
     * Written here rather than left zero because zero is a real effect —
     * Custom Light — and a demo board that came up claiming that while showing
     * no colours would be its own small lie. `colorIndex` stays 0: nothing is
     * known about what it selects, so there is nothing to simulate.
     */
    if (o.lightMode !== null) out[o.lightMode] = d.lightMode
    if (o.brightness !== null) out[o.brightness] = d.brightness
    if (o.speed !== null) out[o.speed] = d.speedWire
    if (o.direction !== null) out[o.direction] = 0
    if (o.colorful !== null) out[o.colorful] = d.colorful
    if (o.color !== null) {
      // The firmware's own default: full red.
      out[o.color] = 0xff
      out[o.color + 1] = 0
      out[o.color + 2] = 0
    }
    return sign(out, f)
  }

  /**
   * 128 slots of eight bytes, of which only the wired ones are populated.
   *
   * A slot with no key behind it stays all zero, which is what a hardware dump
   * shows and what `emptySlotsOf` reports — so the demo board has the same
   * three holes in its slot space that the real one does.
   */
  private buildKeyPerf(): Uint8Array {
    const perf = this.spec.keyPerf
    const out = new Uint8Array(perf.recordSize * perf.slots)
    const counts = (mm: number) => mmToCounts(mm, this.spec.encoding.countsPerMm)
    for (const slot of this.keyBySlot.keys()) {
      const record = encodeKeyPerfRecord(
        {
          switchType: 0,
          switchFlags: 0,
          keyMode: perf.keyMode.off,
          actuationCounts: counts(1.5),
          rtPressCounts: counts(0.3),
          rtReleaseCounts: counts(0.3),
          pressDeadzoneCounts: 0,
          releaseDeadzoneCounts: 0,
          deadzoneState: false,
          rtUnset: false,
        },
        perf,
      )
      out.set(record, slot * perf.recordSize)
    }
    return out
  }

  /**
   * The factory keymap in code flash — the block the slot map is built from.
   *
   * One entry per slot in the board's own order, which is what makes
   * `slotMapFromKeymap` resolve to the same mapping this class wired above.
   * `factoryBinding` is the app's own encoder for the three shapes the table
   * holds (a modifier as a bitmask, Fn as the momentary-layer action, a plain
   * usage for everything else), so the bytes are the ones the keymap panel
   * knows how to read back.
   */
  private buildKeymapDefaults(): Uint8Array {
    const km = this.spec.keymap
    const out = new Uint8Array(km.defaultsBlobSize)
    for (const [slot, key] of this.keyBySlot) {
      const at = slot * km.entrySize
      if (at + km.entrySize > out.length) continue
      out.set(encodeRecord(factoryBinding(key.code)), at)
    }
    return out
  }

  /**
   * The live keymap: layer 0 is the factory table, layer 1 is empty.
   *
   * Empty on purpose, and it is what the second layer of a board that ships
   * without an Fn key looks like. This one has no Fn — a tenkeyless has the
   * room not to need one — so nothing on it reaches layer 1, and filling the
   * layer with bindings no key can select would be showing the reader a state
   * their board could not be in.
   */
  private buildKeymapLive(): Uint8Array {
    const km = this.spec.keymap
    const out = new Uint8Array(km.layerBytes * km.layers)
    for (const [slot, key] of this.keyBySlot) {
      const at = slot * km.entrySize
      if (at + km.entrySize > km.layerBytes) continue
      out.set(encodeRecord(factoryBinding(key.code)), at)
    }
    return out
  }

  /**
   * A believable spread of calibration health, so the panel has all three of
   * its verdicts on screen at once.
   *
   * Every tenth slot is left at the shipped floor — a key that has never been
   * calibrated — and the one after it partway up. The rest sit at their own
   * scale with the firmware's latched `done` state. The AA BB FF tag is what
   * the boot path checks before trusting a record, so every record carries it.
   */
  /**
   * What the LEDs are showing: the stored layer, with the firmware's
   * calibration overlay painted over it.
   *
   * The overlay is the real rule, not a flourish — 0x13974 indexes the status
   * palette with the calibration state byte and paints only states 0 and 1, so
   * a key that has never been bottomed out shows red whatever colour is stored
   * for it. That is exactly why 0xde cannot stand in for a verify read, and the
   * demo would be misleading if its two blocks always agreed.
   *
   * No effect animation. The demo runs no lighting mode because none has been
   * decoded, so an unlit key comes back unlit rather than carrying a pattern
   * this project would be inventing.
   */
  private ledFrame(): Uint8Array {
    const rgb = this.spec.keyRgb
    const cal = this.spec.calibration
    const light = decodeLighting(this.global, this.spec.global)
    const frame = new Uint8Array(rgb.recordSize * rgb.slots)

    /*
     * The base layer, from whichever effect the settings block names.
     *
     * Only two of the board's effects are simulated, and both because their
     * rule is *known* rather than guessed: Custom Light paints the stored
     * per-key block (that is the effect the `perKey` bit marks, and the block
     * is decoded), and the off row lights nothing. Everything else on the real
     * board is an animation this project has not decoded, so it comes back as
     * the effect's single colour on every key — which is honest about being a
     * placeholder and still lets the panel be exercised.
     */
    if (light && light.mode !== LIGHT_MODE_OFF) {
      const custom = supportsControl(effectOf(this.spec.lightEffects, light.mode), LIGHT_CONTROL.perKey)
      for (let slot = 0; slot < rgb.slots; slot++) {
        if (!this.keyBySlot.has(slot)) continue
        const at = slot * rgb.recordSize
        if (custom) {
          frame[at] = this.keyRgb[at] ?? 0
          frame[at + 1] = this.keyRgb[at + 1] ?? 0
          frame[at + 2] = this.keyRgb[at + 2] ?? 0
        } else {
          frame[at] = light.color.r
          frame[at + 1] = light.color.g
          frame[at + 2] = light.color.b
        }
      }
      // Brightness is a percentage and the firmware scales the channels by it,
      // so a demo that ignored it would show a slider that does nothing.
      if (light.brightness < LIGHT_LIMITS.brightnessMax) {
        for (let i = 0; i < frame.length; i++) {
          frame[i] = Math.round(((frame[i] ?? 0) * light.brightness) / LIGHT_LIMITS.brightnessMax)
        }
      }
    }

    /*
     * Then the firmware's calibration overlay, over the top of whatever the
     * effect produced — 0x13974 paints states 0 and 1 and nothing else, and it
     * is the one override this project has decoded (docs §3.3). Simulating it
     * is what makes the difference between the stored layer and the live frame
     * visible in the demo instead of only described in the panel.
     */
    for (let slot = 0; slot < rgb.slots; slot++) {
      const state = this.calibration[slot * cal.recordSize + 4] ?? CAL_STATE.done
      const color = ledColor(state)
      if (!color) continue
      const at = slot * rgb.recordSize
      const n = Number.parseInt(color.slice(1), 16)
      frame[at] = (n >> 16) & 0xff
      frame[at + 1] = (n >> 8) & 0xff
      frame[at + 2] = n & 0xff
    }
    return frame
  }

  private buildCalibration(): Uint8Array {
    const { records, recordSize } = this.spec.calibration
    const out = new Uint8Array(records * recordSize)
    const view = new DataView(out.buffer)
    for (let slot = 0; slot < records; slot++) {
      const wired = this.keyBySlot.has(slot)
      const target = targetScale(slot)
      const phase = slot % 10
      const scale = !wired || phase === 0 ? CAL.scaleFloor : phase === 1 ? (CAL.scaleFloor + target) / 2 : target
      const state = !wired || phase === 0 ? CAL_STATE.fresh : phase === 1 ? CAL_STATE.learning : CAL_STATE.done
      const at = slot * recordSize
      view.setFloat32(at, scale, true)
      out[at + 4] = state
      out.set([0xaa, 0xbb, 0xff], at + 5)
    }
    return out
  }

  // --- the analog stream ---------------------------------------------------

  /**
   * 0xa8 turns reporting on and enters the test mode.
   *
   * Only the first latches. The mode is held for as long as the packets keep
   * coming — the engine re-sends every 1500 ms for calibration — and lapses on
   * its own otherwise, which is what makes plain monitoring leave typing alone.
   */
  private armReporting(): void {
    this.reporting = true
    this.testMode = true
    this.testModeUntil = now() + this.spec.monitor.rearmMs * 2
  }

  /**
   * The scan loop runs only while a key is doing something.
   *
   * The board reports on change — the sensors tab says so to the reader in as
   * many words, and asks them to press each key once to fill its grid — so
   * there is nothing to send while the board sits still. It matters more here
   * than on hardware: reporting latches on for the rest of the session, and a
   * simulated board that kept sweeping would be filling the traffic log at a
   * few hundred entries a second long after the monitor was closed.
   */
  private startTicking(): void {
    if (this.tick !== null) return
    this.tick = setInterval(() => this.onTick(), TICK_MS)
  }

  private stopTicking(): void {
    if (this.tick === null) return
    clearInterval(this.tick)
    this.tick = null
  }

  private onTick(): void {
    if (this.testMode && now() > this.testModeUntil) this.testMode = false
    this.scan++

    // Every key in motion, and every key being held: a real board reports the
    // whole stroke, which is what the travel bars are drawn from.
    for (const press of [...this.pressed.values()]) {
      const step = TICK_MS / STROKE_MS
      const moving = press.depth !== press.target
      press.depth =
        press.target > press.depth
          ? Math.min(press.target, press.depth + step)
          : Math.max(press.target, press.depth - step)
      if (this.testMode && press.depth >= BOTTOM_OUT) this.learn(press.key)
      this.emit(this.keyEvent(press.key, press.depth, press.target > 0 ? 'down' : 'up'))
      // A key that has come all the way back up has nothing more to report,
      // and once the last one has the loop has nothing to do either.
      if (!moving && press.depth === 0) this.pressed.delete(press.key.index)
    }
    if (this.pressed.size === 0) this.stopTicking()
  }

  /**
   * One analog event, built the way the firmware builds one.
   *
   * `travelRaw` is `(rest - live) / scale` clamped at 800, the depth in 0.02 mm
   * counts comes off it, and the scale is sent as three truncated decimal
   * digits — which is also where the "sensor id" the app fingerprints keys by
   * comes from. Deliberately unsigned: `payload[3]` is the usage byte in an
   * event and the checksum byte in a command, so an event that carried a
   * checksum would be an event that named the wrong key.
   */
  private keyEvent(key: KeyDef, depth: number, direction: 'down' | 'up'): Uint8Array {
    const f = this.spec.frame
    const e = this.spec.event
    const slot = this.slotByKey.get(key.index) ?? 0
    const { scale, state } = this.calibrationOf(slot)
    const baseline = baselineOf(key.index)
    const travelCounts = e.defaultTravelCounts
    const travelRaw = Math.round(clamp01(depth) * CAL.travelRawFull)
    const depthCounts = Math.round(clamp01(depth) * travelCounts)
    // A resting key is never perfectly still: the ADC wanders by a count or two,
    // and a monitor that showed a flat line would be the tell that this is not
    // a board.
    const jitter = depth === 0 ? noise(key.index, this.scan) : 0
    const adc = baseline - Math.round(travelRaw * scale) + jitter
    const isFn = key.code === e.fnSelector
    const bits = modifierBit(key.code)

    const p = new Uint8Array(f.payloadLength)
    p[0] = f.replyData
    p[e.type] = isFn ? e.kind.fn : e.kind.key
    p[e.modifiers] = isFn ? e.fnSelector : bits
    // Modifiers and Fn have no keycode-array usage, so the byte stays clear and
    // the bitmask above is what names them.
    p[e.usage] = isFn || isModifierUsage(key.code) ? 0 : key.code & 0xff
    be16(p, e.travelRaw, travelRaw)
    p[e.depth] = Math.min(0xff, depthCounts)
    // Not a spec field: `unknown8` is undecoded, so there is nothing for a
    // sibling board to state about it. It tracks depth on a shallow press.
    p[EVENT.unknown8] = Math.min(0xff, depthCounts)
    p[e.direction] = direction === 'down' ? 0x01 : 0xff
    p[e.calState] = state
    const digits = scaleDigits(scale)
    p[e.scaleUnits] = digits.units
    p[e.scaleTenths] = digits.tenths
    p[e.scaleHundredths] = digits.hundredths
    be16(p, e.travel, travelCounts)
    be16(p, e.adc, Math.max(0, adc))
    be16(p, e.adcBaseline, baseline)
    return p
  }

  private calibrationOf(slot: number): { scale: number; state: number } {
    const at = slot * this.spec.calibration.recordSize
    const view = new DataView(this.calibration.buffer, this.calibration.byteOffset)
    return { scale: view.getFloat32(at, true), state: this.calibration[at + 4] ?? 0 }
  }

  /**
   * What a calibration pass does, in miniature.
   *
   * The firmware only ever grows the scale, by at least 0.005 at a time, and
   * bumps the state the first two times it does — after which the state latches
   * to `done`. Bottoming a key out in the demo therefore walks a red key up to
   * its own scale and turns the indicator off, the same way and in the same
   * order the real one does.
   */
  private learn(key: KeyDef): void {
    const slot = this.slotByKey.get(key.index)
    if (slot === undefined) return
    const at = slot * this.spec.calibration.recordSize
    const view = new DataView(this.calibration.buffer, this.calibration.byteOffset)
    const scale = view.getFloat32(at, true)
    const target = targetScale(slot)
    if (scale >= target - CAL.scaleStep) return
    view.setFloat32(at, Math.min(target, scale + 0.01), true)
    const state = this.calibration[at + 4] ?? 0
    this.calibration[at + 4] = state === CAL_STATE.done ? state : state >= 2 ? CAL_STATE.done : state + 1
  }

  // --- the host keyboard ---------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    this.press(e.code, 1)
  }

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.press(e.code, 0)
  }

  /**
   * A window that loses focus never sees the keyup, so every held key would
   * stay held. Releasing them here is the same thing a keyboard's own firmware
   * does when the host stops listening.
   */
  private readonly onBlur = () => {
    for (const press of this.pressed.values()) press.target = 0
  }

  private press(code: string, target: 0 | 1): void {
    if (!this.reporting) return
    const key = keyForCode(this.layout, code)
    if (!key) return
    const existing = this.pressed.get(key.index)
    if (existing) {
      existing.target = target
      return
    }
    if (target === 0) return
    this.pressed.set(key.index, { key, depth: 0, target })
    this.startTicking()
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }
}

/** Read commands this app does not decode. The board answers; the blob is empty. */
const UNDECODED_READS: readonly number[] = [
  COMMAND.readMacros,
  COMMAND.readAdvancedKeys,
  COMMAND.readLightConfigA,
  COMMAND.readLightConfigB,
  COMMAND.readReserved,
]

const UNDECODED_WRITES: readonly number[] = [
  COMMAND.writeMacros,
  COMMAND.writeAdvancedKeys,
  COMMAND.writeLightConfigA,
  COMMAND.writeLightConfigB,
  COMMAND.writeLightRgb,
  COMMAND.writeReserved,
]

const ZERO_BLOB = new Uint8Array(4096)

/** The board key a host `KeyboardEvent.code` lands on, if this board has one. */
function keyForCode(layout: Layout, code: string): KeyDef | undefined {
  const usage = usageForCode(code)
  return usage === undefined ? undefined : layout.byUsage(usage)
}

/** The scale a well-calibrated key settles at, deterministic per slot. */
function targetScale(slot: number): number {
  return Math.round((0.78 + ((slot * 13) % 31) / 100) * 100) / 100
}

/** The resting ADC of a key. Distinct per key, which is what a fingerprint needs. */
function baselineOf(index: number): number {
  return 1800 + ((index * 37) % 160)
}

function noise(index: number, tick: number): number {
  return (((index * 7 + tick * 13) % 5) - 2)
}

function scaleDigits(scale: number): { units: number; tenths: number; hundredths: number } {
  const units = Math.trunc(scale)
  const tenths = Math.trunc((scale - units) * 10)
  const hundredths = Math.trunc((scale - units - tenths / 10) * 100)
  return { units, tenths, hundredths }
}

function be16(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >> 8) & 0xff
  out[at + 1] = value & 0xff
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function now(): number {
  return performance.now()
}
