/**
 * The boards compiled into the app.
 *
 * **To add one:** make `src/device/boards/<board>/` with an `index.ts` (the
 * spec), a `layout.ts` (the key table) and, if its protocol differs from the
 * default, a `protocol.ts`. Then add it to the array below. That is the whole
 * registration step — the codec, the probe, the key grid and every panel come
 * from the spec.
 *
 * Order matters only for ties: `selectCodec` tries these in order and the first
 * probe that matches wins, so a spec for one specific product should come
 * before a spec that claims a whole vendor. JSON specs from
 * `src/device/user/` are tried *before* these, so a user can override a
 * built-in board for their own hardware without editing this file.
 */

import type { DeviceSpec } from '../spec'
import { raven61Spec } from './raven61/index'

export const BUILT_IN_SPECS: readonly DeviceSpec[] = [raven61Spec]

/**
 * The placeholder the layout code falls back to when no spec claims the
 * attached device.
 *
 * Something has to have a shape — `activeLayout()` is called on every render —
 * and the honest choice is the board this app was written against. It is never
 * presented as the user's keyboard: `ActiveDevice.matched` is false in that
 * case, and `KeyGrid` says there is no definition rather than drawing these 61
 * keys. See `src/device/active.ts`.
 */
export const DEFAULT_SPEC: DeviceSpec = raven61Spec
