/**
 * Reading a whole board into a document.
 *
 * ## Why this reads rather than copying what the stores hold
 *
 * The app's stores are what the last visit to a tab happened to read. A user
 * who has never opened the macro tab has no macros in them, and the lighting
 * half of the board-wide block is only there if the overview was visited. A
 * file built from that would be a profile with holes in it that look like
 * settings — "this board has no macros" where the truth is "nobody looked".
 *
 * So a save reads every block it can, in one pass, and the blocks it could not
 * read are *absent* from the document rather than defaulted.
 *
 * ## A failed block is left out, not fatal
 *
 * One block failing does not stop the rest. A board whose lighting command this
 * spec does not name is an ordinary board, and a read that times out once is an
 * ordinary read; either way what came back is worth saving. `CaptureResult.failed`
 * carries the names so the panel can say which, rather than the file quietly
 * being short.
 */

import type { KeyboardCodec } from '../protocol/codec'
import { supports } from '../protocol/codec'
import type { HidLink } from '../hid/link'
import type { DeviceSpec } from '../device/spec'
import type { GlobalPatch } from '../protocol/global'
import type { GlobalSettings } from '../protocol/types'
import { profileEnvelope } from './json'
import {
  PROFILE_BLOCKS,
  toBase64,
  type ProfileBlock,
  type ProfileDocument,
  type ProfileLayer,
} from './model'

export interface CaptureResult {
  doc: ProfileDocument
  /** Blocks the board would not give up, and why. */
  failed: { block: ProfileBlock; reason: string }[]
}

/** Where a capture has got to, for the progress line. */
export type CaptureStage = ProfileBlock | 'firmware'

/**
 * A stage about to start, and how much of the run is already behind it.
 *
 * `done` counts stages *finished*, so it is 0 while the first one is in flight
 * and `total - 1` while the last one is — a bar drawn from it fills as blocks
 * land rather than as they are announced, which is the only reading of it that
 * is never ahead of the board.
 *
 * The firmware line counts as a stage here even though it is not a block: it
 * is a read, it takes as long as any other, and a bar that stood still through
 * it would be a bar that stalls at the start of every save.
 */
export interface CaptureProgress {
  stage: CaptureStage
  done: number
  total: number
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Reads every block this codec offers.
 *
 * `onStage` is called before each one rather than after: the interesting
 * moment is the wait, and a label that appears once the wait is over labels
 * nothing.
 */
export async function captureProfile(
  link: HidLink,
  codec: KeyboardCodec,
  spec: DeviceSpec,
  onStage?: (progress: CaptureProgress) => void,
): Promise<CaptureResult> {
  const failed: CaptureResult['failed'] = []
  // Every block is announced whether or not this codec can read it, so the
  // total is the block list plus the firmware line when there is one.
  const total = PROFILE_BLOCKS.length + (supports(codec, 'readFirmware') ? 1 : 0)
  // `done++` after reading it: the count handed over is the number of stages
  // already behind this call, and this call is what marks the last one done.
  let done = 0
  const begin = (stage: CaptureStage) => onStage?.({ stage, done: done++, total })
  const doc = profileEnvelope({
    specId: spec.id,
    name: spec.name,
    vendorId: spec.usb.vendorId,
    productId: spec.usb.productIds[0] ?? 0,
    keyCount: spec.layout.keys.length,
  })

  if (supports(codec, 'readFirmware')) {
    begin('firmware')
    // No `failed` entry: the firmware line is a label on the file, not a block
    // anyone asked to save, and a board that will not name itself still has
    // every setting worth keeping.
    try {
      doc.device.firmware = (await codec.readFirmware!(link)).raw
    } catch {
      /* left unnamed */
    }
  }

  begin('keyPerf')
  try {
    if (supports(codec, 'readKeyPerf')) {
      doc.blocks.keyPerf = (await codec.readKeyPerf!(link)).configs
    } else if (supports(codec, 'readKeyConfigs')) {
      doc.blocks.keyPerf = await codec.readKeyConfigs!(link)
    }
  } catch (e) {
    failed.push({ block: 'keyPerf', reason: reason(e) })
  }

  begin('advancedKeys')
  try {
    if (supports(codec, 'readAdvancedKeys')) {
      const { blobs } = await codec.readAdvancedKeys!(link)
      // The bytes, not the decode — see the note in `model.ts`.
      doc.blocks.advancedKeys = {
        dks: toBase64(blobs.dks),
        pair: toBase64(blobs.pair),
        toggle: toBase64(blobs.toggle),
      }
    }
  } catch (e) {
    failed.push({ block: 'advancedKeys', reason: reason(e) })
  }

  begin('macros')
  try {
    if (supports(codec, 'readMacros')) {
      // `uses: false` — the sweep answers which keys start which body, which is
      // a fact about the keymap and is being saved as the keymap anyway. It is
      // two thirds of the packets for something this file does not hold.
      doc.blocks.macros = (await codec.readMacros!(link, { uses: false })).macros
    }
  } catch (e) {
    failed.push({ block: 'macros', reason: reason(e) })
  }

  begin('keymap')
  try {
    if (supports(codec, 'readKeymap')) {
      const layers: ProfileLayer[] = []
      for (let layer = 0; layer < spec.keymap.layers; layer++) {
        const entries = await codec.readKeymap!(link, layer)
        layers.push({ layer, entries: entries.map((e) => e.binding) })
      }
      doc.blocks.keymap = layers
    }
  } catch (e) {
    failed.push({ block: 'keymap', reason: reason(e) })
  }

  begin('keyRgb')
  try {
    if (supports(codec, 'readKeyColors')) {
      const snapshot = await codec.readKeyColors!(link)
      /*
       * A key whose slot the map could not resolve reads back as black, which
       * is indistinguishable from a key someone set to black. It is saved as
       * `null` — "leave this one alone" — because writing black over a colour
       * nobody read is the one outcome neither reading means.
       */
      doc.blocks.keyRgb = snapshot.entries.map((e) => (e.slot === undefined ? null : e.color))
    }
  } catch (e) {
    failed.push({ block: 'keyRgb', reason: reason(e) })
  }

  begin('global')
  try {
    if (supports(codec, 'readGlobalSettings')) {
      doc.blocks.global = globalToPatch(await codec.readGlobalSettings!(link))
    }
  } catch (e) {
    failed.push({ block: 'global', reason: reason(e) })
  }

  return { doc, failed }
}

/**
 * The board-wide block as the patch that would put it back.
 *
 * `GlobalSettings` also carries `raw`, `tickRate`, `deadZone` and the two
 * Win/Alt bits, none of which `writeGlobalSettings` takes. Saving them would be
 * saving something no write could restore, so what is kept is exactly the
 * writable set — see `GlobalPatch`.
 */
function globalToPatch(settings: GlobalSettings): GlobalPatch {
  const patch: GlobalPatch = {
    reportRate: settings.reportRate,
    debounceLevel: settings.debounceLevel,
    bottomOutTrigger: settings.bottomOutTrigger,
    actuationCheck: settings.actuationCheck,
    magnetTest: settings.magnetTest,
  }
  if (settings.lighting) {
    // `LightingSettings` is a read and `LightingPatch` is a write, and they are
    // not the same shape: `mode` is `lightMode` there, and `colorIndex` is an
    // undecoded byte the writer carries through from the block it read rather
    // than one a patch can name.
    patch.lighting = {
      lightMode: settings.lighting.mode,
      brightness: settings.lighting.brightness,
      speed: settings.lighting.speed,
      direction: settings.lighting.direction,
      colorful: settings.lighting.colorful,
      color: settings.lighting.color,
    }
  }
  return patch
}
