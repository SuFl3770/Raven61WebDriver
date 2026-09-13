import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeviceSpec } from '../device/active'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { usageForCode } from '../keyboard/hostKeys'
import { KEYCODES, keycodeDefLabel, keycodeLabel } from '../keyboard/keycodes'
import { supports } from '../protocol/codec'
import {
  MACRO_MAX_DELAY_MS,
  eventForUsage,
  isMacroEmpty,
  macroEventBudget,
  macroSlotsExposed,
  macroEventHex,
  macroEventsStored,
  modifierMaskLabel,
  repeatEvents,
  tapEvents,
  withMacro,
  type Macro as MacroBody,
  type MacroEvent,
} from '../protocol/macros'
import type { MacroSnapshot } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { macroSnapshotStore } from '../state/macroSnapshot'
import { useSettings } from '../state/settings'
import { macroRecording } from '../state/windowHold'
import { KeyCapture } from '../ui/KeyCapture'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { TabActions } from '../ui/TabActions'
import { Select, type SelectOption } from '../ui/Select'
import { useExitValue } from '../ui/useExit'

/**
 * Macros — the 32-slot store at flash 0x21100.
 *
 * `protocol/macros.ts` is the format and the evidence; this is the screen, and
 * three things about it are decided by the format rather than by taste.
 *
 * ### The store is written whole, so "apply" writes every slot
 *
 * There is no per-slot write and there cannot be one: the offset table indexes
 * all 32 bodies, so a body that changes length moves the offsets of the ones
 * after it. The panel therefore edits a copy of the whole store and applies it
 * in one go. What the status line names is the slots that actually changed,
 * because "wrote 4 KB" is true and useless.
 *
 * ### Binding is not done here
 *
 * A body nothing points at does nothing; a key pointing at a body that does not
 * stop makes the board type the contents of its own flash — the player has no
 * bound on its cursor (see the module header). So the order is fixed: the store
 * goes out, and only then the keymap entry.
 *
 * That rule is easier to keep in one place than in two, and the place that has
 * it is the remap tab: its macro category reads the store itself and binds
 * nothing until `canonical` comes back true. This tab had a bind button beside
 * the recorder and it has been taken out — a second door onto the keymap, on a
 * screen whose whole subject is the store, was a second thing to keep in step
 * with the format for no gain. Record here, bind there.
 *
 * ### The repeat count is reported and not offered
 *
 * The keymap record's third byte is a repeat count the firmware stores and
 * never reads. Offering a control for it would be offering a setting that does
 * nothing, so the debug list below reports whatever a slot already holds, and
 * the repeat that does work is more records in the body — which is what
 * "repeat" below does.
 *
 * Nothing on this tab is confirmed on hardware. Every write is read back and
 * compared, the same as everywhere else here, and that proves the bytes are in
 * the store — not that the board plays them.
 */

/** Delay a hand-added tap holds the key for, and the gap it leaves after. */
const DEFAULT_HOLD_MS = 20
const DEFAULT_GAP_MS = 40

/** What a recorded pause is rounded to, so an event list stays readable. */
const RECORD_ROUND_MS = 5

/** How long the write's confirmation stays on screen. */
const TOAST_MS = 2400

/**
 * And how long it takes to leave once it has. Must match `.toast.closing` in
 * styles.css — see ui/useExit.ts on why the two are written twice.
 */
const TOAST_EXIT_MS = 160

type Busy = null | 'read' | 'write'

/** Every plain usage, plus the eight modifiers as themselves. */
function usageOptions(): SelectOption[] {
  const out: SelectOption[] = []
  for (const def of KEYCODES) out.push({ value: String(def.code), label: keycodeDefLabel(def) })
  return out
}

const USAGES = usageOptions()


/**
 * What a slot is called on screen.
 *
 * One-based and with the stock driver's letter: its ten are "M 1" to "M 10"
 * and a reader coming from it counts from one, so the tab that edits the same
 * store says the same thing. The number in the code stays what the board uses
 * — a keymap record carries the index, `macroStart` rejects one above 31 — and
 * this is the only place the two are allowed to differ. Every place that shows
 * a slot goes through here, so the picker and the warnings cannot end up
 * naming the same slot two ways.
 */
function slotName(slot: number): string {
  return `M${slot + 1}`
}

/** A byte count with the reader's thousands separator. */
function bytes(n: number): string {
  return n.toLocaleString()
}

/**
 * What a finished write says, and then stops saying.
 *
 * It used to be a green notice in the slot panel. A notice is the right shape
 * for a state — the store is unsafe, the draft does not fit — because it is
 * true until something changes it and it should sit there until it is. "The
 * write landed and the read-back matched" is not a state: it is over the
 * moment it is read, and a panel that keeps it is a panel that grows a line
 * every time it is used, moving everything under it down, until the next edit
 * quietly takes the line away again.
 *
 * So it goes where the app already puts the news of a write — the toast under
 * the top bar, the same one the keymap's applies use (ui/ApplyToast.tsx) and
 * the debug gesture's. Failures are not moved: a mismatch or an error is a
 * state, it is what the reader has to act on, and a message that removed
 * itself after two seconds would be the wrong half of this pair.
 */
function AppliedToast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (message === null) return
    const id = setTimeout(onDone, TOAST_MS)
    return () => clearTimeout(id)
  }, [message, onDone])

  // Held with its text for the length of its exit, so it withdraws rather than
  // blanking halfway out — see ui/useExit.ts.
  const { shown, closing } = useExitValue(message, TOAST_EXIT_MS)
  if (shown === null) return null
  return (
    <div className={`toast${closing ? ' closing' : ''}`} role="status" aria-live="polite">
      {shown}
    </div>
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="small dim" style={{ minWidth: 120 }}>
        {label}
      </span>
      {children}
    </div>
  )
}

/**
 * What one event reads as.
 *
 * `unknown` is handled by the caller rather than here, because the only honest
 * label for it is its two bytes and that needs a translated string.
 */
function eventLabel(event: MacroEvent): string {
  switch (event.action.kind) {
    case 'key':
      return keycodeLabel(event.action.usage)
    case 'modifiers':
      return modifierMaskLabel(event.action.mask) || '—'
    case 'unknown':
      return '?'
  }
}

export function Macro() {
  const t = useT()
  const codec = useCodec()
  const spec = useDeviceSpec()
  const { connected } = useConnection()

  const canRead = supports(codec, 'readMacros')
  const canWrite = supports(codec, 'writeMacros')

  const { debug } = useSettings()
  const [slot, setSlot] = useState(0)
  /*
   * Both start from whatever the last visit left behind — see
   * state/macroSnapshot.ts. On the first visit that is null and the effect
   * below reads; on every visit after it the list is in the first paint, which
   * is the difference between the rows arriving with the tab's own animation
   * and arriving after it.
   *
   * Read once, on the way in, rather than subscribed: while this tab is
   * mounted, what is in that store is what this tab put there.
   */
  const [snapshot, setSnapshot] = useState<MacroSnapshot | null>(() => macroSnapshotStore.current())
  /** The whole store as edited. Null until a read, then always the full 32. */
  const [draft, setDraft] = useState<MacroBody[] | null>(() => {
    const kept = macroSnapshotStore.current()
    return kept ? kept.macros.map((m) => ({ ...m, events: [...m.events] })) : null
  })
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  /* Stable, so the toast's timer is not restarted by every render under it. */
  const clearStatus = useCallback(() => setStatus(null), [])
  const [mismatch, setMismatch] = useState<string | null>(null)

  // Editor controls that are not part of the store.
  const [addUsage, setAddUsage] = useState(KEYCODES[0]?.code ?? 4)
  /** Whether the next key pressed is the answer — see the effect below. */
  const [picking, setPicking] = useState(false)
  const [holdMs, setHoldMs] = useState(DEFAULT_HOLD_MS)
  const [gapMs, setGapMs] = useState(DEFAULT_GAP_MS)
  const [repeatTimes, setRepeatTimes] = useState(2)
  const [repeatGapMs, setRepeatGapMs] = useState(100)
  const [fixedDelayMs, setFixedDelayMs] = useState(0)
  const [recording, setRecording] = useState(false)

  const inFlight = useRef(false)

  /**
   * Reads the store, and the keymap sweep only when something will show it.
   *
   * The sweep is two thirds of the packets a read sends — the factory block
   * the slot map comes from, then a live layer per layer, each in its own
   * transaction — and the only thing on this tab that wants the answer is the
   * "in use" list, which is behind the debug gate. So the ordinary open reads
   * 4 KB and stops, and the lab pays for what the lab shows. See `readMacros`
   * in protocol/engine.ts.
   */
  const read = useCallback(
    async (uses: boolean) => {
      if (!codec.readMacros) return
      inFlight.current = true
      setBusy('read')
      setError(null)
      setMismatch(null)
      try {
        const next = await codec.readMacros(link, { uses })
        setSnapshot(next)
        setDraft(next.macros.map((m) => ({ ...m, events: [...m.events] })))
        // Keepable only if the sweep was skipped; the store decides that itself.
        macroSnapshotStore.load(next)
        setStatus(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
        setBusy(null)
      }
    },
    [codec],
  )

  /*
   * Opening the tab reads, and a failure is not retried — the same rule the
   * remap and advanced-key tabs follow. Leaving the tab and coming back is the
   * retry; without that, a board answering nothing would be asked once per
   * render.
   *
   * Switching the lab on is the one thing that reads twice, because the list
   * it wants was never fetched. `uses === null` is the snapshot saying so —
   * see protocol/types.ts, where that is kept apart from an empty list. Going
   * the other way reads nothing: a snapshot with the sweep in it is a superset
   * of one without, and throwing it away to save no packets would be the wrong
   * trade.
   */
  useEffect(() => {
    if (!connected || !canRead || inFlight.current) return
    if (snapshot && (snapshot.uses !== null || !debug)) return
    void read(debug)
  }, [connected, canRead, read, snapshot, debug])

  const current = draft?.[slot] ?? null
  /*
   * Counted in the reader's events, not in the store's records.
   *
   * The store holds 880 records and 32 of them are the stop record every slot
   * is written whether or not anything is in it, so what a list here can put
   * in is 848. Counting the terminators would make the panel say 882 beside a
   * list of 850, which is the number for the bytes and not for anything on
   * screen. Same comparison either way — both sides move by `spec.slots` — and
   * `encodeMacros` still checks itself in records. See `macroEventBudget`.
   */
  const capacity = macroEventBudget(spec.macros)
  const used = draft ? macroEventsStored(draft, spec.macros) : 0
  /*
   * The same budget in bytes, which is the unit the block is in and the other
   * thing a reader wants to know.
   *
   * Measured against what the events can take and not against the whole 3,584:
   * the 64-byte offset table and the stop record every one of the 32 slots is
   * written are 192 bytes the store carries empty or not, and no amount of
   * deleting gives them back. Counting them had an empty store reading
   * “3,392 B free of 3,584 B” — 192 bytes the reader can neither find nor free,
   * and a bar sitting off zero with nothing recorded. What is left over is
   * `capacity` records of four, so an empty store is all of it, a store at the
   * cap is none of it, and “0 B free” and “no more events fit” are one fact
   * said twice.
   *
   * That budget comes from `hostBytes` and not the block's 4096: this app
   * stops where the stock driver's own write stops, so that a store written
   * here stays one the stock driver can read back — see MACRO_BLOCK in
   * protocol/macros.ts.
   */
  const storeBytes = capacity * spec.macros.eventBytes
  const usedBytes = used * spec.macros.eventBytes
  const freeBytes = Math.max(0, storeBytes - usedBytes)
  const usedPct = Math.min(100, (usedBytes / storeBytes) * 100)
  /*
   * Nothing more fits. The same fact as `used >= capacity` — four bytes a
   * record — said in the unit the bar beside it is in, because "0 B free" is
   * what the reader is looking at when the buttons stop answering.
   */
  const full = freeBytes === 0
  // Ten by default and all 32 in debug mode. Not a board limit — see
  // `macroSlotsExposed`. A slot past the tenth still gets written, terminated
  // and read back like any other; what it does not get is a stock driver that
  // knows it exists.
  const exposed = macroSlotsExposed(debug, spec.macros)

  const editSlot = (events: MacroEvent[]) => {
    if (!draft || !current) return
    setDraft(
      withMacro(draft, {
        ...current,
        events,
        programmed: true,
        terminated: true,
      }),
    )
    setStatus(null)
  }

  // --- recording -----------------------------------------------------------

  /**
   * Records what the reader types, with the pauses between keystrokes.
   *
   * A record's delay is the pause that *follows* it, so a key event closes the
   * previous event rather than opening its own: the gap measured between two
   * keystrokes belongs to the earlier one. The last event of a pass keeps a
   * delay of 0, because there is nothing after it to wait for.
   *
   * `preventDefault` on every event, and `keydown` capture on the window:
   * recording Ctrl+W has to not close the tab, and Tab has to not move the
   * focus out of the panel. Auto-repeat is dropped — the board has no concept
   * of it and a held key would otherwise fill the store.
   */
  useEffect(() => {
    if (!recording || !current) return
    let last = performance.now()
    const events: MacroEvent[] = [...current.events]
    /*
     * How long this body may get, worked out once and enforced here rather
     * than left to the effect that watches `full`.
     *
     * That effect is a render behind: it sees the store only after the state
     * it is counting has landed, and a fast burst of keystrokes — a held
     * chord, a macro pad, anything faster than React — can push past the
     * budget before it runs. This is the bound that cannot be outrun, because
     * it is in the same synchronous step as the push it refuses.
     *
     * `capacity` is the whole store's, so what is left for this body is that
     * less what the other slots hold. Read once: nothing else can edit the
     * store while a pass is running (every control that could is disabled),
     * which is the same reason the event list is copied rather than watched.
     */
    const room = capacity - (used - current.events.length)

    const push = (usage: number, press: boolean) => {
      if (events.length >= room) {
        setRecording(false)
        return
      }
      const now = performance.now()
      const gap = Math.min(
        MACRO_MAX_DELAY_MS,
        Math.round((now - last) / RECORD_ROUND_MS) * RECORD_ROUND_MS,
      )
      last = now
      const previous = events[events.length - 1]
      if (previous) events[events.length - 1] = { ...previous, delayMs: gap }
      events.push(eventForUsage(usage, press, 0))
      editSlot([...events])
    }

    const onDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.repeat) return
      const usage = usageForCode(e.code)
      if (usage !== undefined) push(usage, true)
    }
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault()
      const usage = usageForCode(e.code)
      if (usage !== undefined) push(usage, false)
    }
    window.addEventListener('keydown', onDown, { capture: true })
    window.addEventListener('keyup', onUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true })
      window.removeEventListener('keyup', onUp, { capture: true })
    }
    /*
     * `current` is deliberately not a dependency, and this is the one place in
     * the app that leaves one out on purpose. The listeners hold their own copy
     * of the event list and their own clock; re-attaching them on every
     * keystroke would reset that clock, and every pause would measure as zero.
     *
     * Nothing else can change the slot's events while this is running — every
     * control that edits them, the slot picker included, is disabled while
     * recording — so the copy cannot go stale under it.
     */
  }, [recording])

  /*
   * Recording takes the window, the way calibration does.
   *
   * The listeners above are on the window under capture and call
   * `preventDefault` on everything they see, so while a pass runs no key
   * reaches the chrome at all: the tab strip, the drawer and the disconnect
   * button are already unusable by keyboard, and leaving them bright and
   * clickable by mouse would be the page saying otherwise. Switching tabs
   * mid-pass unmounts the recorder and loses what it has collected.
   *
   * Cleared on the way out as well as when the flag drops — the flag outlives
   * this component, and a tab left mid-recording (or a disconnect, which swaps
   * the whole app for the connect screen) must not leave the next session
   * holding a window nothing can give back. See state/windowHold.ts.
   */
  useEffect(() => {
    macroRecording.set(recording)
    return () => macroRecording.set(false)
  }, [recording])

  /*
   * A full store ends the pass.
   *
   * The recorder appends a record per key event and does not ask whether there
   * is room, so without this it would keep taking keystrokes the store cannot
   * hold — and the reader, whose keys are being swallowed by a window that
   * says it is recording, would have no way to tell the difference between a
   * pass that is working and one that is not. It stops at the last event that
   * fits, which is the event the bar has just run out of room for.
   */
  useEffect(() => {
    if (full) setRecording(false)
  }, [full])

  /*
   * Recording wins. Both take every key on the window, and the recorder is the
   * one with something to lose — a pass that swallowed one keystroke into the
   * picker instead of the list would be a recording with a hole in it.
   *
   * The flag is cleared rather than left to the picker's `disabled`, which
   * already stops it listening: the flag is what the button is drawn from, so
   * leaving it set would re-arm the picker the moment the pass ended, waiting
   * on a key nobody had asked it for.
   */
  useEffect(() => {
    if (recording) setPicking(false)
  }, [recording])

  // --- writing -------------------------------------------------------------

  /**
   * Writes the store, and only the store — binding is the remap tab's, see the
   * header.
   *
   * The read that follows is a full one in the sense that matters: it is what
   * turns the draft back into what the board actually holds, mismatches and
   * all. Whether it sweeps the keymap with it is the same question the opening
   * read asks, and gets the same answer.
   */
  const apply = async () => {
    if (!draft || !codec.writeMacros) return
    // Refused here rather than left to `encodeMacros` to throw. Its error
    // carries the numbers but not a translated sentence, and this is a state
    // the panel can see coming — the notice under the button is already up.
    if (used > capacity) {
      setError(t('macro.capacityFull', { used, total: capacity }))
      return
    }
    setBusy('write')
    setError(null)
    setMismatch(null)
    setStatus(null)
    try {
      const written = await codec.writeMacros(link, draft)
      if (written.mismatch.length > 0) {
        setMismatch(
          t('macro.mismatch', {
            detail: written.mismatch
              .map((m) => `#${m.slot} ${m.wanted} → ${m.got}`)
              .join(' · '),
          }),
        )
        return
      }
      await read(debug)
      setStatus(
        written.sent
          ? t('macro.applied', {
              slots: written.changed.length,
              total: spec.macros.slots,
              bytes: written.bytes,
            })
          : t('macro.unchanged'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /*
   * No key grid on this tab, and nothing that picks a cap.
   *
   * Every other tab that draws a grid is *about* the caps: what is picked
   * there is what the panels below are setting, and the board is the subject.
   * Here the keyboard was the tallest thing on screen and the least of what
   * the tab does — one selection, used by one button, above a page of
   * recording and store and event list that is longer than the window on any
   * machine. Both went with the button; see the header.
   *
   * `uses` survives it, for the debug list at the bottom: which keys start
   * which body is a fact about the board this tab read, and the one place
   * left that says so.
   *
   * Unfiltered, and the layer strip above the panels went the same way as the
   * grid. Picking a layer was only ever a question the bind button asked, and
   * `readMacros` sweeps every readable layer anyway (see `protocol/engine.ts`)
   * — so the list names the layer in a column rather than hiding the rows of
   * the ones not picked. A lab readout that quietly drops half of what was
   * read is worse than a longer table.
   */
  const uses = snapshot?.uses ?? []

  /** The names the layer strip used, now that the strip is gone. */
  const layerLabel = (n: number) =>
    n === 0 ? t('keymap.layer.main') : n === 1 ? t('keymap.layer.fn1') : `FN${n}`

  if (!canRead) {
    return (
      <>
        <Panel title={t('macro.title')}>
          <NotDecoded what="macro.what" />
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="macro.note" />
          </div>
        </Panel>
      </>
    )
  }

  /*
   * A slot is its number and how much is in it, and that is the whole label.
   *
   * There was a name field here, kept in localStorage because the store has
   * nowhere to put one — an offset table and 4-byte records, every bit of the
   * four accounted for (see protocol/macros.ts). A name that never reaches the
   * board, never leaves the browser it was typed in and is not what a keymap
   * record carries was one more thing on screen than the tab needed. The slot
   * number is the identity, here and in the keymap both.
   */
  const slotOptions: SelectOption[] = Array.from({ length: exposed }, (_, i) => ({
    value: String(i),
    label: t('macro.slotPlain', { slot: i + 1, count: draft?.[i]?.events.length ?? 0 }),
  }))

  return (
    <>
      {/*
        The write and the undo, in the row the tab's title is on — the same
        place the input-point tab puts the button that starts a calibration,
        and for the same reason: they act on the whole of what is on screen
        rather than on any one panel of it.

        They had a panel across the top of the tab to themselves, which spent a
        band of the window drawing a box round two buttons and a picker. What
        the tab is set to is now said where it is used, over the list the
        picker chooses; what is done to the store is said up here, where every
        tab says that kind of thing.

        Refused rather than veiled while a pass is being recorded: the title
        row is not one of the regions a hold dims (see state/windowHold.ts), so
        `disabled` is the whole of what stops them — which is the same
        `disabled` that stopped them when they sat in the panel.
      */}
      <TabActions>
        <button
          disabled={busy !== null || recording || !canWrite || used > capacity}
          onClick={() => void apply()}
        >
          {busy === 'write' ? t('macro.applying') : t('macro.apply')}
        </button>
        <button
          className="ghost"
          disabled={busy !== null || recording}
          onClick={() => {
            if (snapshot)
              setDraft(
                snapshot.macros.map((m) => ({
                  ...m,
                  events: [...m.events],
                })),
              )
            setStatus(null)
          }}
        >
          {t('macro.revert')}
        </button>
      </TabActions>

      {/*
        The tab is as tall as the room it is given and no taller.

        Everything in it that can be long has its own box to be long in — the
        record list, and the panels on the right — so the page itself has
        nothing to scroll and the two buttons at the head of the list stay
        where they are. The height comes from the box rather than from
        arithmetic: `.macro-tab` is the column that fills `.tab-scroll`, the
        panel above is as tall as it is, and what is left over is the grid's.
        See `.macro-tab` in styles.css, which is where the previous version of
        this — a `--stick-h` worked out from every rem between the window's top
        and the grid's — went wrong the moment a panel was put above it.
      */}
      <div className="macro-tab">
        {/*
          Two columns on a wide window: the event list on the left, everything
          that acts on it on the right.

          The list is the tab, and it is the one part of the page whose height
          is the board's rather than the layout's — a body can run to eighty-odd
          records. Stacked, that pushed "직접 넣기" and "일괄 편집" — the two
          panels whose whole job is to put records in the list — below the
          bottom of it, so adding an event meant scrolling past the thing you
          were adding to and then back. Beside it, they are read against it.

          The right column is everything else by the same rule rather than by
          sorting: the two editors and the debug list are all about the body, and
          neither of them is the body.

          The DOM is in the order the columns read, left then right, so the
          narrow window below the breakpoint stacks them without a single
          `order` rule and the tab order never disagrees with the page.
        */}
        <div className="macro-cols">
          <div className="macro-col">
            <Panel title={t('macro.slot')}>
              {/*
                Which slot, and how much of the store is left to put in it.

                In this column and above the list rather than across the top of
                the tab: the picker chooses what the list below it shows, and
                the bar is whether the next event has anywhere to go, so both
                are about this column and about nothing else on the page. What
                is done to the store — the write, the undo — is the part that
                was not about one column, and that is in the title row.

                Centred because the pair is narrower than the column it sits
                in, and against the left edge it reads as the start of a row
                that never arrived.

                The picker is refused for the length of a recording — the
                recorder holds its own copy of the event list (see the effect
                above), so a slot swapped under it would put the pass in the
                wrong body.
              */}
              <div className="row macro-store">
                <Select
                  label={t('macro.slot')}
                  value={String(slot)}
                  options={slotOptions}
                  disabled={busy !== null || recording}
                  onChange={(v) => setSlot(Number(v))}
                />
                {/*
                  What is left of the block, as a bar and the two numbers beside
                  it.

                  A bar because "how full" is the question, and a number of bytes
                  on its own does not answer it against a total nobody has
                  memorised; the numbers because a bar on its own cannot say how
                  much more will fit. Filled by what is used, the way a disk is
                  drawn, and red once the draft is past what can be written — the
                  notice below the buttons says what to do about that.

                  Beside the picker rather than under it: one says which body is
                  open, the other whether there is room left for a record in any
                  of them, and a reader about to add an event is asking both at
                  once. Two short things on one line, which is what the row is
                  wide enough for.

                  Only once there is a store to measure: before the read there is
                  no draft, and a full bar over "3,392 B free" would be an answer
                  made up out of nothing.
                */}
                {draft && (
                  <>
                    {/*
                      The break between what is being edited and what is left of
                      the store: two different questions, one row. An `<hr>` on
                      its side, the way the tab-actions band does it — see
                      `.sep` in styles.css.

                      Inside the same condition as the gauge, so a row with no
                      store to measure is not left with a rule standing next to
                      nothing.
                    */}
                    <hr className="sep" />
                    <div className="macro-gauge">
                      <div
                        className="macro-gauge-track"
                        role="progressbar"
                        aria-label={t('macro.storeUse')}
                        aria-valuemin={0}
                        aria-valuemax={storeBytes}
                        aria-valuenow={usedBytes}
                      >
                        <div
                          className={`macro-gauge-fill${usedBytes > storeBytes ? ' over' : ''}`}
                          style={{ width: `${usedPct}%` }}
                        />
                      </div>
                      <div className="small dim macro-gauge-read">
                        {t('macro.storeFree', {
                          free: bytes(freeBytes),
                          total: bytes(storeBytes),
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Panel>
            <Panel title={t('macro.events')}>
              {/*
                Above the list, not under it.

                A body can run to eighty-odd records and the column it is in is
                pinned to the height of the window, so a control at the foot of
                the list is a control behind a scroll — and this is the one the
                tab is for. At the head it is where the panel starts, which is
                where the column starts, which is on screen.

                "Stop recording" is the same button, so the thing that ends a
                pass is where the thing that began it was. The notice under it is
                the pair's own state and travels with it.
              */}
              <div className="row">
                {/*
                  Every control that puts a record in the store is refused once
                  there is nowhere to put one — this, the three below "직접
                  넣기" and the repeat. What stays is what makes room or leaves
                  the count alone: clearing the list, setting delays, writing
                  the store, reverting.
                */}
                <button
                  disabled={busy !== null || !canWrite || !current || full}
                  onClick={() => setRecording((on) => !on)}
                >
                  {recording ? t('macro.recordStop') : t('macro.record')}
                </button>
                <button
                  className="ghost"
                  disabled={busy !== null || recording || !canWrite || !current}
                  onClick={() => editSlot([])}
                >
                  {t('macro.clear')}
                </button>
              </div>
              {recording && (
                <Notice kind="info">
                  <T k="macro.recordingNow" />
                </Notice>
              )}
              {snapshot?.macros[slot]?.aliasOf !== undefined && (
                <Notice kind="warn">
                  <T
                    k="macro.aliasOf"
                    params={{
                      slot: slot + 1,
                      owner: snapshot!.macros[slot]!.aliasOf! + 1,
                    }}
                  />
                </Notice>
              )}
              {/*
                What the store has to say, in this column because this is where
                the store is now on screen — the bar at the top of it, the list
                under it. The band is ordered by how close each line is to the
                controls above: the recording is the state of the button two
                rows up, the alias is this slot's, and the four below are the
                store's and the write's.

                Under the pair rather than beside the buttons that would answer
                them: those are in the title row, and a notice is a paragraph,
                not a control.
              */}
              {/*
                Not a description of the store — it is the one state in which
                pressing a macro key sends the player walking through flash, and
                the write in the title row is the fix. See the module header, and
                `canonical` in protocol/types.ts.
              */}
              {snapshot && !snapshot.canonical && (
                <Notice kind="err">
                  <T k="macro.storeUnsafe" params={{ slots: snapshot.malformed.length }} />
                </Notice>
              )}
              {used > capacity && (
                <Notice kind="err">
                  <T k="macro.capacityFull" params={{ used, total: capacity }} />
                </Notice>
              )}
              {mismatch && <Notice kind="err">{mismatch}</Notice>}
              {error && <Notice kind="err">{error}</Notice>}
              {/*
                The records, and the only part of this panel that scrolls.

                The box is the scroller rather than the column around it, so what
                is above it — the heading, the two buttons, whatever notice is up
                — is still on screen at record 400 of 850. Recording is started
                and stopped from the same place no matter how far down the list
                the reader has gone, which is the point: a stop button that has
                to be found first is a stop button that arrives late. See
                `.macro-list` in styles.css.
              */}
              <div className="macro-list">
                {!current || isMacroEmpty(current) ? (
                  <div className="small dim" style={{ marginTop: 10 }}>
                    <T k="macro.noEvents" />
                  </div>
                ) : (
                  <table className="small" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>{t('macro.eventKey')}</th>
                        <th>{t('macro.eventDir')}</th>
                        <th>{t('macro.delayMs')}</th>
                        <th>{t('macro.hex')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {current.events.map((event, i) => (
                        <tr key={i}>
                          <td className="dim">{i + 1}</td>
                          <td>
                            {event.action.kind === 'unknown'
                              ? t('macro.eventUnknown', {
                                  nibble: event.action.nibble,
                                  value: event.action.value,
                                })
                              : eventLabel(event)}
                          </td>
                          <td>{event.press ? t('macro.down') : t('macro.up')}</td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              max={MACRO_MAX_DELAY_MS}
                              value={event.delayMs}
                              disabled={busy !== null || recording || !canWrite}
                              style={{ width: '5.5rem' }}
                              onChange={(e) => {
                                const next = [...current.events]
                                next[i] = {
                                  ...event,
                                  delayMs: Number(e.target.value) || 0,
                                }
                                editSlot(next)
                              }}
                            />
                          </td>
                          <td>
                            <code>{macroEventHex(event)}</code>
                          </td>
                          <td>
                            <button
                              className="ghost"
                              disabled={busy !== null || recording || !canWrite}
                              onClick={() => editSlot(current.events.filter((_, j) => j !== i))}
                            >
                              {t('macro.remove')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Panel>
          </div>

          {/*
            Everything that is not the list, and it goes away while one is being
            recorded.

            Every control in here is already refused during a pass, and a row of
            disabled inputs is a true thing said quietly. The window is held
            (state/windowHold.ts) and the chrome around the tab is dimmed by the
            same rule, so this column is dimmed with it: what is live during a
            recording is the list and the button that ends it, and nothing else
            on screen should look like it might be.
          */}
          <div className={`macro-col${recording ? ' blocked' : ''}`}>
            {/*
              The panels scroll inside the column rather than the column inside
              the page, for the same reason the record list does — and the dim
              goes on the column, which does not move, so a scrolled column is
              still covered edge to edge while a pass is recorded.
            */}
            <div className="macro-col-scroll">
              <Panel title={t('macro.addTitle')}>
                <Row label={t('macro.addKey')}>
                  <Select
                    label={t('macro.addKey')}
                    value={String(addUsage)}
                    options={USAGES}
                    disabled={busy !== null || recording || !canWrite}
                    onChange={(v) => {
                      setAddUsage(Number(v))
                      // Picking from the list answers the question the button
                      // beside it is waiting for.
                      setPicking(false)
                    }}
                  />
                  {/*
                    The same choice, made on the keyboard — see ui/KeyCapture,
                    which is where this used to live in full. It is shared with
                    the advanced-key tab's binding fields now, which ask the
                    same question this one does.
                  */}
                  <KeyCapture
                    armed={picking}
                    onArmed={setPicking}
                    onCapture={setAddUsage}
                    disabled={busy !== null || recording || !canWrite}
                  />
                </Row>
                <Row label={t('macro.holdMs')}>
                  <input
                    type="number"
                    min={0}
                    max={MACRO_MAX_DELAY_MS}
                    value={holdMs}
                    disabled={busy !== null || recording || !canWrite}
                    style={{ width: '5.5rem' }}
                    onChange={(e) => setHoldMs(Number(e.target.value) || 0)}
                  />
                </Row>
                <Row label={t('macro.gapMs')}>
                  <input
                    type="number"
                    min={0}
                    max={MACRO_MAX_DELAY_MS}
                    value={gapMs}
                    disabled={busy !== null || recording || !canWrite}
                    style={{ width: '5.5rem' }}
                    onChange={(e) => setGapMs(Number(e.target.value) || 0)}
                  />
                </Row>
                <div className="row">
                  <button
                    disabled={busy !== null || recording || !canWrite || !current || full}
                    onClick={() =>
                      current && editSlot([...current.events, ...tapEvents(addUsage, holdMs, gapMs)])
                    }
                  >
                    {t('macro.addTap')}
                  </button>
                  <button
                    className="ghost"
                    disabled={busy !== null || recording || !canWrite || !current || full}
                    onClick={() =>
                      current &&
                      editSlot([...current.events, eventForUsage(addUsage, true, holdMs)])
                    }
                  >
                    {t('macro.addDown')}
                  </button>
                  <button
                    className="ghost"
                    disabled={busy !== null || recording || !canWrite || !current || full}
                    onClick={() =>
                      current && editSlot([...current.events, eventForUsage(addUsage, false, gapMs)])
                    }
                  >
                    {t('macro.addUp')}
                  </button>
                </div>
              </Panel>

              <Panel title={t('macro.tools')}>
                <Row label={t('macro.repeatTimes')}>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={repeatTimes}
                    disabled={busy !== null || recording || !canWrite}
                    style={{ width: '5.5rem' }}
                    onChange={(e) => setRepeatTimes(Number(e.target.value) || 1)}
                  />
                </Row>
                <Row label={t('macro.repeatGap')}>
                  <input
                    type="number"
                    min={0}
                    max={MACRO_MAX_DELAY_MS}
                    value={repeatGapMs}
                    disabled={busy !== null || recording || !canWrite}
                    style={{ width: '5.5rem' }}
                    onChange={(e) => setRepeatGapMs(Number(e.target.value) || 0)}
                  />
                </Row>
                <Row label={t('macro.fixedDelay')}>
                  <input
                    type="number"
                    min={0}
                    max={MACRO_MAX_DELAY_MS}
                    value={fixedDelayMs}
                    disabled={busy !== null || recording || !canWrite}
                    style={{ width: '5.5rem' }}
                    onChange={(e) => setFixedDelayMs(Number(e.target.value) || 0)}
                  />
                </Row>
                <div className="row">
                  <button
                    className="ghost"
                    disabled={
                      busy !== null ||
                      recording ||
                      !canWrite ||
                      !current ||
                      isMacroEmpty(current) ||
                      full
                    }
                    onClick={() =>
                      current && editSlot(repeatEvents(current.events, repeatTimes, repeatGapMs))
                    }
                  >
                    {t('macro.repeatApply')}
                  </button>
                  <button
                    className="ghost"
                    disabled={
                      busy !== null || recording || !canWrite || !current || isMacroEmpty(current)
                    }
                    onClick={() =>
                      current &&
                      editSlot(
                        current.events.map((e) => ({
                          ...e,
                          delayMs: fixedDelayMs,
                        })),
                      )
                    }
                  >
                    {t('macro.flattenApply')}
                  </button>
                </div>
              </Panel>

              {/*
                Which keys start which body, for the lab only.

                It is a readout with nothing to act on now that binding has left this
                tab: no button beside it, no cap to pick, just four columns restating
                what the remap tab shows in place on the keys themselves. The repeat
                column is the clearest case — a byte the firmware stores and never
                reads is exactly the kind of fact a protocol lab wants on screen and
                nobody else does. So it goes where the rest of those went.
              */}
              {debug && (
                <Panel title={t('macro.inUse')}>
                  {uses.length === 0 ? (
                    <div className="small dim">
                      <T k="macro.noneBound" />
                    </div>
                  ) : (
                    <table className="small" style={{ marginTop: 6 }}>
                      <thead>
                        <tr>
                          <th>{t('macro.layers')}</th>
                          <th>{t('macro.key')}</th>
                          <th>{t('macro.slot')}</th>
                          <th>{t('macro.eventCount')}</th>
                          <th>{t('macro.repeatColumn')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uses.map((u) => (
                          <tr key={`${u.layer}:${u.slot}`}>
                            <td className="dim">{layerLabel(u.layer)}</td>
                            <td>{u.label || `#${u.slot}`}</td>
                            <td>{slotName(u.macro)}</td>
                            <td>{draft?.[u.macro]?.events.length ?? 0}</td>
                            <td className="dim">{u.repeat}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="small dim" style={{ marginTop: 6 }}>
                    <T k="macro.repeatByteNote" />
                  </div>
                </Panel>
              )}
            </div>
          </div>
        </div>
      </div>

      {/*
        Outside `.macro-tab`: it is fixed to the window rather than laid out in
        the tab, and it must not be inside anything a recording dims — a
        confirmation you cannot read is not one. See `.toast` in styles.css.
      */}
      <AppliedToast message={status} onDone={clearStatus} />
    </>
  )
}
