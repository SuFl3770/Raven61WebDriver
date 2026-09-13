/**
 * Putting a document back on a board, one block at a time.
 *
 * ## Why the blocks are written in the order `PROFILE_BLOCKS` gives
 *
 * `advancedKeys` and `macros` go before `keymap`, because a keymap entry can
 * name an advanced-key record or a macro slot. Written the other way round the
 * board spends the gap holding a pointer to something that is not there yet,
 * and for the macro store that is not merely untidy: the player has no bound on
 * its cursor, so a key bound to a slot with no body walks off the end of the
 * region emitting keystrokes (see `protocol/macros.ts`).
 *
 * `global` is last because its write is the one that can cost the connection —
 * a changed polling rate can take the WebHID handle with it — and everything
 * else should already be in when that happens.
 *
 * ## One block failing does not stop the others
 *
 * Each write is reported on its own. Stopping at the first failure would leave
 * the board in a state nobody chose *and* say less about it than carrying on
 * does: the user asked for these blocks, and the honest answer is which of them
 * landed.
 *
 * The exception is losing the board. A disconnect mid-apply ends the run,
 * because every write after it would fail the same way and a list of six
 * identical errors says nothing the first one did not.
 */

import type { KeyboardCodec } from '../protocol/codec'
import { supports, type Capability } from '../protocol/codec'
import type { HidLink } from '../hid/link'
import type { DeviceSpec } from '../device/spec'
import type { KeymapEntry } from '../protocol/types'
import { fromBase64, PROFILE_BLOCKS, type ProfileBlock, type ProfileDocument } from './model'

export interface BlockOutcome {
  block: ProfileBlock
  status: 'written' | 'skipped' | 'failed' | 'mismatch'
  /** The failure, or the verify's disagreement, in the board's own terms. */
  detail?: string
}

export interface ApplyResult {
  outcomes: BlockOutcome[]
  /** True when the run ended early because the board went away. */
  disconnected: boolean
}

/** Capabilities each block needs, so a skip can say what is missing. */
const NEEDS: Record<ProfileBlock, Capability> = {
  keyPerf: 'writeKeyPerf',
  advancedKeys: 'restoreAdvancedKeys',
  macros: 'writeMacros',
  keymap: 'writeKeymap',
  keyRgb: 'writeKeyColors',
  global: 'writeGlobalSettings',
}

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Writes the chosen blocks.
 *
 * `chosen` is what the dialog ticked, and this does not second-guess it — the
 * integrity check already refused anything that could not be written, and a
 * second opinion here would be a rule in two places.
 */
export async function applyProfile(
  link: HidLink,
  codec: KeyboardCodec,
  spec: DeviceSpec,
  doc: ProfileDocument,
  chosen: ReadonlySet<ProfileBlock>,
  onStage?: (block: ProfileBlock) => void,
): Promise<ApplyResult> {
  const outcomes: BlockOutcome[] = []
  let disconnected = false

  for (const block of PROFILE_BLOCKS) {
    if (!chosen.has(block)) continue
    if (!link.connected) {
      disconnected = true
      break
    }
    if (!supports(codec, NEEDS[block])) {
      outcomes.push({ block, status: 'skipped', detail: NEEDS[block] })
      continue
    }
    onStage?.(block)
    try {
      outcomes.push(await writeBlock(link, codec, spec, doc, block))
    } catch (e) {
      outcomes.push({ block, status: 'failed', detail: detail(e) })
      if (!link.connected) {
        disconnected = true
        break
      }
    }
  }

  return { outcomes, disconnected }
}

async function writeBlock(
  link: HidLink,
  codec: KeyboardCodec,
  spec: DeviceSpec,
  doc: ProfileDocument,
  block: ProfileBlock,
): Promise<BlockOutcome> {
  switch (block) {
    case 'keyPerf': {
      const configs = doc.blocks.keyPerf
      if (!configs) return { block, status: 'skipped' }
      // Every key, not a dirty subset: the file is a whole board's worth and
      // a partial write would leave the keys it skipped on the board's own
      // values, which is not what "apply this profile" means.
      const written = await codec.writeKeyPerf!(link, [...configs])
      return written.mismatched.length === 0
        ? { block, status: 'written' }
        : {
            block,
            status: 'mismatch',
            detail: written.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(' · '),
          }
    }

    case 'advancedKeys': {
      const blobs = doc.blocks.advancedKeys
      if (!blobs) return { block, status: 'skipped' }
      const dks = fromBase64(blobs.dks)
      const pair = fromBase64(blobs.pair)
      const toggle = fromBase64(blobs.toggle)
      // The check has already passed these, so a null here is a bug rather
      // than a bad file — and still not a reason to write two of three tables.
      if (!dks || !pair || !toggle) return { block, status: 'failed', detail: 'base64' }
      await codec.restoreAdvancedKeys!(link, { dks, pair, toggle })
      return { block, status: 'written' }
    }

    case 'macros': {
      const macros = doc.blocks.macros
      if (!macros) return { block, status: 'skipped' }
      /*
       * The whole store, all 32 slots, including the ones the file has nothing
       * for. That is the block's own rule rather than a choice made here: the
       * offset table is the only index into the region, so laying every slot
       * out at once is what leaves no slot pointing at a body that does not
       * stop. See `writeMacros`.
       */
      // `mismatch`, not `mismatched` — the macro write is the one result in
      // the engine that names it in the singular.
      const written = await codec.writeMacros!(link, macros)
      return written.mismatch.length === 0
        ? { block, status: 'written' }
        : {
            block,
            status: 'mismatch',
            detail: written.mismatch.map((m) => `#${m.slot}`).join(' · '),
          }
    }

    case 'keymap': {
      const layers = doc.blocks.keymap
      if (!layers) return { block, status: 'skipped' }
      const bad: string[] = []
      for (const layer of layers) {
        if (layer.layer >= spec.keymap.layers) continue
        const entries: (KeymapEntry | null)[] = layer.entries.map((binding) =>
          // `null` stays null: it is a key the read could not place, and the
          // write leaves those alone rather than putting a value on a slot
          // nobody resolved.
          binding === null ? null : { binding },
        )
        const written = await codec.writeKeymap!(link, layer.layer, entries)
        for (const m of written.mismatched) bad.push(`L${layer.layer} #${m.slot}`)
      }
      return bad.length === 0
        ? { block, status: 'written' }
        : { block, status: 'mismatch', detail: bad.join(' · ') }
    }

    case 'keyRgb': {
      const colors = doc.blocks.keyRgb
      if (!colors) return { block, status: 'skipped' }
      const written = await codec.writeKeyColors!(link, [...colors])
      return written.mismatched.length === 0
        ? { block, status: 'written' }
        : {
            block,
            status: 'mismatch',
            detail: written.mismatched.map((m) => `#${m.slot}`).join(' · '),
          }
    }

    case 'global': {
      const patch = doc.blocks.global
      if (!patch) return { block, status: 'skipped' }
      const written = await codec.writeGlobalSettings!(link, patch)
      return written.mismatched.length === 0
        ? { block, status: 'written' }
        : {
            block,
            status: 'mismatch',
            detail: written.mismatched.map((m) => `payload[${m.offset}]`).join(' · '),
          }
    }
  }
}
