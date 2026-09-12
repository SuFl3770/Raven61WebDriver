import type { MacroSnapshot } from '../protocol/types'

/**
 * The macro store as last read off the board, kept between visits to the tab.
 *
 * A store rather than component state for the reason state/firmware.ts is one:
 * the tab is unmounted the moment another one is opened, so its read went out
 * again on every visit — 4 KB in 76 packets, which is most of a second on a
 * real board and the whole of the wait a user sees. What that wait is *for* is
 * the question: nothing on the board changed between leaving the tab and
 * coming back to it.
 *
 * ### The sweep is not kept, whoever read it
 *
 * `MacroSnapshot.uses` is which keys start which body, and that is a fact about
 * the *keymap* — the remap tab can change it without this store hearing about
 * it, and a cached answer would go quietly stale the first time someone binds
 * a macro there. So what is kept is the store half of a read and never that
 * list: a swept snapshot is taken apart on the way in rather than turned away,
 * which keeps this as fresh as the last read of any kind. The `null` the copy
 * carries is true of the copy — nobody is being told the sweep found nothing.
 *
 * A reader that wants the list therefore reads, every time, which is what the
 * macro tab's debug mode does.
 *
 * ### No subscription, unlike state/firmware.ts
 *
 * Nothing needs telling when this changes. It is read once, in the initialiser
 * of the state it seeds, and the only writer while the tab is up is that tab.
 * The two things that clear it — the board going away, a factory reset — take
 * the tab off screen or leave it to read again on its next visit, so there is
 * no mounted reader to notify and no hook here to do it with.
 *
 * What *can* change the part that is kept is a write, and there are three:
 * this tab's own — which re-reads and lands back here — a factory reset, and
 * the board going away. The last two clear it.
 */
class MacroSnapshotStore {
  private snapshot: MacroSnapshot | null = null

  current(): MacroSnapshot | null {
    return this.snapshot
  }

  /**
   * Keeps the half of a snapshot that keeps.
   *
   * The projection is here rather than at the call site so there is one place
   * that decides what survives. A caller hands over what it read and does not
   * have to know which parts this is willing to promise are still true later.
   */
  load(next: MacroSnapshot): void {
    this.snapshot = next.uses === null ? next : { ...next, uses: null, slotMap: null }
  }

  /** Dropped on disconnect and on a reset: neither leaves this still true. */
  clear(): void {
    this.snapshot = null
  }
}

export const macroSnapshotStore = new MacroSnapshotStore()
