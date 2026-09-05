import { useSyncExternalStore } from 'react'
import type { HidLink } from '../hid/link'
import { supports, type Raven61Codec } from '../protocol/codec'
import type { GlobalPatch } from '../protocol/raven61'
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
 * **A hold, not a delay.** One write is a keymap read, a block read, nineteen
 * write chunks and a verify read — about seventy packets — so a slider firing a
 * change per pixel cannot each send one. The first version waited for the value
 * to stop changing, which throttled the slider but also put that same wait in
 * front of every checkbox, where there is nothing to throttle. Instead the
 * controls that move continuously say so: they `hold()` while the pointer or
 * key is down and `release()` after, and everything else writes at once.
 *
 * **A queue of one.** Reads and writes both touch the whole 1024-byte block, so
 * they must never overlap: a read that lands mid-write returns a half-written
 * block, and two writes race over the same read-modify-write. Everything goes
 * through `chain`, and a change arriving during a write leaves its keys dirty
 * for the write that follows rather than joining the one in flight.
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

  private state: SyncState = { phase: 'idle', error: null, appliedAt: null, appliedKeys: 0, mismatch: [] }
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
  /** Serialises everything against the board. */
  private chain: Promise<unknown> = Promise.resolve()

  current(): SyncState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
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
    if (this.held === 0 && configStore.dirtyIndices().length > 0) void this.write()
  }

  /** Sends now, whatever is being held. The retry after a failure. */
  flush(): Promise<void> {
    return this.write()
  }

  /**
   * Changes a field of the board-wide block.
   *
   * Not debounced: the things that live in that block are switches, and a
   * switch cannot be dragged. It still goes through the queue, because the
   * global write is its own read-modify-write and must not interleave with a
   * per-key one.
   */
  applyGlobal(patch: GlobalPatch): Promise<void> {
    return this.queue(async () => {
      const codec = this.deps.codec()
      if (!this.deps.connected() || !supports(codec, 'writeGlobalSettings')) return
      this.patch({ phase: 'writing', error: null, mismatch: [] })
      try {
        const result = await codec.writeGlobalSettings!(this.deps.link(), patch)
        globalStore.load(result.after)
        if (result.mismatched.length > 0) {
          this.patch({
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
        this.patch({ phase: 'idle', appliedAt: new Date(), appliedKeys: 0, mismatch: [] })
      } catch (e) {
        this.patch({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
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
