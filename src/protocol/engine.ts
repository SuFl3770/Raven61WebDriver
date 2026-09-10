/**
 * The protocol engine: one `DeviceSpec` in, one working codec out.
 *
 * This is the whole of what `raven61.ts` used to be, with every constant it
 * reached for replaced by a field of the spec it is handed. The comments are
 * the same ones, and they still describe the Raven61 — that is where the
 * evidence came from, and a sibling board inheriting a number inherits the
 * reasoning behind it too. Where a board differs, its spec says so and the
 * text here stops applying to it; nothing below assumes otherwise.
 *
 * Two rules survived the move and are worth restating, because they are the
 * reason the write paths look the way they do:
 *
 *   - **Every write is read-modify-write.** The blocks are wider than the keys
 *     this app models, and building one from the model alone would send zeros
 *     over everything it does not understand.
 *   - **Every write is verified by reading back.** An acknowledged write the
 *     firmware ignored is indistinguishable from one that worked.
 *
 * A command the spec leaves `null` is one the board does not have: the codec
 * is built without that method, `supports()` returns false, and the panel says
 * so instead of sending a byte nobody has decoded.
 */

import { layoutOf } from '../device/layout'
import type { DeviceSpec } from '../device/spec'
import type { HidLink } from '../hid/link'
import { t } from '../i18n'
import {
  ADVANCED_BLOCK_OF,
  ADVANCED_KEY_BLOCKS,
  advancedBlobSize,
  encodeAdvancedRecord,
  isFreeRecord,
  kindOfType,
  recordHex as advancedRecordHex,
  type AdvancedBlock,
  type AdvancedKeyBlobs,
  type AdvancedKind,
  type AdvancedRecord,
} from './advancedKeys'
import { parseCalTable, type CalRecord } from './calibration'
import type { KeyboardCodec } from './codec'
import {
  blockChunkSize,
  blockReplyData,
  blockReplyHeader,
  buildBlock,
  buildPacket,
  chunkPlan,
  isAck,
  isReplyTo,
  parseKeyEvent,
} from './frame'
import {
  decodeGlobalSettings,
  globalWriteRequest,
  sameGlobalData,
  writtenOffsets,
  type GlobalPatch,
  type GlobalWriteResult,
} from './global'
import { decodeRecord, encodeRecord, isUnsafe, type KeyBinding } from './keymap'
import {
  changedSlots,
  decodeKeyPerfRecord,
  fromKeyConfig,
  isEmptySlot,
  keyPerfBlobSize,
  patchSlot,
  recordHex,
  toKeyConfig,
} from './keyPerf'
import {
  changedRgbSlots,
  decodeKeyRgb,
  encodeKeyRgb,
  keyRgbBlobSize,
  rgbRecordHex,
  type Rgb,
} from './keyRgb'
import {
  decodeMacros,
  encodeMacros,
  isCanonical,
  macroBlobSize,
  macroBodyHex,
  macroWriteBytes,
  malformedSlots,
  sameMacro,
  type Macro,
} from './macros'
import { fallbackSlotMap, slotMapFromKeymap, type SlotMap } from './slotMap'
import type {
  AdvancedKeySnapshot,
  AdvancedKeyUse,
  FirmwareIdentity,
  GlobalSettings,
  KeyConfig,
  KeymapEntry,
  KeyPerfSnapshot,
  KeyRgbEntry,
  KeyRgbSnapshot,
  KeySample,
  MacroSnapshot,
  MacroUse,
} from './types'

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
export const MONITOR_DEFAULTS = {
  /**
   * Re-send period for calibration mode only. The driver uses 1900 ms
   * (0x42cb70); stay comfortably inside it.
   */
  rearmMs: 1500,
  /**
   * How long to wait for a mode packet to be acknowledged.
   *
   * Measured worst case is 0xa9's flash write at 34.5 ms, so this is an order
   * of magnitude of headroom rather than a tight bound — the point is to hold
   * the link queue until the board is listening again, not to time it.
   */
  ackMs: 400,
} as const

/**
 * ⚠⚠ Factory reset.
 *
 * The one command here that throws the board's settings away, and the only
 * reason it is reachable at all is that a person asked for it twice.
 *
 * ## What the board actually does
 *
 * The handler (firmware `0x76c6`) does almost nothing: it sets a byte at
 * `gp-0x791` and falls straight into the reply path, so the ack comes back
 * immediately and means only "request received". The work happens afterwards in
 * the main loop, at `0x1450c`, which clears the flag and then rewrites flash —
 * settings and keymap from default tables baked into the image, and several
 * blobs to zero:
 *
 *   0x20100  64 B    global settings   <- defaults at 0x175b4
 *   0x20700  1024 B  keymap            <- defaults at 0x17ff4
 *   0x20b00  1024 B  per-key perf      <- defaults at 0x177f4
 *   0x20f00  512 B                     <- defaults at 0x175f4
 *   0x21100+         lighting blobs    <- zeroed
 *
 * **The calibration table at 0x20300 is not in that list.** The reset routine
 * never writes it, so what the board learned about each switch survives — which
 * is worth saying plainly, because it is the one thing here that could not be
 * recovered by re-applying settings.
 *
 * ## Why the waits are what they are
 *
 * They are the stock driver's, not a guess: job `0x0c` (`0x443540`) sends the
 * packet bare — no `0x01` / `0x02` around it — then `Sleep(1000)`,
 * `Sleep(5000)`, and only then re-reads every blob. Six seconds of erasing and
 * rewriting flash is what that is allowing for, and reading sooner is reading
 * a board that is still working.
 */
export const FACTORY_RESET_DEFAULTS = {
  /** `Sleep(1000)` at 0x443585. */
  firstWaitMs: 1000,
  /** `Sleep(5000)` at 0x443590, before the driver reads anything back. */
  secondWaitMs: 5000,
} as const

/** What a write actually did, so the UI can report it rather than assume it. */
export interface KeyPerfWriteResult {
  /** Slots whose bytes the patch changed. Empty means nothing was sent. */
  slots: number[]
  /** Keys that were written, with the slot each landed in. */
  keys: { index: number; label: string; slot: number }[]
  /** Keys the slot map has no slot for, so they could not be written. */
  unmapped: { index: number; label: string }[]
  /** The blob as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The blob read back afterwards. */
  after: Uint8Array
  /** Slots that did not read back as written. Empty on a verified write. */
  mismatched: { slot: number; wanted: string; got: string }[]
  /**
   * The board's state after the write, decoded. The verify read has it anyway,
   * and handing it back saves the caller a third read of the same block just to
   * show what the board now holds.
   */
  configs: KeyConfig[]
}

/** What a keymap write did, so the panel can report it rather than assume it. */
export interface KeymapWriteResult {
  layer: number
  /** Slots whose record changed. Empty means nothing was sent. */
  slots: number[]
  /** Keys that were written, with the slot each landed in. */
  keys: { index: number; label: string; slot: number }[]
  /** Keys the slot map has no slot for, so they could not be written. */
  unmapped: { index: number; label: string }[]
  /** The layer as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The layer read back afterwards. */
  after: Uint8Array
  /** Slots that did not read back as written. Empty on a verified write. */
  mismatched: { slot: number; wanted: string; got: string }[]
}

/**
 * What a per-key colour write did.
 *
 * Shaped like `KeymapWriteResult` and reported for the same reason: the panel
 * says what happened rather than assuming it. `mismatched` is the part that
 * matters — an acknowledged write the firmware ignored is indistinguishable
 * from one that worked until the bytes are read back.
 */
export interface KeyRgbWriteResult {
  /** Slots whose record changed. Empty means nothing was sent. */
  slots: number[]
  /** Keys that were written, with the slot each landed in. */
  keys: { index: number; label: string; slot: number }[]
  /** Keys the slot map has no slot for, so they could not be written. */
  unmapped: { index: number; label: string }[]
  /** The block as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The block read back afterwards. */
  after: Uint8Array
  /** Slots that did not read back as written. Empty on a verified write. */
  mismatched: { slot: number; wanted: string; got: string }[]
}

/**
 * What one advanced-key record write did.
 *
 * Only the table the record's kind uses is touched, so `block` says which one
 * and `before` / `after` are that table. The stock driver sends all three
 * tables on every apply (0xa3, 0xa5 and 0xa7 back to back from each of its
 * three apply paths); this sends the one that changed, because each write
 * handler is an independent block copy with its own base address and its own
 * flash write — there is no cross-table commit to satisfy.
 */
export interface AdvancedKeyWriteResult {
  record: number
  kind: AdvancedKind
  block: AdvancedBlock
  /** False when the record already held these bytes and nothing was sent. */
  sent: boolean
  /** The table as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The table read back afterwards. */
  after: Uint8Array
  /** Set when the record did not read back as written. */
  mismatch: { wanted: string; got: string } | null
}

/**
 * What a macro-store write did.
 *
 * The whole store goes out, not one slot, and that is the safety rule rather
 * than laziness — the offset table indexes every body, so moving one body moves
 * the offsets of the ones after it, and a store with one unterminated body is a
 * store where every macro key is unsafe. See `protocol/macros.ts`.
 *
 * `changed` is the slots whose events differ from what the board held, which is
 * what a status line should name. `mismatch` is the slots that did not read back
 * as written — the same rule as every other block here, because an acknowledged
 * write the firmware ignored reads exactly like one that worked.
 */
export interface MacroWriteResult {
  /** False when the store already held these bodies and nothing was sent. */
  sent: boolean
  /** Bytes transferred — the offset table plus the bodies, not the whole 4 KB. */
  bytes: number
  changed: number[]
  /** The store as the board had it before the write — enough to undo it. */
  before: Uint8Array
  /** The store read back afterwards. */
  after: Uint8Array
  mismatch: { slot: number; wanted: string; got: string }[]
}

export interface FactoryResetResult {
  /** Milliseconds waited before reading anything back. */
  waitedMs: number
  /** The global block afterwards, or null if the board was not answering yet. */
  after: GlobalSettings | null
  /**
   * Fields that came back different from this firmware's defaults table. Empty
   * when `after` is null: nothing was compared, which is not the same as
   * everything matching.
   */
  unexpected: { field: string; wanted: number; got: number }[]
}

/** Where a reset has got to, for a caller that wants to say so. */
export type FactoryResetStage = 'sending' | 'waiting' | 'reading'

export interface TransactResult {
  request: Uint8Array
  reply?: Uint8Array
  ack: boolean
}

/**
 * Everything the engine can do for one board, whether or not the codec
 * interface exposes it.
 *
 * The extra members are the ones the diagnostic panels reach for — the raw
 * blob reads, the transaction helper — and the ones `tools/check` drives
 * against real hardware. They are on the object rather than module functions
 * so that "which board is this talking to" is never ambiguous.
 */
export interface ProtocolEngine {
  readonly spec: DeviceSpec
  transact(
    link: HidLink,
    command: number,
    opts?: {
      data?: ArrayLike<number>
      dataOffset?: number
      magic?: number
      timeoutMs?: number
      note?: string
    },
  ): Promise<TransactResult>
  readBlock(
    link: HidLink,
    command: number,
    totalBytes: number,
    opts?: { timeoutMs?: number; note?: string; baseOffset?: number },
  ): Promise<Uint8Array>
  readSlotMap(link: HidLink): Promise<{ map: SlotMap; blob?: Uint8Array }>
  readKeyPerfBlob(link: HidLink): Promise<Uint8Array>
  writeKeyPerfBlob(link: HidLink, blob: Uint8Array): Promise<void>
  readKeymapBlob(link: HidLink): Promise<Uint8Array>
  readKeymapLayerBlob(link: HidLink, layer: number): Promise<Uint8Array>
  writeKeymapLayerBlob(link: HidLink, layer: number, blob: Uint8Array): Promise<void>
  readKeyRgbBlob(link: HidLink): Promise<Uint8Array>
  writeKeyRgbBlob(link: HidLink, blob: Uint8Array): Promise<void>
  readAdvancedKeyBlobs(link: HidLink): Promise<AdvancedKeyBlobs>
  writeAdvancedKeyBlob(link: HidLink, block: AdvancedBlock, blob: Uint8Array): Promise<void>
  readMacroBlob(link: HidLink): Promise<Uint8Array>
  writeMacroBlob(link: HidLink, blob: Uint8Array, bytes?: number): Promise<void>
  readCalTable(link: HidLink): Promise<CalRecord[]>
  /**
   * Present only when the board's spec names an analog test-mode command.
   *
   * Gated rather than throwing, so `supports(codec, 'armAnalogStream')` is the
   * truth and a panel can offer the button or not, the way every other
   * capability works.
   */
  armAnalogStream?(link: HidLink, opts?: { keepAlive?: boolean }): Promise<() => Promise<void>>
  /** Decodes an analog event with this board's field layout. */
  parseEvent(payload: ArrayLike<number>): ReturnType<typeof parseKeyEvent>
  decodePerKey(blob: ArrayLike<number>, map: SlotMap): KeyConfig[]
  emptySlotsOf(blob: ArrayLike<number>): number[]
}

/** The codec, plus the engine internals the panels and the checks use. */
export type EngineCodec = KeyboardCodec & ProtocolEngine

/**
 * Builds a codec for one board.
 *
 * Nothing here touches the DOM or the active-device store, so a codec can be
 * built for a board that is not the one on screen — which is what
 * `tools/check` does, and what a second attached keyboard would need.
 */
export function createCodec(spec: DeviceSpec): EngineCodec {
  const frame = spec.frame
  const cmd = spec.commands
  const layout = layoutOf(spec.layout)
  const chunkBytes = blockChunkSize(frame)
  const perfBlobSize = keyPerfBlobSize(spec.keyPerf)
  const calBytes = spec.calibration.records * spec.calibration.recordSize
  const timeoutMs = spec.requestTimeoutMs

  /**
   * Sends one framed command and waits for the reply, mirroring what the stock
   * driver does: write 65 bytes, then read with a short timeout and check that
   * the first byte is 0xAA.
   */
  async function transact(
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
      magic: opts.magic ?? frame.magic,
      frame,
    })
    try {
      const { data } = await link.request(request, {
        reportId: frame.reportId,
        timeoutMs: opts.timeoutMs ?? timeoutMs,
        // Match the command back, not just "the next input report": the board
        // streams analog events unprompted once reporting has been enabled, and
        // one of those arriving mid-transaction would be read as the reply.
        match: (_id, d) => isReplyTo(command, d, frame),
        note: opts.note ?? `cmd 0x${command.toString(16).padStart(2, '0')}`,
      })
      return { request, reply: data, ack: isAck(data, frame) }
    } catch {
      return { request, ack: false }
    }
  }

  /**
   * Opens and closes the board's transaction around one job.
   *
   * A board whose spec has no `begin` / `end` skips them: they cost nothing on
   * a board that has them and cannot be invented for one that does not.
   */
  async function inTransaction<T>(link: HidLink, note: string, job: () => Promise<T>): Promise<T> {
    if (cmd.begin !== null) await transact(link, cmd.begin, { note: `${note}: begin` })
    try {
      return await job()
    } finally {
      // Closes the transaction even on a failed chunk: leaving one open is how
      // the next command ends up answering the wrong request.
      if (cmd.end !== null) await transact(link, cmd.end, { note: `${note}: end` })
    }
  }

  /**
   * Reads a firmware blob, one chunk per packet.
   *
   * The stock driver's read loops are all this shape: build a block header with
   * a length and an offset, send it through the second send-and-wait helper, and
   * copy payload[8..63] of the reply into its own cursor. It never trusts the
   * echoed offset, and neither does this — a firmware that pads or rounds the
   * header cannot shift the blob.
   *
   * The reply match is on `isReplyTo`, not "the next input report". With the
   * monitor running the board is streaming events, and the event marker is also
   * the per-key read command — matching loosely would splice an event into the
   * blob.
   */
  async function readBlock(
    link: HidLink,
    command: number,
    totalBytes: number,
    opts: { timeoutMs?: number; note?: string; baseOffset?: number } = {},
  ): Promise<Uint8Array> {
    const out = new Uint8Array(totalBytes)
    const plan = chunkPlan(totalBytes, chunkBytes)
    // Every read but one starts at 0. The keymap does not: its layers sit in
    // one block and a layer is a stride into it.
    const base = opts.baseOffset ?? 0
    const label = opts.note ?? `cmd 0x${command.toString(16).padStart(2, '0')}`
    for (const [i, chunk] of plan.entries()) {
      const request = buildBlock(command, base + chunk.offset, undefined, {
        length: chunk.length,
        frame,
      })
      let reply: Uint8Array
      try {
        const answer = await link.request(request, {
          reportId: frame.reportId,
          timeoutMs: opts.timeoutMs ?? timeoutMs,
          match: (_id, data) => isReplyTo(command, data, frame),
          note: `${label}: read ${chunk.length}B @ ${base + chunk.offset}`,
        })
        reply = answer.data
      } catch (e) {
        throw new Error(
          t('protocol.chunkTimeout', {
            label,
            index: i + 1,
            total: plan.length,
            offset: base + chunk.offset,
            reason: e instanceof Error ? e.message : String(e),
          }),
        )
      }
      out.set(blockReplyData(reply, chunk.length, frame), chunk.offset)
    }
    return out
  }

  /** Writes a blob back, chunk for chunk, checking each acknowledgement. */
  async function writeBlock(
    link: HidLink,
    command: number,
    blob: Uint8Array,
    opts: { baseOffset?: number; label: string },
  ): Promise<void> {
    const base = opts.baseOffset ?? 0
    const plan = chunkPlan(blob.length, chunkBytes)
    for (const [i, chunk] of plan.entries()) {
      const packet = buildBlock(
        command,
        base + chunk.offset,
        blob.subarray(chunk.offset, chunk.offset + chunk.length),
        { frame },
      )
      let reply: Uint8Array
      try {
        const answer = await link.request(packet, {
          reportId: frame.reportId,
          timeoutMs,
          match: (_id, data) => isReplyTo(command, data, frame),
          note: `${opts.label}: ${chunk.length}B @ ${base + chunk.offset}`,
        })
        reply = answer.data
      } catch (e) {
        throw new Error(
          t('protocol.chunkTimeout', {
            label: opts.label,
            index: i + 1,
            total: plan.length,
            offset: base + chunk.offset,
            reason: e instanceof Error ? e.message : String(e),
          }),
        )
      }
      if (!isAck(reply, frame)) {
        throw new Error(
          t('protocol.chunkNak', {
            index: i + 1,
            total: plan.length,
            offset: base + chunk.offset,
          }),
        )
      }
    }
  }

  /**
   * Sends a mode packet and waits for the board to acknowledge it.
   *
   * Not pedantry — both of these leave the board busy for far longer than a
   * write takes to return, and the link queue only holds a turn while an
   * exchange is outstanding. A capture measured it: the first 0xa8 took 15.9 ms
   * to acknowledge (its slot sweep) and 0xa9 took 34.5 ms (it writes the
   * calibration table to flash, §3.3). Both were followed by packets fired into
   * a board that had not answered yet — one of which, the calibration read, was
   * never answered at all.
   *
   * A missing acknowledgement is not fatal. Neither packet was waited on before
   * this, so a firmware that stays silent must keep working the way it did;
   * it costs the timeout once and is recorded in the log.
   */
  async function sendMode(link: HidLink, command: number, note: string): Promise<void> {
    try {
      await link.request(buildPacket(command, { frame }), {
        reportId: frame.reportId,
        timeoutMs: spec.monitor.ackMs,
        match: (_id, data) => isReplyTo(command, data, frame),
        note,
      })
    } catch (e) {
      link.log.note(
        t('protocol.modeNoAck', {
          command: `0x${command.toString(16)}`,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
    }
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
   * `monitor.rearmMs` the way the stock driver's calibration path does. Typing
   * stays suppressed and every key pressed to the bottom is recalibrated, so it
   * is opt-in and never the default.
   */
  async function armAnalogStream(
    link: HidLink,
    opts: { keepAlive?: boolean } = {},
  ): Promise<() => Promise<void>> {
    const arm = cmd.analogTestOn
    const disarm = cmd.analogTestOff
    if (arm === null) throw new Error(t('protocol.noAnalogMode', { board: spec.name }))

    await sendMode(link, arm, 'analog report on')

    if (!opts.keepAlive) {
      // Leave the mode at once. Reporting is already latched on.
      if (disarm !== null) await sendMode(link, disarm, 'leave test mode')
      return async () => {}
    }

    const timer = setInterval(() => {
      // A failed re-arm is not fatal: the device may have gone away, and the
      // disconnect path already tears the listener down.
      void sendMode(link, arm, 'calibration re-arm').catch(() => {})
    }, spec.monitor.rearmMs)

    let released = false
    const release = async () => {
      if (released) return
      released = true
      clearInterval(timer)
      window.removeEventListener('pagehide', onPageHide)
      try {
        if (disarm !== null) await sendMode(link, disarm, 'leave test mode')
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

  /**
   * The per-key performance blob, wrapped in the driver's transaction.
   *
   * The stock driver reads this on connect, on a profile switch and whenever the
   * board pushes an unsolicited 0xA2 report — not on entering its performance
   * tab, which only rewrites the global block. The values its tab shows were
   * already read and cached, which is why they appear instantly.
   */
  async function readKeyPerfBlob(link: HidLink): Promise<Uint8Array> {
    const command = needCommand(cmd.readKeyPerf, 'readKeyPerf')
    return inTransaction(link, 'key perf', () =>
      readBlock(link, command, perfBlobSize, { note: 'key perf' }),
    )
  }

  /**
   * Writes the performance blob back, one chunk per packet.
   *
   * The stock driver's write is job 0x0d at 0x42c390, and it is the read plan run
   * backwards: 0x01, then 19 chunks of 0xa1 at ascending offsets — eighteen of 56
   * bytes and a last one of 16 — then 0x02. Recovered instruction by instruction:
   * the chunk length is 0x38 with a `cmove` to 0x10 on the nineteenth
   * (0x42c73f), the offset is `i * 56` little-endian at payload[5..6]
   * (0x42c70f-0x42c735), and the data is four SSE moves of 16+16+16+8 bytes into
   * payload[8..63] (0x42c704-0x42c760).
   *
   * Every chunk is acknowledged, and a chunk that is not aborts the write. The
   * closing 0x02 still runs — leaving a transaction open is how the next command
   * ends up answering the wrong request.
   */
  async function writeKeyPerfBlob(link: HidLink, blob: Uint8Array): Promise<void> {
    const command = needCommand(cmd.writeKeyPerf, 'writeKeyPerf')
    if (blob.length !== perfBlobSize) {
      throw new Error(t('protocol.blobSize', { size: blob.length, expected: perfBlobSize }))
    }
    await inTransaction(link, 'key perf write', () =>
      writeBlock(link, command, blob, { label: 'key perf write' }),
    )
  }

  /**
   * The keymap block the slot mapping comes from — the *factory defaults* in
   * code flash, not the keymap the board is running.
   *
   * This is the block the stock driver caches at `this+0x8a4` and walks to build
   * its slot maps (0x427ac0 reads it, 0x426344 consumes it). For a slot map it
   * is the better of the two: remapping a key cannot move its slot. Reading the
   * live keymap is a separate job, and it is the one a remapping panel needs.
   */
  async function readKeymapBlob(link: HidLink): Promise<Uint8Array> {
    const command = needCommand(cmd.readKeymapDefaults, 'readKeymapDefaults')
    return inTransaction(link, 'keymap', () =>
      readBlock(link, command, spec.keymap.defaultsBlobSize, { note: 'keymap' }),
    )
  }

  /** Layers this board has storage for. Anything else is a caller's bug. */
  function assertLayer(layer: number): void {
    if (!Number.isInteger(layer) || layer < 0 || layer >= spec.keymap.layers) {
      throw new Error(t('protocol.keymapLayerRange', { layer, layers: spec.keymap.layers }))
    }
  }

  /**
   * One layer of the *live* keymap — the one the board is running.
   *
   * 512 bytes at `layer * 512` inside the 0x08 block, which is where the
   * firmware's own lookup reads it from (`0x20b00 + layer * 512 + slot * 3`, at
   * 0x885e) and where the stock driver's write puts it back.
   */
  async function readKeymapLayerBlob(link: HidLink, layer: number): Promise<Uint8Array> {
    const command = needCommand(cmd.readKeymapLive, 'readKeymapLive')
    assertLayer(layer)
    return inTransaction(link, `keymap layer ${layer}`, () =>
      readBlock(link, command, spec.keymap.layerBytes, {
        baseOffset: layer * spec.keymap.layerBytes,
        note: `keymap layer ${layer}`,
      }),
    )
  }

  /**
   * Puts one layer back, chunk for chunk as the stock driver does it.
   *
   * Job 7 at 0x427ac0 is the model: 0x01, then ten 0x09 chunks — nine of 56 bytes
   * and a last one of 8 — at `layer * 512 + i * 56`, then 0x02. The offset is
   * built at 0x427df0 as `[0x850] << 9` (the layer) plus `i * 56`, and the length
   * is 0x38 with a `cmove` to 8 on the tenth (0x427e1d).
   *
   * The whole layer goes out even when one record changed, which is what the
   * driver does. The difference is where the other records come from: the driver
   * rebuilds them from its database, and this sends back the bytes the board
   * itself just returned. See `writeKeymapLayer`.
   */
  async function writeKeymapLayerBlob(
    link: HidLink,
    layer: number,
    blob: Uint8Array,
  ): Promise<void> {
    const command = needCommand(cmd.writeKeymapLive, 'writeKeymapLive')
    assertLayer(layer)
    if (blob.length !== spec.keymap.layerBytes) {
      throw new Error(
        t('protocol.blobSize', { size: blob.length, expected: spec.keymap.layerBytes }),
      )
    }
    await inTransaction(link, `keymap write ${layer}`, () =>
      writeBlock(link, command, blob, {
        baseOffset: layer * spec.keymap.layerBytes,
        label: `keymap write ${layer}`,
      }),
    )
  }

  /**
   * The board's own calibration table — the records the firmware lights the key
   * LEDs from. See protocol/calibration.ts.
   *
   * A plain block read: the 0xaa handler at firmware 0x711c takes the same
   * length-and-offset header every other read command takes, with flash 0x20300
   * hard-wired as the base, so `readBlock` needs nothing special.
   *
   * No transaction around it. Those bracket writes; this reads a blob the
   * firmware maintains for itself, and there is no stock-driver call site to
   * copy since the stock driver never sends 0xaa at all.
   */
  async function readCalTable(link: HidLink): Promise<CalRecord[]> {
    const command = needCommand(cmd.readCalibration, 'readCalibration')
    const blob = await readBlock(link, command, calBytes, { note: 'calibration table' })
    return parseCalTable(blob, spec.calibration.records)
  }

  /**
   * Asks the board which key each slot is.
   *
   * Falls back to the layout-order guess if the keymap read fails or resolves too
   * few keys to be believable — a half-resolved map would put most keys in the
   * right place and a few in the wrong one, which is the hardest kind of wrong to
   * notice.
   */
  async function readSlotMap(link: HidLink): Promise<{ map: SlotMap; blob?: Uint8Array }> {
    const fallback = () => fallbackSlotMap(layout, spec.slotMap.unusedSlots)
    if (cmd.readKeymapDefaults === null) return { map: fallback() }
    try {
      const blob = await readKeymapBlob(link)
      const map = slotMapFromKeymap(blob, layout, spec.keymap)
      if (map.slotByKey.size >= layout.count - spec.slotMap.resolveTolerance) return { map, blob }
      link.log.note(
        t('protocol.slotMapPartial', { found: map.slotByKey.size, total: layout.count }),
      )
      return { map: fallback(), blob }
    } catch (e) {
      link.log.note(
        t('protocol.slotMapFailed', { reason: e instanceof Error ? e.message : String(e) }),
      )
      return { map: fallback() }
    }
  }

  /** Slots whose record is all zero. */
  function emptySlotsOf(blob: ArrayLike<number>): number[] {
    const out: number[] = []
    for (let slot = 0; slot < spec.keyPerf.slots; slot++) {
      if (isEmptySlot(blob, slot, spec.keyPerf)) out.push(slot)
    }
    return out
  }

  /**
   * Decodes the blob into this board's key order.
   *
   * A key the map has no slot for reads one slot past the end of the blob, which
   * decodes as zeros. That is deliberate: the alternative is a hole in the array,
   * and every caller would then need to handle it. The callers that care about
   * the difference check `slotByKey` instead.
   */
  function decodePerKey(blob: ArrayLike<number>, map: SlotMap): KeyConfig[] {
    return layout.keys.map((k) =>
      toKeyConfig(
        decodeKeyPerfRecord(blob, map.slotByKey.get(k.index) ?? spec.keyPerf.slots, spec.keyPerf),
        spec.keyPerf,
        spec.encoding.countsPerMm,
      ),
    )
  }

  /**
   * Reads the performance block and decodes it, keeping the bytes.
   *
   * Two reads: the keymap first, because it says which slot is which key, then
   * the performance block itself. Indexing it from the layout file was wrong
   * twice over — see keyPerf.ts and slotMap.ts.
   */
  async function readKeyPerfSnapshot(link: HidLink): Promise<KeyPerfSnapshot> {
    const { map, blob: keymap } = await readSlotMap(link)
    const blob = await readKeyPerfBlob(link)

    const emptySlots = emptySlotsOf(blob)
    const configs = decodePerKey(blob, map)

    const missing = layout.keys.filter((k) => map.slotByKey.get(k.index) === undefined)
    if (missing.length > 0) {
      link.log.note(
        t('protocol.keysWithoutSlot', {
          count: missing.length,
          keys: missing.map((k) => k.label).join(', '),
        }),
      )
    }
    const mappedEmpty = layout.keys.filter((k) => {
      const slot = map.slotByKey.get(k.index)
      return slot !== undefined && emptySlots.includes(slot)
    })
    if (mappedEmpty.length > 0) {
      // A zeroed record decodes to "actuation 0.02 mm, rapid trigger off, switch
      // type 0", which is plausible enough to pass for a real setting. Say so.
      link.log.note(
        t('protocol.emptySlots', {
          count: mappedEmpty.length,
          keys: mappedEmpty
            .map((k) =>
              t('protocol.emptySlotEntry', { key: k.label, slot: map.slotByKey.get(k.index)! }),
            )
            .join(', '),
        }),
      )
    }

    return { blob, keymap, slotMap: map, configs, emptySlots }
  }

  /**
   * Applies per-key settings to the board, and checks that they took.
   *
   * Read-modify-write, deliberately. The blob is wider than the keys this app
   * models — on the Raven61, 128 slots for 61 keys, with two of them holding
   * something that is not a key record at all — so building a blob from the
   * model would send zeros for all of it. Patching the blob the board just
   * returned touches only the slots the user changed.
   *
   * The verify read is not decoration. A write that is acknowledged and silently
   * ignored looks exactly like a write that worked, and the first cut of the read
   * path proved that a plausible-looking decode can be wrong in a way no amount
   * of staring at the UI reveals. So: write, read back, compare the bytes.
   */
  async function writeKeyPerfConfigs(
    link: HidLink,
    configs: readonly (KeyConfig | null)[],
  ): Promise<KeyPerfWriteResult> {
    const { map } = await readSlotMap(link)
    // A read may fall back to the layout-order guess and stay useful — the values
    // land on the wrong keys but nothing breaks. A write on that map would put
    // settings on the wrong keys of the actual board, and the guess is *known*
    // wrong: the row-per-actuation test showed the board groups slots quite
    // differently (see slotMap.ts). So this refuses rather than degrades.
    if (map.source !== 'keymap') throw new Error(t('protocol.writeNeedsKeymap'))

    const before = await readKeyPerfBlob(link)

    let next = before
    const keys: KeyPerfWriteResult['keys'] = []
    const unmapped: KeyPerfWriteResult['unmapped'] = []
    for (const key of layout.keys) {
      const config = configs[key.index]
      if (!config) continue
      const slot = map.slotByKey.get(key.index)
      if (slot === undefined) {
        unmapped.push({ index: key.index, label: key.label })
        continue
      }
      // The board's own record supplies switch_type and the three unknown bits of
      // rec[0]: this app sets neither, and must not overwrite them with zeros.
      next = patchSlot(
        next,
        slot,
        fromKeyConfig(
          config,
          decodeKeyPerfRecord(next, slot, spec.keyPerf),
          spec.keyPerf,
          spec.encoding.countsPerMm,
        ),
        spec.keyPerf,
      )
      keys.push({ index: key.index, label: key.label, slot })
    }

    const slots = changedSlots(before, next, spec.keyPerf)
    if (slots.length === 0) {
      // Nothing to send. Reporting that is better than a write that does nothing
      // and still says "applied".
      return {
        slots,
        keys,
        unmapped,
        before,
        after: before,
        mismatched: [],
        configs: decodePerKey(before, map),
      }
    }

    await writeKeyPerfBlob(link, next)
    const after = await readKeyPerfBlob(link)
    const mismatched = changedSlots(next, after, spec.keyPerf).map((slot) => ({
      slot,
      wanted: recordHex(next, slot, spec.keyPerf),
      got: recordHex(after, slot, spec.keyPerf),
    }))
    return { slots, keys, unmapped, before, after, mismatched, configs: decodePerKey(after, map) }
  }

  /**
   * Decodes one layer into this board's key order.
   *
   * Two reads, like the performance path: the factory keymap first because it is
   * what says which slot is which key, then the live layer that holds the
   * bindings. A key the slot map has no slot for comes back with `slot`
   * undefined — its binding is unknown rather than empty, and the panel says so
   * instead of drawing a blank cap.
   */
  async function readKeymapLayer(link: HidLink, layer: number): Promise<KeymapEntry[]> {
    const { map } = await readSlotMap(link)
    // The performance read degrades to the layout-order guess and stays useful
    // because its panel labels the mapping as guessed. This one has nowhere to
    // put that label: every cap would show some other key's binding, and an edit
    // made from that view would rebind a key the user never looked at.
    if (map.source !== 'keymap') throw new Error(t('protocol.keymapNeedsSlotMap'))
    const blob = await readKeymapLayerBlob(link, layer)
    return layout.keys.map((k) => {
      const slot = map.slotByKey.get(k.index)
      if (slot === undefined) return { binding: { kind: 'none', raw: 0 } as KeyBinding }
      return { slot, binding: decodeRecord(blob, slot * spec.keymap.entrySize) }
    })
  }

  /**
   * What the factory keymap has for each key of one layer — what "reset this
   * key" puts back.
   *
   * The read is the stock driver's own: 768 bytes of 0x07, the length job 7 asks
   * for at 0x427b70. That covers layer 0 whole and layer 1 as far as slot 85,
   * because a layer's stride is 512 while its records only fill 384. Slots past
   * the end come back `null` rather than as a zero record — a keymap this app did
   * not read is not a keymap of zeros.
   */
  async function readKeymapDefaultsLayer(
    link: HidLink,
    layer: number,
  ): Promise<(KeymapEntry | null)[]> {
    assertLayer(layer)
    const { map } = await readSlotMap(link)
    if (map.source !== 'keymap') throw new Error(t('protocol.keymapNeedsSlotMap'))
    const blob = await readKeymapBlob(link)
    const base = layer * spec.keymap.layerBytes
    return layout.keys.map((k) => {
      const slot = map.slotByKey.get(k.index)
      if (slot === undefined) return null
      const at = base + slot * spec.keymap.entrySize
      if (at + spec.keymap.entrySize > blob.length) return null
      return { slot, binding: decodeRecord(blob, at) }
    })
  }

  function recordAt(blob: ArrayLike<number>, slot: number): string {
    const at = slot * spec.keymap.entrySize
    const bytes: number[] = []
    for (let i = 0; i < spec.keymap.entrySize; i++) bytes.push(blob[at + i] ?? 0)
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
  }

  function changedKeymapSlots(before: ArrayLike<number>, after: ArrayLike<number>): number[] {
    const out: number[] = []
    for (let slot = 0; slot < spec.keymap.slots; slot++) {
      const at = slot * spec.keymap.entrySize
      for (let i = 0; i < spec.keymap.entrySize; i++) {
        if ((before[at + i] ?? 0) !== (after[at + i] ?? 0)) {
          out.push(slot)
          break
        }
      }
    }
    return out
  }

  /**
   * Rebinds keys of one layer, and checks that the write took.
   *
   * Read-modify-write, for the same reason the performance write is: the layer
   * is wider than this board's keys, and the rest holds whatever the firmware
   * put there. Building it from this app's model would zero all of it —
   * including slot 0's type byte, which the boot check at 0xa7ae reads to decide
   * whether the keymap is intact.
   *
   * The verify read is not decoration. An acknowledged write the firmware
   * ignored looks exactly like one that worked; the only way to tell is to read
   * the bytes back.
   */
  async function writeKeymapLayer(
    link: HidLink,
    layer: number,
    entries: readonly (KeymapEntry | null)[],
  ): Promise<KeymapWriteResult> {
    assertLayer(layer)
    const { map } = await readSlotMap(link)
    // A read can fall back to the layout-order guess and stay useful. A write on
    // that guess would rebind the wrong keys of the actual board, and the guess
    // is known wrong — see slotMap.ts.
    if (map.source !== 'keymap') throw new Error(t('protocol.writeNeedsKeymap'))

    const before = await readKeymapLayerBlob(link, layer)
    const next = new Uint8Array(before)
    const keys: KeymapWriteResult['keys'] = []
    const unmapped: KeymapWriteResult['unmapped'] = []
    for (const key of layout.keys) {
      const entry = entries[key.index]
      if (!entry) continue
      // The two layer-latch actions are refused here rather than only left out of
      // the picker: this is the last place a record can be stopped before it
      // reaches flash, and 0x05 makes the board read its RGB blob as a keymap.
      if (isUnsafe(entry.binding)) throw new Error(t('protocol.keymapUnsafe', { key: key.label }))
      const slot = map.slotByKey.get(key.index)
      if (slot === undefined) {
        unmapped.push({ index: key.index, label: key.label })
        continue
      }
      next.set(encodeRecord(entry.binding), slot * spec.keymap.entrySize)
      keys.push({ index: key.index, label: key.label, slot })
    }

    const slots = changedKeymapSlots(before, next)
    if (slots.length === 0) {
      // Nothing to send. Saying so beats a write that does nothing and still
      // reports success.
      return { layer, slots, keys, unmapped, before, after: before, mismatched: [] }
    }

    await writeKeymapLayerBlob(link, layer, next)
    const after = await readKeymapLayerBlob(link, layer)
    const mismatched = changedKeymapSlots(next, after).map((slot) => ({
      slot,
      wanted: recordAt(next, slot),
      got: recordAt(after, slot),
    }))
    return { layer, slots, keys, unmapped, before, after, mismatched }
  }

  // --- advanced keys -------------------------------------------------------

  /** Command byte for one table's read, or null when the spec names none. */
  function advancedRead(block: AdvancedBlock): number | null {
    if (block === 'dks') return cmd.readAdvancedDks
    if (block === 'pair') return cmd.readAdvancedPair
    return cmd.readAdvancedToggle
  }

  function advancedWrite(block: AdvancedBlock): number | null {
    if (block === 'dks') return cmd.writeAdvancedDks
    if (block === 'pair') return cmd.writeAdvancedPair
    return cmd.writeAdvancedToggle
  }

  /**
   * All three advanced-key tables, in one transaction.
   *
   * One transaction rather than three because that is what the stock driver
   * does and because the three are one setting: a record number without its
   * kind's table is not a readable advanced key.
   */
  async function readAdvancedKeyBlobs(link: HidLink): Promise<AdvancedKeyBlobs> {
    const reads: [AdvancedBlock, number][] = (['dks', 'pair', 'toggle'] as const).map((block) => [
      block,
      needCommand(advancedRead(block), `readAdvanced${block}`),
    ])
    return inTransaction(link, 'advanced keys', async () => {
      const out: Partial<AdvancedKeyBlobs> = {}
      for (const [block, command] of reads) {
        out[block] = await readBlock(link, command, advancedBlobSize(block, spec.advancedKeys), {
          note: `advanced ${block}`,
        })
      }
      return out as AdvancedKeyBlobs
    })
  }

  /** Puts one table back. The firmware's handler caps the transfer at its size. */
  async function writeAdvancedKeyBlob(
    link: HidLink,
    block: AdvancedBlock,
    blob: Uint8Array,
  ): Promise<void> {
    const command = needCommand(advancedWrite(block), `writeAdvanced${block}`)
    const expected = advancedBlobSize(block, spec.advancedKeys)
    if (blob.length !== expected) {
      throw new Error(t('protocol.blobSize', { size: blob.length, expected }))
    }
    await inTransaction(link, `advanced ${block} write`, () =>
      writeBlock(link, command, blob, { label: `advanced ${block} write` }),
    )
  }

  /**
   * The tables, plus every keymap entry across the readable layers that names
   * one of their records.
   *
   * The keymap sweep is not optional decoration. A record carries parameters
   * and nothing else — not the kind, not the key — so without it the app would
   * have 42 rows of bytes it cannot even name.
   */
  async function readAdvancedKeys(link: HidLink): Promise<AdvancedKeySnapshot> {
    const { map } = await readSlotMap(link)
    const blobs = await readAdvancedKeyBlobs(link)
    const uses: AdvancedKeyUse[] = []
    const claimed = new Set<number>()
    for (let layer = 0; layer < spec.keymap.layers; layer++) {
      const blob = await readKeymapLayerBlob(link, layer)
      for (let slot = 0; slot < spec.keymap.slots; slot++) {
        const binding = decodeRecord(blob, slot * spec.keymap.entrySize)
        if (binding.kind !== 'advanced') continue
        const kind = kindOfType(binding.type)
        // `decodeRecord` only calls a record advanced for the six known types,
        // so this cannot miss — the guard is here because the two tables are
        // maintained separately and a seventh type would land silently.
        if (!kind) continue
        claimed.add(binding.record)
        const key = map.keyBySlot.get(slot)
        uses.push({
          layer,
          index: key?.index ?? -1,
          label: key?.label ?? '',
          slot,
          kind,
          record: binding.record,
          param: binding.param,
        })
      }
    }
    const orphans: number[] = []
    for (let record = 0; record < spec.advancedKeys.records; record++) {
      if (!claimed.has(record) && !isFreeRecord(blobs, record)) orphans.push(record)
    }
    return { blobs, slotMap: map, uses, orphans }
  }

  /**
   * Writes one record, and reads the table back to check it.
   *
   * Read-modify-write over the table the record's kind uses: 41 other records
   * live in it, and two of them are the spares past the stock driver's limit.
   * The verify read is the same rule as everywhere else here — an acknowledged
   * write the firmware ignored reads exactly like one that worked.
   */
  async function writeAdvancedKey(
    link: HidLink,
    record: number,
    rec: AdvancedRecord,
  ): Promise<AdvancedKeyWriteResult> {
    const kind: AdvancedKind = rec.kind
    const block = ADVANCED_BLOCK_OF[kind]
    if (record < 0 || record >= spec.advancedKeys.records) {
      throw new Error(t('protocol.advancedRecordRange', { record, max: spec.advancedKeys.records }))
    }
    const before = (await readAdvancedKeyBlobs(link))[block]
    const size = ADVANCED_KEY_BLOCKS[block].recordSize
    const at = record * size
    const wanted = encodeAdvancedRecord(rec)
    let same = true
    for (let i = 0; i < size; i++) if ((before[at + i] ?? 0) !== wanted[i]) same = false
    if (same) {
      return { record, kind, block, sent: false, before, after: before, mismatch: null }
    }

    const next = new Uint8Array(before)
    next.set(wanted, at)
    await writeAdvancedKeyBlob(link, block, next)
    const after = (await readAdvancedKeyBlobs(link))[block]
    let ok = true
    for (let i = 0; i < size; i++) if ((after[at + i] ?? 0) !== wanted[i]) ok = false
    return {
      record,
      kind,
      block,
      sent: true,
      before,
      after,
      mismatch: ok
        ? null
        : {
            wanted: advancedRecordHex(next, record, kind),
            got: advancedRecordHex(after, record, kind),
          },
    }
  }

  /** Puts whole tables back — the undo for the write above. */
  async function restoreAdvancedKeys(link: HidLink, blobs: AdvancedKeyBlobs): Promise<void> {
    for (const block of ['dks', 'pair', 'toggle'] as const) {
      await writeAdvancedKeyBlob(link, block, blobs[block])
    }
  }

  // --- macros --------------------------------------------------------------

  /**
   * The macro store — 4 KB at flash 0x21100, read whole.
   *
   * Whole rather than "the table plus the bodies it points at", even though a
   * two-pass read would be shorter. The offsets are the only index into the
   * region and a store this app did not write can put a body anywhere in it, so
   * a read that trusted the table would decode bodies it had not fetched. 4 KB
   * is 74 packets and the tab reads once when it opens.
   */
  async function readMacroBlob(link: HidLink): Promise<Uint8Array> {
    const command = needCommand(cmd.readMacros, 'readMacros')
    return inTransaction(link, 'macros', () =>
      readBlock(link, command, macroBlobSize(spec.macros), { note: 'macros' }),
    )
  }

  /**
   * Puts the store back.
   *
   * `bytes` is how much of the blob to send, defaulting to all of it. The
   * caller passes the shorter figure `macroWriteBytes` computes — the offset
   * table plus the bodies — because the rest is zeros the board already holds
   * and every 56 of them is another packet. It is always a prefix, so the
   * offset table can never be sent without the bodies it points at.
   *
   * The firmware's handler (0x6bd6) bounds `offset + length` against 4096, so a
   * blob longer than the block is refused there; this refuses it here, where
   * the number can be named.
   */
  async function writeMacroBlob(link: HidLink, blob: Uint8Array, bytes?: number): Promise<void> {
    const command = needCommand(cmd.writeMacros, 'writeMacros')
    const expected = macroBlobSize(spec.macros)
    if (blob.length !== expected) {
      throw new Error(t('protocol.blobSize', { size: blob.length, expected }))
    }
    const length = Math.min(bytes ?? expected, expected)
    await inTransaction(link, 'macro write', () =>
      writeBlock(link, command, blob.subarray(0, length), { label: 'macro write' }),
    )
  }

  /**
   * The store, plus every keymap entry across the readable layers that starts a
   * macro.
   *
   * The keymap sweep is the same necessity it is for advanced keys: a body says
   * what it types and nothing about which key runs it. Here it carries a second
   * weight — a bound macro key on a board whose store is not canonical is a key
   * that types whatever lies past the end of the region, so a panel needs to
   * know both facts at once to say anything true about it.
   */
  async function readMacros(link: HidLink): Promise<MacroSnapshot> {
    const { map } = await readSlotMap(link)
    const blob = await readMacroBlob(link)
    const macros = decodeMacros(blob, spec.macros)
    const uses: MacroUse[] = []
    for (let layer = 0; layer < spec.keymap.layers; layer++) {
      const layerBlob = await readKeymapLayerBlob(link, layer)
      for (let slot = 0; slot < spec.keymap.slots; slot++) {
        const binding = decodeRecord(layerBlob, slot * spec.keymap.entrySize)
        if (binding.kind !== 'macro') continue
        const key = map.keyBySlot.get(slot)
        uses.push({
          layer,
          index: key?.index ?? -1,
          label: key?.label ?? '',
          slot,
          macro: binding.slot,
          repeat: binding.repeat,
        })
      }
    }
    return {
      blob,
      macros,
      slotMap: map,
      uses,
      canonical: isCanonical(blob, spec.macros),
      malformed: malformedSlots(macros),
    }
  }

  /**
   * Writes the whole store, and reads it back to check it.
   *
   * There is no per-slot write and there is not meant to be. `encodeMacros`
   * rebuilds the offset table and terminates every body, which is what makes
   * the store safe to bind a key to at all — an in-place edit of one body would
   * leave the other 31 offsets exactly as unsafe as it found them.
   *
   * Read-modify-write still applies, and this is where it lands: the caller
   * passes the macros it got from `readMacros`, so bodies it did not edit go
   * back as they were read, unknown kind nibbles included.
   */
  async function writeMacros(link: HidLink, macros: readonly Macro[]): Promise<MacroWriteResult> {
    const before = await readMacroBlob(link)
    const held = decodeMacros(before, spec.macros)
    const wanted = encodeMacros(macros, spec.macros)

    const changed: number[] = []
    for (let slot = 0; slot < spec.macros.slots; slot++) {
      const was = held[slot]
      const now = macros[slot]
      if (!now) continue
      // A slot the board never programmed counts as changed even when both
      // hold no events: the point of the write is the offset and the stop
      // record, and "no events either way" is exactly the state that hides it.
      if (!was || !was.programmed || !was.terminated || !sameMacro(was, now)) changed.push(slot)
    }
    if (changed.length === 0) {
      return { sent: false, bytes: 0, changed, before, after: before, mismatch: [] }
    }

    const bytes = macroWriteBytes(macros, spec.macros)
    await writeMacroBlob(link, wanted, bytes)
    const after = await readMacroBlob(link)
    const read = decodeMacros(after, spec.macros)
    const mismatch: { slot: number; wanted: string; got: string }[] = []
    for (let slot = 0; slot < spec.macros.slots; slot++) {
      const want = macros[slot]
      const got = read[slot]
      if (!want) continue
      if (got && got.programmed && got.terminated && sameMacro(want, got)) continue
      mismatch.push({
        slot,
        wanted: macroBodyHex(want),
        got: got ? macroBodyHex(got) : '—',
      })
    }
    return { sent: true, bytes, changed, before, after, mismatch }
  }

  /** Puts a whole store back, byte for byte — the undo for the write above. */
  async function restoreMacros(link: HidLink, blob: Uint8Array): Promise<void> {
    await writeMacroBlob(link, blob)
  }

  // --- per-key colour ------------------------------------------------------

  /**
   * The stored per-key colour block — 384 bytes at flash 0x20f00.
   *
   * A plain block read, wrapped in the driver's transaction the way every other
   * block read is. The stock driver reads it on connect and on a profile
   * switch; nothing about it needs a mode or a preceding write.
   */
  async function readKeyRgbBlob(link: HidLink): Promise<Uint8Array> {
    const command = needCommand(cmd.readKeyRgb, 'readKeyRgb')
    return inTransaction(link, 'key rgb', () =>
      readBlock(link, command, keyRgbBlobSize(spec.keyRgb), { note: 'key rgb' }),
    )
  }

  /**
   * Puts the block back, chunk for chunk — six of 56 bytes and a last of 48.
   *
   * The whole block goes out even when one record changed, which is what the
   * block protocol offers: the transfer is addressed by offset into the blob,
   * and the firmware's write handler caps it at 0x180. What keeps that from
   * being destructive is where the other records come from — see
   * `writeKeyColors`, which patches the bytes the board itself just returned.
   */
  async function writeKeyRgbBlob(link: HidLink, blob: Uint8Array): Promise<void> {
    const command = needCommand(cmd.writeKeyRgb, 'writeKeyRgb')
    const expected = keyRgbBlobSize(spec.keyRgb)
    if (blob.length !== expected) {
      throw new Error(t('protocol.blobSize', { size: blob.length, expected }))
    }
    await inTransaction(link, 'key rgb write', () =>
      writeBlock(link, command, blob, { label: 'key rgb write' }),
    )
  }

  /**
   * Decodes a colour block against a slot map, in this project's key order.
   *
   * Takes only the half of a slot map it uses, so a caller that already holds
   * one — a panel with a snapshot, a watcher that read the map once — can
   * decode a fresh blob without asking the board who is in which slot again.
   */
  function decodeKeyColors(
    blob: ArrayLike<number>,
    map: { slotByKey: Map<number, number> },
  ): KeyRgbEntry[] {
    return layout.keys.map((key) => {
      const slot = map.slotByKey.get(key.index)
      // A key with no slot gets no colour rather than slot 0's: the block is
      // addressed by slot, and guessing one is how settings land on the wrong
      // key. The panel shows those keys as unmapped.
      if (slot === undefined) return { color: { r: 0, g: 0, b: 0 } }
      return { slot, color: decodeKeyRgb(blob, slot, spec.keyRgb) }
    })
  }

  /**
   * The stored custom colours, decoded and raw.
   *
   * `live: false` is the whole point of the field. This is the layer a write
   * goes to; what the LEDs are showing is `readLightFrame`, and on a board
   * running an effect the two do not agree — nor should they.
   */
  async function readKeyColors(link: HidLink): Promise<KeyRgbSnapshot> {
    const { map } = await readSlotMap(link)
    const blob = await readKeyRgbBlob(link)
    return { blob, slotMap: map, entries: decodeKeyColors(blob, map), live: false }
  }

  /**
   * The LED frame the board is displaying right now — RAM, not flash.
   *
   * 0xde reads the buffer the effect engine has just filled, one stage before
   * the one 0xdd writes, so it includes whatever animation is running and the
   * firmware's own calibration overlay (docs §3.3: an uncalibrated key is
   * painted red or amber over everything else). That makes it the only way to
   * answer "is my colour actually on the keyboard", and a poor way to answer
   * "what did I save" — which is why it is a separate method rather than a
   * flag on the read above.
   *
   * No transaction: it reads a buffer the firmware maintains for itself, and
   * there is no stock-driver write for it to bracket.
   */
  async function readLightFrame(link: HidLink): Promise<KeyRgbSnapshot> {
    const command = needCommand(cmd.readLightFrame, 'readLightFrame')
    const { map } = await readSlotMap(link)
    const blob = await readBlock(link, command, keyRgbBlobSize(spec.keyRgb), {
      note: 'led frame',
    })
    return { blob, slotMap: map, entries: decodeKeyColors(blob, map), live: true }
  }

  /**
   * Keeps reading that frame, so a panel can show which keys are lit *now*.
   *
   * This is what the stock driver does, and it is the reason a capture of this
   * app once contained 62 replies to a command it never sends: the driver's
   * worker thread, whenever its job queue is empty, alternates the event poll
   * at 0x42c8a0 with a frame read at 0x428c20 (docs §3.0). There is no timer
   * behind it — it simply reads the frame every time it has nothing else to do.
   *
   * Three things this does that a naive `setInterval` around `readLightFrame`
   * would not:
   *
   *   - **The slot map is read once.** It is the expensive half — a 768-byte
   *     keymap block and a transaction around it, against 384 bytes for the
   *     frame — and it cannot change while the board stays plugged in. Reading
   *     it per frame would triple the traffic to learn nothing.
   *   - **One read at a time.** A frame is seven packets, and two overlapping
   *     reads would interleave their chunks: `readBlock` does not trust the
   *     echoed offset, so it would file the other read's chunks at its own
   *     cursor. The next read is scheduled after the previous one lands, not on
   *     a fixed beat, so a slow board slows the poll instead of stacking it.
   *   - **It stops on failure.** A board that has stopped answering must not be
   *     asked ten times a second forever; the caller is told once and offers a
   *     retry. Nothing here retries by itself.
   */
  function watchLightFrame(
    link: HidLink,
    onFrame: (snapshot: KeyRgbSnapshot) => void,
    opts: { intervalMs?: number; onError?: (message: string) => void } = {},
  ): Promise<() => void> {
    const command = needCommand(cmd.readLightFrame, 'readLightFrame')
    const interval = opts.intervalMs ?? spec.keyRgb.framePollMs
    const bytes = keyRgbBlobSize(spec.keyRgb)

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('pagehide', stop)
    }
    // A reload unloads the page without unmounting anything. Nothing is written
    // here, so this only stops the traffic — but a poll that outlives its panel
    // is a poll nobody can turn off.
    window.addEventListener('pagehide', stop)

    /*
     * The map is read before the first frame rather than alongside it, so the
     * cost and the one thing that can go wrong with it land once, at the point
     * the watch is started.
     *
     * `readSlotMap` falls back to the layout-order guess rather than failing, so
     * a board whose keymap cannot be read still gets a watch — the colours land
     * on the wrong caps and `slotMap.source` says `fallback`, which is a view
     * the UI can label. That is the difference between this and a write: a
     * wrong-looking read is recoverable by reading again, and a write on a
     * guessed map is not.
     */
    return readSlotMap(link).then(({ map }) => {
      const tick = async () => {
        if (stopped) return
        try {
          const blob = await readBlock(link, command, bytes, { note: 'led frame' })
          if (stopped) return
          onFrame({ blob, slotMap: map, entries: decodeKeyColors(blob, map), live: true })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          stop()
          opts.onError?.(message)
          return
        }
        if (!stopped) timer = setTimeout(() => void tick(), interval)
      }
      void tick()
      return stop
    })
  }

  /**
   * Sets the custom colour of named keys, and checks that it took.
   *
   * Read-modify-write, for the reason every block write here is: 128 slots for
   * 61 keys, and the rest of the block holds whatever the firmware put there.
   * A blob built from this app's model would zero all of it — and this is the
   * block a stray write has already damaged once, when an early probe sweep
   * landed in the lighting area and left the board's LEDs stuck until the stock
   * driver reapplied a profile (findings.md #4). So: patch the bytes the board
   * just returned, send, read back, compare.
   *
   * `null` for a key leaves that key alone. Three zero bytes is not "leave
   * alone" — it is the board's own way of saying *no custom colour*, so it is a
   * value a caller can deliberately write to clear a key.
   */
  async function writeKeyColors(
    link: HidLink,
    colors: readonly (Rgb | null)[],
  ): Promise<KeyRgbWriteResult> {
    const { map } = await readSlotMap(link)
    // A read can fall back to the layout-order guess and stay useful — the
    // colours land on the wrong caps and nothing breaks. A write on that guess
    // would paint the wrong keys of the actual board, and the guess is known
    // wrong (see slotMap.ts). So this refuses rather than degrades.
    if (map.source !== 'keymap') throw new Error(t('protocol.writeNeedsKeymap'))

    const before = await readKeyRgbBlob(link)
    const next = new Uint8Array(before)
    const keys: KeyRgbWriteResult['keys'] = []
    const unmapped: KeyRgbWriteResult['unmapped'] = []
    for (const key of layout.keys) {
      const color = colors[key.index]
      if (!color) continue
      const slot = map.slotByKey.get(key.index)
      if (slot === undefined) {
        unmapped.push({ index: key.index, label: key.label })
        continue
      }
      encodeKeyRgb(next, slot, color, spec.keyRgb)
      keys.push({ index: key.index, label: key.label, slot })
    }

    const slots = changedRgbSlots(before, next, spec.keyRgb)
    if (slots.length === 0) {
      // Nothing to send. Saying so beats a write that does nothing and still
      // reports success.
      return { slots, keys, unmapped, before, after: before, mismatched: [] }
    }

    await writeKeyRgbBlob(link, next)
    const after = await readKeyRgbBlob(link)
    const mismatched = changedRgbSlots(next, after, spec.keyRgb).map((slot) => ({
      slot,
      wanted: rgbRecordHex(next, slot, spec.keyRgb),
      got: rgbRecordHex(after, slot, spec.keyRgb),
    }))
    return { slots, keys, unmapped, before, after, mismatched }
  }

  /**
   * Asks the board which firmware it is running.
   *
   * A single packet with no data — the handler ignores every request field and
   * fills in the length itself. Wrapped in the driver's transaction anyway, since
   * every other read on this board is, and 0x01 / 0x02 cost nothing.
   */
  async function readFirmware(link: HidLink): Promise<FirmwareIdentity> {
    const command = needCommand(cmd.readFirmware, 'readFirmware')
    return inTransaction(link, 'firmware', async () => {
      const { data } = await link.request(buildPacket(command, { frame }), {
        reportId: frame.reportId,
        timeoutMs,
        match: (_id, d) => isReplyTo(command, d, frame),
        note: 'read firmware identity',
      })
      const identity = decodeFirmwareIdentity(
        blockReplyData(data, blockReplyHeader(data, frame).length, frame),
      )
      if (identity.raw === '') throw new Error(t('protocol.firmwareEmpty'))
      return identity
    })
  }

  /**
   * The bare global-settings read, with no transaction of its own.
   *
   * Single chunk, so it does not go through `readBlock`: keeping the whole reply
   * payload lets the panel show the raw bytes next to the decoded ones — and
   * lets a write build its request out of it.
   */
  async function readGlobalBlock(link: HidLink): Promise<GlobalSettings> {
    const command = needCommand(cmd.readGlobalSettings, 'readGlobalSettings')
    const request = buildBlock(command, 0, undefined, { length: spec.global.length, frame })
    const { data } = await link.request(request, {
      reportId: frame.reportId,
      timeoutMs,
      match: (_id, d) => isReplyTo(command, d, frame),
      note: 'read global settings',
    })
    return decodeGlobalSettings(data, spec.global)
  }

  /** The same read, wrapped in the driver's transaction. */
  async function readGlobalSettings(link: HidLink): Promise<GlobalSettings> {
    return inTransaction(link, 'global settings', () => readGlobalBlock(link))
  }

  /**
   * Changes global settings the way the stock driver does — by editing the block
   * it just read.
   *
   * This is not a design choice, it is what the binary does. Both `0x06` call
   * sites (`0x429560`, the performance tab; `0x428a30`, the general settings
   * page) run the same five steps:
   *
   *   1. `0x01`
   *   2. `0x05` with `payload[4] = 0x20`, through the read helper
   *   3. **copy the 65-byte reply into the write buffer** — four SSE moves at
   *      `0x42960a`-`0x42964d` — then overwrite `payload[0..1]` with `55 06` and
   *      edit only its own fields
   *   4. send, then `Sleep(400)` (`push 0x190` at `0x4299e9`)
   *   5. `0x02`
   *
   * An earlier note had it wrong. It said the two call sites write disjoint
   * ranges and leave the rest zero, and concluded the firmware must treat each
   * field independently. Neither call site ever sends a mostly-zero block, so
   * there was never any evidence for that — and `enableAnalogReport` was built on
   * it, which means it had been zeroing the report rate, the dead zone, the
   * game-lock bits and the lighting effect every time it ran.
   */
  async function writeGlobalSettings(
    link: HidLink,
    patch: GlobalPatch,
  ): Promise<GlobalWriteResult> {
    const command = needCommand(cmd.writeGlobalSettings, 'writeGlobalSettings')
    return inTransaction(link, 'global settings write', async () => {
      const before = await readGlobalBlock(link)
      const request = globalWriteRequest(before.raw, patch, {
        global: spec.global,
        frame,
        command,
      })
      // Nothing to do beyond the two header bytes means the patch is a no-op.
      if (sameGlobalData(request, before.raw, frame)) {
        return { before, after: before, mismatched: [], unchanged: true }
      }
      const { data } = await link.request(request, {
        reportId: frame.reportId,
        timeoutMs,
        match: (_id, d) => isReplyTo(command, d, frame),
        note: 'write global settings',
      })
      if (!isAck(data, frame)) throw new Error(t('protocol.globalNak'))
      await new Promise((r) => setTimeout(r, spec.global.settleMs))
      const after = await readGlobalBlock(link)
      const mismatched: GlobalWriteResult['mismatched'] = []
      // The patch, so the lighting bytes are verified when the patch named one
      // and left alone when it did not — see `writtenOffsets`.
      for (const offset of writtenOffsets(spec.global, patch)) {
        const wanted = request[offset] ?? 0
        const got = after.raw[offset] ?? 0
        if (wanted !== got) mismatched.push({ offset, wanted, got })
      }
      return { before, after, mismatched, unchanged: false }
    })
  }

  /**
   * Sends the reset, waits the driver's six seconds, and reads the block back.
   *
   * The ack is not evidence of anything beyond delivery — see
   * FACTORY_RESET_DEFAULTS — so the read afterwards is the only part that can
   * tell whether the board did it. A board that does not answer that read is
   * reported as unread rather than as failed: it may still be busy, and saying
   * "the reset failed" about a board that has just wiped itself would be the
   * worse of the two wrong answers.
   */
  async function factoryReset(
    link: HidLink,
    onStage?: (stage: FactoryResetStage) => void,
  ): Promise<FactoryResetResult> {
    const command = needCommand(cmd.factoryReset, 'factoryReset')
    onStage?.('sending')
    const sent = await transact(link, command, { note: 'factory reset' })
    if (!sent.ack) throw new Error(t('protocol.resetNak'))

    onStage?.('waiting')
    const waitedMs = spec.factoryReset.firstWaitMs + spec.factoryReset.secondWaitMs
    await new Promise((r) => setTimeout(r, spec.factoryReset.firstWaitMs))
    await new Promise((r) => setTimeout(r, spec.factoryReset.secondWaitMs))

    onStage?.('reading')
    let after: GlobalSettings | null = null
    try {
      after = await readGlobalBlock(link)
    } catch {
      // Still busy, or gone from the bus. Either way there is nothing to compare.
      return { waitedMs, after: null, unexpected: [] }
    }
    const defaults = spec.global.factoryDefaults
    // No defaults table for this board means nothing to check against, which is
    // not the same as everything matching — so the result says only what came
    // back.
    if (!defaults) return { waitedMs, after, unexpected: [] }
    const unexpected: FactoryResetResult['unexpected'] = []
    const check = (field: keyof typeof defaults, got: number) => {
      if (defaults[field] !== got) unexpected.push({ field, wanted: defaults[field], got })
    }
    check('reportRate', after.reportRate)
    check('tickRate', after.tickRate)
    check('deadZone', after.deadZone)
    check('flags', after.raw[spec.global.offsets.flags] ?? 0)
    /*
     * The lighting fields, from the same defaults table.
     *
     * `speedWire` is checked as stored rather than as the panel shows it: the
     * decode flips the byte, and a reset check should report the byte the
     * firmware wrote. `lightMode` is the field this used to check under the
     * name `sleepMinutes` — same offset, and it is an effect index.
     */
    const light = after.lighting
    if (light) {
      check('lightMode', light.mode)
      check('brightness', light.brightness)
      check('speedWire', after.raw[spec.global.offsets.speed ?? 0] ?? 0)
      check('colorful', light.colorful ? 1 : 0)
    }
    return { waitedMs, after, unexpected }
  }

  /** Reads the settings, then hands back only what the domain model carries. */
  async function readKeyConfigs(link: HidLink): Promise<KeyConfig[]> {
    return (await readKeyPerfSnapshot(link)).configs
  }

  /**
   * The plain write, for callers that only need "did it work". Throws when the
   * board did not read back what was written, so a failure cannot pass for
   * success — see `writeKeyPerfConfigs`.
   */
  async function writeKeyConfigs(
    link: HidLink,
    configs: readonly (KeyConfig | null)[],
  ): Promise<void> {
    const result = await writeKeyPerfConfigs(link, configs)
    if (result.unmapped.length > 0) {
      throw new Error(
        t('protocol.writeUnmapped', {
          count: result.unmapped.length,
          keys: result.unmapped.map((k) => k.label).join(', '),
        }),
      )
    }
    if (result.mismatched.length > 0) {
      throw new Error(
        t('protocol.writeMismatch', {
          count: result.mismatched.length,
          detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
        }),
      )
    }
  }

  function parseEvent(payload: ArrayLike<number>) {
    return parseKeyEvent(payload, spec.event, frame, spec.encoding.countsPerMm)
  }

  /**
   * Enables analog reporting and decodes what comes back.
   *
   * The board does *not* stream on its own — an earlier note in
   * docs/protocol.md §3.2 claiming otherwise was wrong, and only looked right
   * because the stock driver had already enabled it in the same session.
   */
  async function startMonitor(
    link: HidLink,
    onSample: (samples: KeySample[]) => void,
    opts: { arm?: boolean; keepAlive?: boolean } = {},
  ) {
    const off = link.onInput((_reportId, data) => {
      const event = parseEvent(data)
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
  }

  const has = (command: number | null) => command !== null

  const engine: ProtocolEngine = {
    spec,
    transact,
    readBlock,
    readSlotMap,
    readKeyPerfBlob,
    writeKeyPerfBlob,
    readKeymapBlob,
    readKeymapLayerBlob,
    writeKeymapLayerBlob,
    readKeyRgbBlob,
    writeKeyRgbBlob,
    readAdvancedKeyBlobs,
    writeAdvancedKeyBlob,
    readMacroBlob,
    writeMacroBlob,
    readCalTable,
    parseEvent,
    decodePerKey,
    emptySlotsOf,
  }

  return {
    ...engine,
    id: spec.id,
    name: spec.name,
    labelKey: spec.labelKey,
    notesKey: spec.notesKey,
    confidence: spec.confidence,
    notes: spec.notes,
    profileSupport: spec.profileSupport,

    async probe(link: HidLink) {
      const d = link.device
      if (!d) return false
      // Identification only — a probe runs on every connect and must not write.
      // Exact vendor *and* product. A near miss is not a match: one vendor
      // ships several boards, and answering an untested sibling with this
      // board's command bytes is the failure this refuses to have. An
      // unrecognised device falls through to `unknownCodec`, which implements
      // nothing.
      return d.vendorId === spec.usb.vendorId && spec.usb.productIds.includes(d.productId)
    },

    ...(has(cmd.readFirmware) && { readFirmware }),
    ...(has(cmd.readKeyPerf) && { readKeyPerf: readKeyPerfSnapshot, readKeyConfigs }),
    ...(has(cmd.readKeyPerf) && has(cmd.writeKeyPerf) && {
      writeKeyPerf: writeKeyPerfConfigs,
      writeKeyConfigs,
      restoreKeyPerf: writeKeyPerfBlob,
    }),
    ...(has(cmd.readGlobalSettings) && { readGlobalSettings }),
    ...(has(cmd.readGlobalSettings) && has(cmd.writeGlobalSettings) && { writeGlobalSettings }),
    ...(has(cmd.analogTestOn) && { startMonitor, armAnalogStream }),
    ...(has(cmd.readKeymapLive) && has(cmd.readKeymapDefaults) && { readKeymap: readKeymapLayer }),
    ...(has(cmd.writeKeymapLive) &&
      has(cmd.readKeymapLive) &&
      has(cmd.readKeymapDefaults) && { writeKeymap: writeKeymapLayer }),
    ...(has(cmd.readKeymapDefaults) && { readKeymapDefaults: readKeymapDefaultsLayer }),
    /*
     * The colour read needs the slot map, which comes from the keymap block —
     * so a board with no keymap command gets no colour panel either, rather
     * than one that paints slot 0 for every key.
     */
    ...(has(cmd.readKeyRgb) && has(cmd.readKeymapDefaults) && { readKeyColors }),
    ...(has(cmd.readKeyRgb) &&
      has(cmd.writeKeyRgb) &&
      has(cmd.readKeymapDefaults) && { writeKeyColors, restoreKeyRgb: writeKeyRgbBlob }),
    /*
     * The advanced-key read sweeps the keymap for the entries that name a
     * record, and needs the slot map to say which key each one is — so the same
     * rule as the colour read applies: no keymap commands, no advanced-key
     * panel, rather than a panel that reports records nothing can be traced to.
     */
    ...(has(cmd.readAdvancedDks) &&
      has(cmd.readAdvancedPair) &&
      has(cmd.readAdvancedToggle) &&
      has(cmd.readKeymapLive) &&
      has(cmd.readKeymapDefaults) && { readAdvancedKeys }),
    ...(has(cmd.readAdvancedDks) &&
      has(cmd.readAdvancedPair) &&
      has(cmd.readAdvancedToggle) &&
      has(cmd.writeAdvancedDks) &&
      has(cmd.writeAdvancedPair) &&
      has(cmd.writeAdvancedToggle) &&
      has(cmd.readKeymapLive) &&
      has(cmd.readKeymapDefaults) && { writeAdvancedKey, restoreAdvancedKeys }),
    /*
     * The macro read sweeps the keymap the same way, and for the same reason.
     * The write is gated on the *keymap* write as well as the store's own —
     * not because writing bodies needs it, but because a store nothing points
     * at does nothing, and a panel that could fill 32 slots and never bind one
     * of them would be a panel with no way to finish the job.
     */
    ...(has(cmd.readMacros) &&
      has(cmd.readKeymapLive) &&
      has(cmd.readKeymapDefaults) && { readMacros }),
    ...(has(cmd.readMacros) &&
      has(cmd.writeMacros) &&
      has(cmd.readKeymapLive) &&
      has(cmd.writeKeymapLive) &&
      has(cmd.readKeymapDefaults) && { writeMacros, restoreMacros }),
    ...(has(cmd.readLightFrame) &&
      has(cmd.readKeymapDefaults) && { readLightFrame, watchLightFrame }),
    ...(has(cmd.readCalibration) && { readCalibration: readCalTable }),
    ...(has(cmd.factoryReset) && { factoryReset }),
  }
}

/**
 * A command the caller needs but this board's spec does not name.
 *
 * Reached only through a method the codec should not have exposed in the first
 * place, so it is a programming error rather than a device problem — hence the
 * plain English and the developer-facing wording.
 */
function needCommand(command: number | null, name: string): number {
  if (command === null) {
    throw new Error(`this board's spec has no ${name} command, so it cannot be sent`)
  }
  return command
}

/**
 * Turns a firmware-identity reply's bytes into the three fields the firmware
 * joined with commas — see COMMAND.readFirmware.
 *
 * Anything that does not split into three parts is kept whole in `raw` and put
 * in `name`, rather than guessing which piece is missing. A board with a
 * different build would still be identified; only the split would be lost.
 */
export function decodeFirmwareIdentity(data: Uint8Array): FirmwareIdentity {
  // Trailing NULs are the firmware's string terminators, not content.
  const raw = new TextDecoder('ascii')
    .decode(data)
    .replace(/\0+$/, '')
    .trim()
  const parts = raw.split(',')
  if (parts.length < 3) return { raw, name: raw }
  return { raw, name: parts[0]!.trim(), buildDate: parts[1]!.trim(), buildTime: parts[2]!.trim() }
}
