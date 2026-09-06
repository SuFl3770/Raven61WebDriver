/**
 * The default protocol — the one a new definition starts from.
 *
 * It is a **copy of the Raven61's**, taken here rather than referenced, for two
 * reasons that pull the same way:
 *
 *   - It is the only protocol anyone has decoded, so it is the only sensible
 *     baseline. Pretending otherwise would mean asking every new board to
 *     restate 60 numbers that are, as far as anyone knows, the same.
 *   - It is *not* the Raven61. The day a Raven61 firmware quirk is found and
 *     corrected in `boards/raven61/protocol.ts`, that correction should not
 *     silently rewrite what every other board inherited — those boards were
 *     tested against these numbers, not against a fix for someone else's
 *     hardware. When the two need to diverge, write the values out here.
 *
 * The copy is deep and frozen. Frozen because a spec that merged over it used
 * to be able to reach into a shared section and change it for every other
 * board; deep because a shallow copy would have shared exactly those sections.
 *
 * It is also what the debug-only "force the default protocol" switch sends —
 * see `state/forcedProtocol.ts`.
 */

import { RAVEN61_PROTOCOL } from '../boards/raven61/protocol'
import type { ProtocolSpec } from '../spec'

/**
 * What `basedOn` has to name to inherit this, and what the UI calls it.
 *
 * It keeps the Raven61's id because that is what it is a copy of: a definition
 * saying `basedOn: 'raven61-v1'` is claiming its board answers the protocol
 * decoded from a Raven61, which is exactly the claim being made.
 */
export const DEFAULT_PROTOCOL_ID = 'raven61-v1'

export const DEFAULT_PROTOCOL: ProtocolSpec = deepFreeze(clone(RAVEN61_PROTOCOL))

/** A structural copy — no shared objects, no shared arrays. */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value)) out[key] = clone(field)
    return out as T
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const field of Object.values(value)) deepFreeze(field)
    Object.freeze(value)
  }
  return value
}
