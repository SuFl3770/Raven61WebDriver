import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { activeSpec, subscribeActiveSpec } from '../device/active'
import type { KeyDef } from '../device/spec'
import { keycodeLabel } from '../keyboard/keycodes'
import { supports } from '../protocol/codec'
import { RECORD_TYPE, bindingLabel, factoryBinding, sameBinding } from '../protocol/keymap'
import type { KeymapEntry } from '../protocol/types'
import { link, useCodec, useConnection } from './link'

/**
 * What the caps read, once the keymap has been changed.
 *
 * A cap's legend used to be the board's own printing — `KeyDef.label`, which is
 * what is moulded into the plastic — on every grid in the app. That is right
 * until the key is remapped, and then it is a grid of 61 labels that name keys
 * the board no longer has: the actuation set on "Caps Lock" is the actuation of
 * whatever Caps Lock now sends, and nothing outside the remap tab said so.
 *
 * So the base layer is read once per connection and kept here, and `KeyGrid`
 * draws the binding instead of the printing wherever the two differ. It is one
 * store rather than a prop threaded through six tabs because the tabs that need
 * it are not related to each other — lighting, advanced keys, the monitor —
 * and none of them has any other reason to know what a key sends.
 *
 * ## Only the base layer
 *
 * Layer 0 is what the key does when it is pressed on its own, which is what a
 * legend means. An Fn layer is a *held* state, and a cap that reads "F5"
 * because Fn+2 sends F5 would be wrong for as long as Fn is not held — which
 * is nearly always. The remap tab shows the other layers, one at a time,
 * because there the layer is the thing being edited.
 *
 * ## Only what the board holds
 *
 * Pending edits on the remap tab are not published here. They are shown on that
 * tab in the warning colour precisely because the board does not hold them yet,
 * and a lighting tab that quietly renamed a cap for an edit that was never
 * applied — or was reverted — would be describing a keyboard that does not
 * exist. `Keymap` publishes on a read and after a successful write.
 */
class LegendStore {
  /** The base layer as the board reported it, by key index. Empty until read. */
  private entries: readonly (KeymapEntry | undefined)[] = []
  private listeners = new Set<() => void>()

  current(): readonly (KeymapEntry | undefined)[] {
    return this.entries
  }

  set(entries: readonly (KeymapEntry | undefined)[]): void {
    this.entries = entries
    this.emit()
  }

  /**
   * Back to the board's own printing.
   *
   * Called when the device goes away and when a different board is opened —
   * bindings are indexed by key, and one board's key 34 is not another's.
   */
  clear(): void {
    if (this.entries.length === 0) return
    this.entries = []
    this.emit()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

export const legends = new LegendStore()

/*
 * A board swap clears this itself rather than being cleared from state/link.ts
 * with the others, so that `link` can keep importing nothing from here — the
 * hook below needs the link, and the two files cannot both reach for each
 * other. `device/active` is under both of them and imports neither.
 */
let lastSpec = activeSpec()
subscribeActiveSpec(() => {
  if (activeSpec() === lastSpec) return
  lastSpec = activeSpec()
  legends.clear()
})

/** What one cap should read, and whether that is still the board's printing. */
export interface Legend {
  text: string
  /** True when the key no longer sends what its cap says. Drawn in the accent. */
  remapped: boolean
}

/**
 * The legend for a key, given the base layer the board reported.
 *
 * Three cases the printing survives: nothing has been read, this key has no
 * record (the slot map did not resolve one — see `keymap.unmapped`), and the
 * binding is exactly the one the key was made for. The last is the common case
 * and the reason this is a comparison rather than a straight substitution: a
 * board with a stock keymap must look like a stock keyboard, not like 61 keys
 * that have all been "changed" to themselves.
 *
 * An unbound key reads as a dash — but only where "unbound" is a decision.
 * `KC_NO`, which is what emptying a key writes, is a setting whose whole
 * visible effect is that the key stopped working, so it shows wherever it is
 * set: the cap says A and the key sends nothing, and there is no name to put
 * there instead. The factory's never-set marker is a different byte and a
 * different fact — it is most of an Fn layer straight out of the box, and a
 * grid of 87 dashes says only "this is an Fn layer" while losing which key is
 * which. Those caps keep their printing, and only off the base layer, where
 * every key has a factory binding and empty means somebody emptied it. Same
 * split the remap tab's second line makes — see `capBinding` there.
 *
 * ## An advanced key keeps the printing
 *
 * A key bound to DKS or MT has no keymap record left to name: the three bytes
 * that used to say what it sends now say which advanced record runs it, and
 * `bindingLabel` can only read that back as the record's number. "Adv key 3" on
 * a cap is the one legend in the app that names nothing anybody chose — it is a
 * row in a table that cannot be seen from here, and it replaces the one thing
 * still worth reading off a cap, which is which key this is.
 *
 * So the printing stays, in the accent that says it is no longer plain. What
 * the record actually does is spelled out under the grid on the advanced-keys
 * tab, which is the only place holding the three tables that could answer it —
 * see the foot in features/Advanced.
 */
export function legendFor(
  key: KeyDef,
  entries: readonly (KeymapEntry | undefined)[],
  /** False when `entries` is a layer the board holds above the base one. */
  baseLayer = true,
): Legend {
  const binding = entries[key.index]?.binding
  if (!binding) return { text: key.label, remapped: false }
  if (sameBinding(binding, factoryBinding(key.code))) return { text: key.label, remapped: false }
  if (binding.kind === 'none') {
    return binding.raw === RECORD_TYPE.key || baseLayer
      ? { text: '—', remapped: true }
      : { text: key.label, remapped: false }
  }
  if (binding.kind === 'advanced') return { text: key.label, remapped: true }
  return { text: bindingLabel(binding, keycodeLabel), remapped: true }
}

export function useLegends(): readonly (KeymapEntry | undefined)[] {
  return useSyncExternalStore(
    (fn) => legends.subscribe(fn),
    () => legends.current(),
  )
}

/**
 * Reads the base layer once per connection, so the grids are right on whatever
 * tab is open when the board is plugged in.
 *
 * Mounted once, in `App`. Without it the caps would only pick up a remap after
 * the remap tab had been visited, which is exactly backwards: the tab that
 * already shows every binding is the one tab that does not need this.
 *
 * A failure is swallowed. This is a legend, not a setting — a board that will
 * not answer leaves the caps reading what is printed on them, which is what
 * they read before this existed. The remap tab is where a failed keymap read is
 * reported, with a retry.
 */
export function useLegendSync(): void {
  const codec = useCodec()
  const { connected } = useConnection()
  const inFlight = useRef(false)

  useEffect(() => {
    if (!connected) {
      legends.clear()
      return
    }
    const read = supports(codec, 'readKeymap') ? codec.readKeymap : undefined
    if (!read) return
    // Not again while one is running, and not at all once something — this or
    // the remap tab — has filled the store for the attached board.
    if (inFlight.current || legends.current().length > 0) return
    inFlight.current = true
    void read(link, 0)
      .then((entries) => legends.set(entries))
      .catch(() => {})
      .finally(() => {
        inFlight.current = false
      })
  }, [codec, connected])
}

/**
 * One layer's keymap, for a grid whose own strip chooses which layer it draws.
 *
 * The store above is the base layer and nothing else, on purpose: an Fn layer
 * is a held state, and a cap naming what it sends while Fn is down would be
 * wrong on every tab that is not asking about layers. The overview tab *is*
 * asking — its strip picks one — so it reads the layer it is showing and hands
 * the entries to `KeyGrid`.
 *
 * Layer 0 reads nothing and returns null. The store already holds it, filled
 * once per connection by the sync above, and a second read of the same bytes
 * would be traffic spent to arrive at the value already on screen — null is
 * "use the store", which is what the grid does with no entries of its own.
 *
 * Kept per layer, so moving back and forth across the strip reads each one
 * once. A failure caches an empty layer rather than nothing, so a board that
 * will not answer is not asked again on every render; the caps fall back to
 * their printing, which is what they showed before any of this existed.
 */
export function useLayerKeymap(layer: number): readonly (KeymapEntry | undefined)[] | null {
  const codec = useCodec()
  const { connected } = useConnection()
  const [byLayer, setByLayer] = useState<Record<number, readonly (KeymapEntry | undefined)[]>>({})
  /** The layer being read, so a second render does not start the same read. */
  const inFlight = useRef<number | null>(null)

  useEffect(() => {
    if (!connected || layer === 0 || byLayer[layer] || inFlight.current === layer) return
    const read = supports(codec, 'readKeymap') ? codec.readKeymap : undefined
    if (!read) return
    inFlight.current = layer
    void read(link, layer)
      .then((entries) => setByLayer((prev) => ({ ...prev, [layer]: entries })))
      .catch(() => setByLayer((prev) => ({ ...prev, [layer]: [] })))
      .finally(() => {
        inFlight.current = null
      })
  }, [codec, connected, layer, byLayer])

  return layer === 0 ? null : (byLayer[layer] ?? null)
}
