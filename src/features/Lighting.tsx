import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { useDeviceSpec, useLayout } from '../device/active'
import { supports } from '../protocol/codec'
import { UNLIT, hexOf, isUnlit, luminanceOf, sameRgb, type Rgb } from '../protocol/keyRgb'
import { LIGHT_CONTROL, effectOf, supportsControl } from '../protocol/lighting'
import type { KeyRgbSnapshot } from '../protocol/types'
import { useGlobalSettings } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { selection, targetKeys, useSelection } from '../state/selection'
import { boardSync } from '../state/sync'
import { GridFrame } from '../ui/GridFrame'
import { KeyGrid } from '../ui/KeyGrid'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { LightEffect } from './LightEffect'

/**
 * Lighting — the effect the board runs, and the colour stored for each key.
 *
 * Two blocks, one screen, one grid over it:
 *
 *   - **Effect** is nine bytes of the board-wide settings block — the one 0x05
 *     reads and 0x06 writes. See `features/LightEffect.tsx` and
 *     `protocol/lighting.ts`.
 *   - **Per-key colour** is its own 384-byte block at flash 0x20f00, read with
 *     0x0a and written with 0x0b. See `protocol/keyRgb.ts`.
 *
 * Two blocks, but not two subjects, and that is why they share a panel: the
 * stored colours are what **Custom Light** paints, and every other effect
 * generates its own and ignores the block. The colours are that one effect's
 * parameter in everything but where the bytes live. So the settings panel
 * holds both, colours on top — one page, with the effect list beside it and
 * the keyboard over both.
 *
 * Three decisions worth the words:
 *
 *   - **Colour edits are not written as they are made**, where effect settings
 *     are. An effect setting is a switch or a slider in a block this app
 *     rewrites all day; a colour write is a flash rewrite of the lighting area,
 *     which is the one thing here with a recorded history of needing the stock
 *     driver to undo (findings.md #4). So it stays an explicit press, as on the
 *     remap tab.
 *   - **The caps are painted, not labelled.** A colour is recognised without
 *     being read, and a hex triplet across 61 caps is a page of codes. What the
 *     grid cannot say — which key is which colour, by name — the line under it
 *     says for whichever cap the pointer is on.
 *   - **The grid is the frame the board is displaying, always.** The stored
 *     layer is flash; the frame is the RAM buffer the effect engine rewrites,
 *     with the firmware's calibration overlay on top. They disagree for good
 *     reasons — but only one of them answers "what is lit", and a switch
 *     between the two made that answer something you had to ask for. The
 *     stored colours are still read, still written and still what the colour
 *     controls edit; what they no longer do is take the grid over. Pending edits
 *     are painted on top of the frame, because a colour being picked has to
 *     look like something before it is applied.
 */

/**
 * A legend colour that can be read against a cap painted `color`.
 *
 * On luma rather than on any single channel or a mean of the three: saturated
 * blue is dark and saturated yellow is not, and averaging the bytes puts white
 * text on the yellow one.
 */
function legendOn(color: Rgb): string {
  return luminanceOf(color) > 0.55 ? '#000' : '#fff'
}

export function Lighting() {
  const codec = useCodec()
  const t = useT()
  const { keys } = useLayout()
  // For the poll interval the panel quotes — it is the board's spec, not a
  // constant, so a board that answers more slowly says a different number.
  const spec = useDeviceSpec()
  const { connected } = useConnection()
  const sel = useSelection()
  const global = useGlobalSettings()

  /** The stored layer, as the board last reported it. */
  const [stored, setStored] = useState<KeyRgbSnapshot | null>(null)
  /** One frame of what the LEDs are showing. */
  const [frame, setFrame] = useState<KeyRgbSnapshot | null>(null)
  /** Pending colours by key index. Cleared by a read, a revert or a write. */
  const [edits, setEdits] = useState<Record<number, Rgb>>({})
  /**
   * Whether the frame watch is still running.
   *
   * There is no switch for it and nothing to switch to: the grid shows what
   * the board is displaying, and a "now" that needed a button press to be now
   * would be a worse lie than not having the view at all. This goes false only
   * when a read fails, and what it prevents is a board that is answering
   * nothing being asked again every poll. Reconnecting turns it back on;
   * otherwise leaving the tab and coming back is the retry, as it is for the
   * stored block.
   */
  const [watching, setWatching] = useState(true)
  const [picked, setPicked] = useState('#ff8000')
  /** What is in the hex box, which is not a colour yet while it is being typed. */
  const [typed, setTyped] = useState<string | null>(null)
  const [hovered, setHovered] = useState<number | undefined>(undefined)

  const [busy, setBusy] = useState<null | 'read' | 'write' | 'frame'>(null)
  const inFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)
  /** The same edits, for the read effect to check without depending on them. */
  const editsRef = useRef(edits)
  editsRef.current = edits

  const canRead = supports(codec, 'readKeyColors')
  const canWrite = supports(codec, 'writeKeyColors')
  const canFrame = supports(codec, 'readLightFrame')
  const canWatch = supports(codec, 'watchLightFrame')

  const targets = targetKeys(sel)
  const dirty = Object.keys(edits).length
  /**
   * True while the grid is a painting surface rather than a readout.
   *
   * Which is whenever this board has a colour block to paint. It used to follow
   * the open sub-tab, back when the colours were a section of their own; now
   * they are part of the effect's settings and there is nothing to follow.
   */
  const painting = canRead

  const readStored = useCallback(async () => {
    if (!codec.readKeyColors) return
    inFlight.current = true
    setBusy('read')
    setError(null)
    setMismatch(null)
    try {
      const snapshot = await codec.readKeyColors(link)
      setStored(snapshot)
      setEdits({})
      setStatus(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [codec])

  /*
   * Opening the tab reads the colour block. There is no read button for it:
   * this is the refresh, the same way every other tab reads on entry.
   *
   * It will not re-read while edits are waiting — discarding what was just
   * painted is worse than a view a moment out of date — and it will not retry
   * itself after a failure, or a board that answers nothing would be asked once
   * per render, forever. Leaving the tab and coming back is the retry.
   */
  useEffect(() => {
    if (!connected || !canRead || inFlight.current) return
    if (Object.keys(editsRef.current).length > 0) return
    void readStored()
  }, [connected, canRead, readStored])

  /*
   * And the settings block, which is where the effect lives. Through the shared
   * queue rather than directly, because the effect write is a read-modify-write
   * of the same block and the two must not interleave.
   */
  useEffect(() => {
    if (!connected) return
    void boardSync.read()
  }, [connected])

  /** One frame, for a board that can read one but cannot be watched. */
  const readFrame = useCallback(async () => {
    if (!codec.readLightFrame) return
    setBusy('frame')
    setError(null)
    try {
      setFrame(await codec.readLightFrame(link))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [codec])

  /*
   * A board with no watch command still gets a frame — one, on the way in, and
   * one after a write changes what it should be showing (see `apply`). There is
   * no button to ask for another: what this tab can promise such a board is a
   * frame, not a live one, and a refresh button would only move the gap around
   * rather than close it.
   */
  useEffect(() => {
    if (!connected || canWatch || !canFrame) return
    void readFrame()
  }, [connected, canWatch, canFrame, readFrame])

  /*
   * A watch that failed stays off until something has changed about the board
   * it was reading. Reconnecting is that something.
   */
  useEffect(() => {
    if (connected) setWatching(true)
  }, [connected])

  /*
   * While the tab is open, keep reading the frame.
   *
   * This is the stock driver's own behaviour — its worker reads the LED frame
   * every time its job queue is empty (docs §3.0) — and it is what makes the
   * grid answer "which keys are lit" rather than "which keys were lit when you
   * pressed the button". The cadence and the one-read-at-a-time rule belong to
   * the codec, not here; see `watchLightFrame` in protocol/engine.ts.
   *
   * `cancelled` rather than only the stop function: the watch reads the slot
   * map before its first frame, so the panel can be left while the promise is
   * still outstanding, and the stop it eventually hands over would then arrive
   * after nothing is listening.
   *
   * A failure turns the watch off and shows why, instead of retrying — see
   * `watching`.
   */
  useEffect(() => {
    if (!watching || !connected || !canWatch || !codec.watchLightFrame) return
    let cancelled = false
    let stop: (() => void) | undefined
    codec
      .watchLightFrame(
        link,
        (snapshot) => {
          if (!cancelled) setFrame(snapshot)
        },
        {
          onError: (message) => {
            if (cancelled) return
            setError(message)
            setWatching(false)
          },
        },
      )
      .then((release) => {
        if (cancelled) release()
        else stop = release
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setWatching(false)
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [watching, connected, canWatch, codec])

  /**
   * The colour a key shows.
   *
   * A pending edit first — it is the one colour here that is not on the board,
   * and painting a cap has to look like something before it is applied. Then
   * the frame the board is displaying. A board whose spec names no frame
   * command falls back to the stored layer, which is the only thing it has.
   */
  const shownColor = (index: number): Rgb | undefined => {
    const edit = edits[index]
    if (edit) return edit
    if (canFrame) return frame?.entries[index]?.color
    return stored?.entries[index]?.color
  }

  /**
   * Paints the selected keys.
   *
   * The targets are read at event time rather than at render time: a drag
   * across the grid and the colour change that follows must not disagree about
   * what is selected. Same rule as the input-point panels.
   */
  const paint = (color: Rgb) => {
    setEdits((prev) => {
      const next = { ...prev }
      for (const index of targetKeys(selection.current())) {
        const onBoard = stored?.entries[index]?.color
        // An edit back to what the board holds is not an edit. Keeping it would
        // put the key in the pending count and send a write that changes
        // nothing.
        if (onBoard && sameRgb(onBoard, color)) delete next[index]
        else next[index] = color
      }
      return next
    })
  }

  const choose = (color: Rgb) => {
    setPicked(hexOf(color))
    setTyped(null)
    paint(color)
  }

  const apply = async () => {
    if (!codec.writeKeyColors) return
    setBusy('write')
    setError(null)
    setMismatch(null)
    try {
      const colors: (Rgb | null)[] = keys.map((k) => edits[k.index] ?? null)
      const result = await codec.writeKeyColors(link, colors)
      /*
       * The write already read the block back, so the board's new state is in
       * `result.after` — decoding it here saves a third read of the same block
       * just to show what the board now holds. The slots come from the read
       * this panel already has, because that is where the mapping lives.
       */
      setStored((prev) =>
        prev
          ? {
              ...prev,
              blob: result.after,
              entries: prev.entries.map((entry) => {
                if (entry.slot === undefined) return entry
                const at = entry.slot * 3
                return {
                  slot: entry.slot,
                  color: {
                    r: result.after[at] ?? 0,
                    g: result.after[at + 1] ?? 0,
                    b: result.after[at + 2] ?? 0,
                  },
                }
              }),
            }
          : prev,
      )
      setEdits({})
      setStatus(
        result.slots.length === 0
          ? t('light.noChange')
          : t('light.applied', { count: result.keys.length }),
      )
      // Both are failures of a write that was otherwise acknowledged, and the
      // mismatch is the more serious of the two, so it is reported last.
      if (result.unmapped.length > 0) {
        setMismatch(
          t('light.unmapped', {
            count: result.unmapped.length,
            keys: result.unmapped.map((k) => k.label).join(', '),
          }),
        )
      }
      if (result.mismatched.length > 0) {
        setMismatch(
          t('light.mismatch', {
            count: result.mismatched.length,
            detail: result.mismatched.map((m) => `#${m.slot} ${m.wanted} → ${m.got}`).join(', '),
          }),
        )
      }
      // The stored layer just changed, so a frame fetched before it is stale.
      // Dropping it beats showing the grid a colour it predates. A watched
      // board fills it again within the poll; one that cannot be watched is
      // asked once here, because nothing else would ask.
      setFrame(null)
      if (!canWatch && canFrame) void readFrame()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Nothing selected: the controls stay on screen but do nothing.
   *
   * Disabled rather than hidden, for the reason the input-point panels give —
   * so the page does not rearrange itself around an empty selection, and so it
   * is plain that there is a setting here and a reason it cannot be touched.
   */
  const none = targets.length === 0
  const unmapped = stored ? keys.filter((k) => stored.entries[k.index]?.slot === undefined) : []

  /**
   * The keys the board is lighting right now, in layout order.
   *
   * The count is the thing this view is for — "which keys are lit" is a
   * question the grid answers by being looked at, and a number is what makes it
   * answerable at a glance and comparable between frames.
   *
   * Unlit here means the frame reported three zero bytes for that key, which is
   * an LED the firmware is not driving. It is the same test the caps use, so
   * the count can never disagree with what is on screen.
   */
  const litKeys = frame
    ? keys.filter((k) => {
        const color = frame.entries[k.index]?.color
        return color !== undefined && !isUnlit(color)
      })
    : []

  /*
   * The readout is worded per layer, because the same three zero bytes mean
   * different things in each. A pending edit of them is *clear the custom
   * colour*, an instruction not yet given; in the frame they are an LED the
   * firmware is not driving right now; in the stored block — which is what a
   * board with no frame command falls back to — they are a setting that is
   * absent. Reading "no custom colour" off a frame would be this tab's own
   * confusion, printed back at the user.
   *
   * An edit is called out as unapplied rather than read like any other colour.
   * It is the one thing on the grid that the board has not been told about, and
   * the dot on the cap says *that* a key is pending where this says what it is
   * pending as.
   *
   * The empty state differs for a plainer reason: there is nothing to select
   * unless the per-key section is open, so telling someone to drag across the
   * caps is otherwise an instruction that does nothing.
   */
  const hoveredKey = hovered === undefined ? undefined : keys.find((k) => k.index === hovered)
  const hoveredEdit = hovered === undefined ? undefined : edits[hovered]
  const hoveredColor = hovered === undefined ? undefined : shownColor(hovered)
  const readout = !hoveredKey
    ? t(painting ? 'light.pickNone' : 'light.hoverNone')
    : hoveredEdit
      ? isUnlit(hoveredEdit)
        ? t('light.pendingUnlit', { key: hoveredKey.label })
        : t('light.pendingPick', { key: hoveredKey.label, color: hexOf(hoveredEdit) })
      : !hoveredColor || isUnlit(hoveredColor)
        ? t(canFrame ? 'light.hoveredOff' : 'light.pickedUnlit', { key: hoveredKey.label })
        : t('light.picked', { key: hoveredKey.label, color: hexOf(hoveredColor) })

  /**
   * Whether the stored colours are the ones the board is showing.
   *
   * They are only ever shown by **Custom Light** — every other effect generates
   * its own colours and never reads this block. The effect table says which
   * one: `LIGHT_CONTROL.perKey` is the bit the stock page uses to swap its
   * colour picker for a per-key editor, and only that row carries it. So the
   * app asks the table rather than hard-coding a mode number.
   */
  const effect = global?.lighting ? effectOf(spec.lightEffects, global.lighting.mode) : undefined
  const perKeyLive = supportsControl(effect, LIGHT_CONTROL.perKey)

  /**
   * The per-key colour controls, for the settings panel to put over its
   * sliders.
   *
   * Not a panel of its own any more. The stored colours are what one effect
   * reads, which makes them that effect's settings in everything but where the
   * bytes live — and a second panel under a second heading made them look like
   * a second subject. What is left here is the controls and the two warnings
   * that stop a press from being wasted; the prose that used to sit under them
   * said what the panel already shows.
  /**
   * The keys as a colour target, for the settings panel's one colour control.
   *
   * Values and callbacks rather than the controls themselves: the panel decides
   * whether this or the effect's own colour byte is what the picker writes, and
   * it cannot decide that for a block of finished markup. What stays here is
   * everything the decision does not touch — the selection, the pending edits,
   * and the warnings that say whether a press will reach the LEDs.
   */
  const perKey = {
    notices: (
      <>
        {connected && !stored && busy === null && !error && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">{t('light.unread')}</Notice>
          </div>
        )}
        {unmapped.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">
              {t('light.unmapped', {
                count: unmapped.length,
                keys: unmapped.map((k) => k.label).join(', '),
              })}
            </Notice>
          </div>
        )}
        {/*
          The one fact that decides whether any of this reaches the LEDs. It is
          a warning rather than an explanation: the effect list is on the same
          screen, so what to do about it is a click away and does not need
          describing. It is only ever shown while the keys are what the colour
          control writes — on an effect that mixes its own colour, the control
          is that colour and there is nothing here to warn about.
        */}
        {global?.lighting && !perKeyLive && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">
              <T k="light.notCustom" />
            </Notice>
          </div>
        )}
      </>
    ),
    picked,
    typed,
    none,
    onType: setTyped,
    onPick: choose,
    onClear: () => paint(UNLIT),
  }

  /*
   * One section, and the strip stays.
   *
   * It was two — the effect and the colours — and they were folded into one
   * settings panel because they are one effect's settings. What is left is a
   * strip that names what is under it rather than offering a choice, which is
   * what it was doing on the first of the two tabs anyway.
   */
  const sections: SubTab[] = [
    {
      id: 'effect',
      labelKey: 'light.section.effect',
      render: () => <LightEffect perKey={perKey} />,
    },
  ]

  return (
    <>
      {/*
        The caps are picked and painted, unless this board has no colour block —
        then the selection gestures go, as they do during a calibration pass,
        rather than offering a selection nothing can act on.

        There is nothing here to choose what the grid shows. It shows the frame
        the board is displaying, which is the only thing on this tab that can
        answer "what is lit" — see the note at the top of the file.
      */}
      <GridFrame
        selectable={painting}
        marquee={painting}
        top={
          painting && (
            <>
              <button
                className="primary"
                disabled={!connected || !canWrite || busy !== null || dirty === 0}
                onClick={() => void apply()}
              >
                {dirty === 0 ? t('light.apply') : t('light.applyCount', { count: dirty })}
              </button>
              <button disabled={dirty === 0 || busy !== null} onClick={() => setEdits({})}>
                {t('light.revert')}
              </button>
            </>
          )
        }
        foot={
          <>
            {/* Beside the selection count, and answering what the effect
                cards leave open: what the one you just picked is doing. */}
            {canFrame && (
              <span>
                {frame
                  ? t('light.lit', { count: litKeys.length, total: keys.length })
                  : t('light.live.waiting')}
              </span>
            )}
            <span>{readout}</span>
            {error && <span className="err">{error}</span>}
            {mismatch && <span className="err">{mismatch}</span>}
            {status && !mismatch && !error && <span>{status}</span>}
          </>
        }
      >
        <KeyGrid
          selected={painting ? sel : undefined}
          onToggle={painting ? (i, on) => selection.setSelected(i, on) : undefined}
          onHover={setHovered}
          tint={(k) => {
            const color = shownColor(k.index)
            // An unlit key is drawn as an ordinary cap rather than as black:
            // three zero bytes mean *no custom colour*, and a black cap would
            // claim the board had been told to keep that key dark.
            if (!color || isUnlit(color)) return undefined
            return { color: hexOf(color), fg: legendOn(color) }
          }}
          // The one thing the paint cannot say: a pending key is not yet the
          // colour it is drawn in. The dot inherits the legend colour, so it
          // stays readable whatever the cap was painted.
          sub={(k) => (painting && edits[k.index] !== undefined ? <span>●</span> : undefined)}
        />
      </GridFrame>

      {canRead ? (
        <SubTabs
          tabs={sections}
          label={t('light.sections')}
          active="effect"
          onActive={() => {}}
        />
      ) : (
        /*
         * A board whose spec names no colour command keeps the effect settings —
         * the two are different blocks and one being undecoded says nothing
         * about the other — and gets the usual notice for the half it lacks.
         */
        <>
          <LightEffect />
          <Panel title={t('light.title')}>
            <NotDecoded what="light.title" />
          </Panel>
        </>
      )}
    </>
  )
}
