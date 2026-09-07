import { useSyncExternalStore } from 'react'
import type { HidLink } from '../hid/link'
import { supports, type Raven61Codec } from '../protocol/codec'
import { mergeGlobalPatch, type GlobalPatch } from '../protocol/global'
import { configStore } from './config'
import { globalStore } from './global'
import { currentCodec, link } from './link'

/**
 * Keeps the app and the board in step without anyone pressing a button.
 *
 * There used to be "read from board" and "apply to board". Both are gone: the
 * board is read when a section is opened, and a changed setting is written on
 * its own. What is left is the part that cannot go — saying whether the write
 * landed. An acknowledged write the firmware ignored is indistinguishable from
 * one that worked (the reply is the request echoed back, docs §3.1), so the
 * codec reads the block back and compares bytes, and this reports that.
 *
 * Two things make this safe to do continuously:
 *
 * **A hold, not a delay.** One per-key write is a keymap read, a block read,
 * nineteen write chunks and a verify read — about seventy packets — and one
 * board-wide write is a read, a write, a 400 ms settle and a verify read. A
 * slider firing a change per pixel cannot send one of either. The first version
 * waited for the value to stop changing, which throttled the slider but also
 * put that same wait in front of every checkbox, where there is nothing to
 * throttle. Instead the controls that move continuously say so: they `hold()`
 * while the pointer or key is down and `release()` after, and everything else
 * writes at once. **Both blocks obey it** — see `applyGlobal` for why that had
 * to be fixed rather than assumed.
 *
 * **A queue of one.** Reads and writes both touch a whole block, so they must
 * never overlap: a read that lands mid-write returns a half-written block, and
 * two writes race over the same read-modify-write. Everything goes through
 * `chain`, and a change arriving during a write waits for the write that
 * follows rather than joining the one in flight — as dirty keys for the per-key
 * block, and as a merged `pendingGlobal` for the board-wide one. Either way one
 * write is in flight and at most one is waiting, however fast the changes
 * arrive.
 */

export type SyncPhase = 'idle' | 'pending' | 'reading' | 'writing'

export interface SyncState {
  phase: SyncPhase
  /** Set when the last operation failed; the keys stay dirty for a retry. */
  error: string | null
  /** When the board last confirmed a write. */
  appliedAt: Date | null
  /**
   * How many keys that write covered, so the confirmation can say. Zero for a
   * board-wide write, which has no keys to count and is not announced.
   */
  appliedKeys: number
  /** Slots that did not read back as written, if any. */
  mismatch: string[]
  /**
   * The board-wide edit the board has not confirmed yet.
   *
   * Everything not yet in `globalStore`: what is being held under a pointer,
   * what is queued behind a write, and what the write in flight is carrying.
   * All three at once, because the controls that produce them have to keep
   * showing them — the store holds what the board last *said*, so a slider
   * reading from there alone would not move under the pointer, and would snap
   * back to the old value for the length of a write and then jump forward
   * again.
   *
   * Null means the board and the screen agree.
   */
  pendingGlobal: GlobalPatch | null
}

/**
 * What the engine needs from the outside, named rather than imported.
 *
 * It reaches for the live codec and the live connection on every job — both
 * change under it — and taking them as functions is what lets the behaviour
 * that matters here (the settle delay, and never running two block operations
 * at once) be checked without a keyboard. See tools/check/sync.ts.
 */
export interface SyncDeps {
  codec(): Raven61Codec
  connected(): boolean
  link(): HidLink
}

export class BoardSync {
  constructor(private readonly deps: SyncDeps) {}

  private state: SyncState = {
    phase: 'idle',
    error: null,
    appliedAt: null,
    appliedKeys: 0,
    mismatch: [],
    pendingGlobal: null,
  }
  private listeners = new Set<() => void>()
  /**
   * How many controls are mid-gesture. Writes wait while this is above zero.
   *
   * A count rather than a flag because nothing stops two controls being held at
   * once — a slider dragged while a spinner is repeating — and the write should
   * go when the last of them lets go.
   */
  private held = 0
  /** True while a write is queued but has not started, so none is queued twice. */
  private queued = false
  /** The same, for the board-wide block, which has its own read-modify-write. */
  private globalQueued = false
  /**
   * The board-wide edit not sent yet, and the one a write is carrying.
   *
   * Two fields rather than one because they clear at different moments: the
   * unsent half clears when a write picks it up, and the in-flight half only
   * when the verify read has put the board's new state in the store. Both are
   * shown, merged, as `SyncState.pendingGlobal` — see `showPending`.
   */
  private unsentGlobal: GlobalPatch | null = null
  private inFlightGlobal: GlobalPatch | null = null
  /** Serialises everything against the board. */
  private chain: Promise<unknown> = Promise.resolve()

  current(): SyncState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Publishes the two halves as one.
   *
   * A panel does not care whether a value is under a pointer, in a queue or on
   * the wire — only that the board does not have it yet, and that the control
   * should go on showing it until it does.
   */
  private showPending(rest: Partial<SyncState> = {}): void {
    const merged = this.inFlightGlobal
      ? mergeGlobalPatch(this.inFlightGlobal, this.unsentGlobal ?? {})
      : this.unsentGlobal
    this.patch({ ...rest, pendingGlobal: merged })
  }

  private patch(next: Partial<SyncState>): void {
    this.state = { ...this.state, ...next }
    for (const fn of this.listeners) fn()
  }

  /** Runs `job` after whatever is already queued, whether or not that failed. */
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job)
    // Swallowed here only so one failure does not poison the chain; every job
    // reports its own error into the state.
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * Reads the whole board into the stores.
   *
   * Called when a section is opened. Skipped while there are unwritten edits —
   * a read replaces the working copy, and quietly discarding what the user just
   * changed is worse than showing a value a moment out of date.
   */
  read(): Promise<void> {
    return this.queue(async () => {
      const codec = this.deps.codec()
      if (!this.deps.connected() || !supports(codec, 'readKeyConfigs')) return
      if (configStore.dirtyIndices().length > 0) return
      this.patch({ phase: 'reading', error: null })
      try {
        if (supports(codec, 'readKeyPerf')) {
          configStore.load((await codec.readKeyPerf!(this.deps.link())).configs)
        } else {
          configStore.load(await codec.readKeyConfigs!(this.deps.link()))
        }
        if (supports(codec, 'readGlobalSettings')) {
          // A failure here must not throw away the per-key values.
          try {
            globalStore.load(await codec.readGlobalSettings!(this.deps.link()))
          } catch {
            globalStore.clear()
          }
        }
        this.patch({ phase: 'idle' })
      } catch (e) {
        this.patch({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  /**
   * A setting changed. Sends it, unless a control is still being dragged.
   *
   * No delay of its own: the wait belongs to the controls that need one, and
   * putting it here made every checkbox feel slow for the sake of the one
   * slider.
   */
  schedule(): void {
    if (!this.deps.connected()) return
    this.patch({ phase: 'pending', error: null })
    if (this.held > 0) return
    void this.write()
  }

  /**
   * Holds writes while a control is being worked — a slider dragged, a spinner
   * held down. Paired with `release`, which sends what accumulated.
   */
  hold(): void {
    this.held++
  }

  release(): void {
    if (this.held === 0) return
    this.held--
    if (this.held > 0) return
    // Both blocks: a lighting slider and an actuation slider are the same
    // gesture as far as this is concerned, and either may have accumulated
    // something while the pointer was down.
    if (configStore.dirtyIndices().length > 0) void this.write()
    if (this.unsentGlobal) void this.flushGlobal()
  }

  /** Sends now, whatever is being held. The retry after a failure. */
  flush(): Promise<void> {
    // Both blocks, because either can be holding something: the retry button
    // does not know which write failed and should not have to.
    const global = this.unsentGlobal ? this.flushGlobal() : Promise.resolve()
    return Promise.all([this.write(), global]).then(() => {})
  }

  /**
   * Changes fields of the board-wide block.
   *
   * **Coalesced, and held like the per-key path.** This used to send every
   * patch as its own write, on the reasoning that the block held nothing but
   * switches and a switch cannot be dragged. That stopped being true when the
   * lighting effect moved in: brightness, speed and the colour are dragged, one
   * write is a read-modify-write with a settle delay in the middle, and a drag
   * emitting a patch per pixel queued dozens of them — so the board fell
   * seconds behind the pointer and the whole app felt stuck.
   *
   * Two rules fix it, and they are the two the per-key path already had:
   *
   *   - **A hold, not a delay.** A control that moves says so (`useHeldWrites`),
   *     and nothing is sent until it is let go. A checkbox holds nothing and
   *     still goes at once.
   *   - **One in flight, one pending.** Patches merge into `pendingGlobal`, and
   *     the queued job reads it when it *runs* rather than when it was
   *     scheduled — so everything that arrived while a write was in flight
   *     leaves in the next one instead of queueing a write each.
   *
   * The queue is still shared with the per-key writes, because both are
   * read-modify-writes over a whole block and must never interleave.
   */
  applyGlobal(patch: GlobalPatch): Promise<void> {
    if (!this.deps.connected()) return Promise.resolve()
    this.unsentGlobal = mergeGlobalPatch(this.unsentGlobal, patch)
    this.showPending({ phase: 'pending', error: null })
    if (this.held > 0) return Promise.resolve()
    return this.flushGlobal()
  }

  /** Sends whatever has accumulated for the board-wide block. */
  private flushGlobal(): Promise<void> {
    // One waiting write is enough: it takes the whole pending patch when it
    // runs, so a second would find nothing left to send.
    if (this.globalQueued) return this.chain.then(() => {})
    this.globalQueued = true
    return this.queue(async () => {
      this.globalQueued = false
      const codec = this.deps.codec()
      // Read at run time, not when this was scheduled — anything changed while
      // an earlier write was in flight belongs to this one.
      const patch = this.unsentGlobal
      if (!patch) return
      if (!this.deps.connected() || !supports(codec, 'writeGlobalSettings')) return
      /*
       * Moved, not dropped. The controls go on showing it for the length of the
       * write — otherwise a slider snaps back to the board's old value the
       * moment the pointer is let go and jumps forward again half a second
       * later, which reads as the edit having been lost.
       */
      this.unsentGlobal = null
      this.inFlightGlobal = patch
      this.showPending({ phase: 'writing', error: null, mismatch: [] })
      try {
        const result = await codec.writeGlobalSettings!(this.deps.link(), patch)
        // The store first, then the overlay: the two must never be down at the
        // same moment or the control blinks through the old value.
        globalStore.load(result.after)
        this.inFlightGlobal = null
        if (result.mismatched.length > 0) {
          this.showPending({
            phase: 'idle',
            mismatch: result.mismatched.map(
              (m) =>
                `payload[${m.offset}] 0x${m.wanted.toString(16).padStart(2, '0')} → 0x${m.got
                  .toString(16)
                  .padStart(2, '0')}`,
            ),
          })
          return
        }
        this.showPending({ phase: 'idle', appliedAt: new Date(), appliedKeys: 0, mismatch: [] })
      } catch (e) {
        /*
         * Put the edit back rather than losing it — the same rule the per-key
         * path follows by leaving its keys dirty. Merged *under* whatever
         * arrived while the write was failing, so a newer value still wins, and
         * not retried from here: a board that is not answering would otherwise
         * be written to in a loop. The next change, or `flush`, carries it.
         */
        this.unsentGlobal = mergeGlobalPatch(patch, this.unsentGlobal ?? {})
        this.inFlightGlobal = null
        this.showPending({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  private write(): Promise<void> {
    // One waiting write is enough: it reads the dirty set when it runs, so a
    // second would find nothing left to do.
    if (this.queued) return this.chain.then(() => {})
    this.queued = true
    return this.queue(async () => {
      this.queued = false
      const codec = this.deps.codec()
      // Read the dirty set inside the queued job, not when it was scheduled:
      // anything changed while an earlier write was in flight belongs to this
      // one.
      const changed = [...configStore.dirtyIndices()]
      if (changed.length === 0) return
      if (!this.deps.connected() || !supports(codec, 'writeKeyPerf')) return

      this.patch({ phase: 'writing', error: null, mismatch: [] })
      const payload = configStore.all().map((c, i) => (changed.includes(i) ? c : null))
      try {
        const written = await codec.writeKeyPerf!(this.deps.link(), payload)
        // Only the keys this write covered. Anything the user touched while it
        // ran stays dirty and goes out next.
        configStore.markClean(changed)
        if (written.mismatched.length > 0) {
          // The board holds something else. Its values win, because they are
          // what the keyboard will actually do.
          configStore.load(written.configs)
          this.patch({
            phase: 'idle',
            mismatch: written.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`),
          })
          return
        }
        this.patch({ phase: 'idle', appliedAt: new Date(), appliedKeys: changed.length, mismatch: [] })
      } catch (e) {
        // The keys are left dirty on purpose: the board does not have them, and
        // the next change — or the retry — must still carry them.
        this.patch({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
      }
    })
  }
}

export const boardSync = new BoardSync({
  codec: currentCodec,
  connected: () => link.connected,
  link: () => link,
})

// Any edit schedules a write. Subscribing here rather than calling from each
// panel means a panel cannot forget to, and there is one debounce for all of
// them however many stores an edit touches.
configStore.subscribe(() => {
  if (configStore.dirtyIndices().length > 0) boardSync.schedule()
})

export function useSyncState(): SyncState {
  return useSyncExternalStore(
    (fn) => boardSync.subscribe(fn),
    () => boardSync.current(),
  )
}
