/**
 * The Raven61's protocol, as a value.
 *
 * This is the "how it talks" half of a board: framing, command bytes, block
 * geometry, bit positions, timings. The other half — which keys it has, which
 * switches it takes, which ids it enumerates as — is in `index.ts`.
 *
 * Every number here is a reference to the module that carries the evidence for
 * it. `src/protocol/frame.ts` explains why the checksum is at byte 3 and why
 * 0xa8 is the analog-mode command; restating those values here would be a
 * second copy to keep in step with the first. What this file adds is the
 * *shape*: it says which of those constants make up one board's protocol, so
 * another board can state a different set.
 *
 * It is also what `src/device/protocols/default.ts` copies to make the baseline
 * every other definition inherits.
 */

import { CAL_RECORD_BYTES, CAL_SLOTS } from '../../../protocol/calibration'
import { COUNTS_PER_MM } from '../../../protocol/encoding'
import { FACTORY_RESET_DEFAULTS, MONITOR_DEFAULTS } from '../../../protocol/engine'
import { DEFAULT_COMMANDS, DEFAULT_EVENT, DEFAULT_FRAME } from '../../../protocol/frame'
import { DEFAULT_GLOBAL } from '../../../protocol/global'
import { DEFAULT_KEYMAP } from '../../../protocol/keymap'
import { DEFAULT_KEY_PERF } from '../../../protocol/keyPerf'
import { UNUSED_SLOTS } from '../../../protocol/slotMap'
import type { ProtocolSpec } from '../../spec'

/**
 * Confirmed on hardware for the framing, the per-key performance block, the
 * keymap and the analog stream. The lighting, macro and advanced-key blocks
 * are not decoded, so no command names them — a panel that would need one says
 * so rather than sending a byte nobody has read.
 */
export const RAVEN61_PROTOCOL: ProtocolSpec = {
  frame: DEFAULT_FRAME,
  commands: DEFAULT_COMMANDS,
  event: DEFAULT_EVENT,
  keyPerf: DEFAULT_KEY_PERF,
  keymap: DEFAULT_KEYMAP,
  global: DEFAULT_GLOBAL,
  monitor: { ...MONITOR_DEFAULTS },
  factoryReset: { ...FACTORY_RESET_DEFAULTS },
  calibration: { records: CAL_SLOTS, recordSize: CAL_RECORD_BYTES },
  encoding: { countsPerMm: COUNTS_PER_MM },
  slotMap: {
    unusedSlots: UNUSED_SLOTS,
    /**
     * Four keys short is still trusted. A keymap read that resolves fewer than
     * that is treated as a failure, because a mapping with a real hole in it
     * puts settings on the wrong key rather than on no key.
     */
    resolveTolerance: 4,
  },
  requestTimeoutMs: 300,
}
