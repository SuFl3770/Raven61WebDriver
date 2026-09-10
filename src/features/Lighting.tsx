import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { useDeviceSpec, useLayout } from '../device/active'
import { supports } from '../protocol/codec'
import { UNLIT, hexOf, isUnlit, luminanceOf, parseHex, sameRgb, type Rgb } from '../protocol/keyRgb'
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
 * Two subjects, two sections, one grid above them. They were one page and it
 * read as two pages stacked; splitting them the way the input-point tab splits
 * its panels keeps the keyboard in one place rather than redrawing it under
 * each half.
 *
 *   - **Effect** is nine bytes of the board-wide settings block — the one 0x05
 *     reads and 0x06 writes. See `features/LightEffect.tsx` and
 *     `protocol/lighting.ts`.
 *   - **Per-key colour** is its own 384-byte block at flash 0x20f00, read with
 *     0x0a and written with 0x0b. See `protocol/keyRgb.ts`.
 *
 * The two meet at one place, and it is worth knowing about: the stored colours
 * are what **Custom Light** paints. Every other effect generates its own
 * colours and ignores the block. That is why this tab names the connection
 * rather than leaving someone to paint 61 keys and wonder — and it is the
 * answer to a question that was open here until the effect table was decoded.
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
 *   - **"Stored" and "on the board now" are two views, not one.** The stored
 *     layer is flash; the live frame is the RAM buffer the effect engine
 *     rewrites, with the firmware's calibration overlay on top. They disagree
 *     for good reasons, and only the live one answers "what is lit".
 */

/**
 * Somewhere to start, and the primaries in one click.
 *
 * Not a palette with a claim behind it: this block's factory defaults sit in
 * code flash and have never been dumped, so there is no "board colours" to
 * offer. These are the corners of the cube plus white — enough to make the
 * picker usable without pretending to be evidence.
 */
const PRESETS: readonly Rgb[] = [
  { r: 255, g: 255, b: 255 },
  { r: 255, g: 0, b: 0 },
  { r: 255, g: 128, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 255, b: 255 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
]

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
  const [view, setView] = useState<'stored' | 'live'>('stored')
  /**
   * Whether the live view keeps re-reading, or holds the frame it has.
   *
   * On by default, because a view called "on the board now" that needed a
   * button press to be now would be a worse lie than not having it. Off is for
   * reading a single frame in peace — an effect moves, and a key that is lit
   * for two frames in ten is hard to point at while the grid is changing.
   */
  const [watching, setWatching] = useState(true)
  /**
   * Which half of the tab is open.
   *
   * The grid stays above it either way. Only the per-key section has anything
   * to select in the grid, so the selection gestures follow the section.
   */
  const [section, setSection] = useState('effect')
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
  const live = view === 'live'
  /** True while the grid is a painting surface rather than a readout. */
  const painting = !live && section === 'perkey'

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

  /** One frame, for the moments the watch is off. */
  const readFrame = async () => {
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
  }

  /*
   * While the live view is open, keep reading the frame.
   *
   * This is the stock driver's own behaviour — its worker reads the LED frame
   * every time its job queue is empty (docs §3.0) — and it is what makes the
   * view answer "which keys are lit" rather than "which keys were lit when you
   * pressed the button". The cadence and the one-read-at-a-time rule belong to
   * the codec, not here; see `watchLightFrame` in protocol/engine.ts.
   *
   * `cancelled` rather than only the stop function: the watch reads the slot
   * map before its first frame, so the panel can be left — or the view switched
   * back — while the promise is still outstanding, and the stop it eventually
   * hands over would then arrive after nothing is listening.
   *
   * A failure turns the watch off and shows why, instead of retrying. The
   * button it turns off is the retry.
   */
  useEffect(() => {
    if (!live || !watching || !connected || !canWatch || !codec.watchLightFrame) return
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
  }, [live, watching, connected, canWatch, codec])

  /** The colour a key shows: the pending edit if there is one, else the board's. */
  const shownColor = (index: number): Rgb | undefined => {
    if (live) return frame?.entries[index]?.color
    return edits[index] ?? stored?.entries[index]?.color
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
      // Dropping it beats showing it beside a colour it predates.
      setFrame(null)
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
  const hexText = typed ?? picked
  const hexBad = typed !== null && parseHex(typed) === null
  const unmapped = stored ? keys.filter((k) => stored.entries[k.index]?.slot === undefined) : []

  /**
   * Where the slot mapping came from, for whichever block is on screen.
   *
   * Both views need it and for the same reason: every colour here is addressed
   * by slot, so a guessed map puts the right colours on the wrong caps. Written
   * with the performance tab's own strings rather than a second set — the fact
   * is the board's, not that tab's, and two translations of it could drift.
   */
  const slotMapOf = live ? frame?.slotMap : stored?.slotMap
  const slotMapNote = slotMapOf ? (
    <span className="small dim">
      {t('perf.slotMap.label')}{' '}
      {slotMapOf.source === 'keymap' ? (
        <b style={{ color: 'var(--ok)' }}>{t('perf.slotMap.keymap')}</b>
      ) : (
        <b style={{ color: 'var(--warn)' }}>{t('perf.slotMap.guess')}</b>
      )}{' '}
      · {t('perf.slotMap.count', { resolved: slotMapOf.slotByKey.size, total: keys.length })}
    </span>
  ) : null

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
   * The readout is worded per view, because the same three zero bytes mean
   * different things in the two blocks. In the stored layer they are *no custom
   * colour*, a setting that is absent; in the live frame they are an LED the
   * firmware is not driving right now. Reading "no custom colour" off a frame
   * would be this tab's own confusion, printed back at the user.
   *
   * The empty state differs for a plainer reason: there is nothing to select
   * unless the per-key section is open, so telling someone to drag across the
   * caps is otherwise an instruction that does nothing.
   */
  const hoveredKey = hovered === undefined ? undefined : keys.find((k) => k.index === hovered)
  const hoveredColor = hovered === undefined ? undefined : shownColor(hovered)
  const readout = !hoveredKey
    ? t(painting ? 'light.pickNone' : 'light.hoverNone')
    : !hoveredColor || isUnlit(hoveredColor)
      ? t(live ? 'light.hoveredOff' : 'light.pickedUnlit', { key: hoveredKey.label })
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
  const perKeyEffect = spec.lightEffects?.find((e) => supportsControl(e, LIGHT_CONTROL.perKey))

  /** The per-key colour section. */
  const perKeyPanels = (
    <>
      <Panel title={t('light.title')}>
        {/* A notice is something a panel holds rather than something stacked on
            the page, so the ones that belong to the grid live at the top of the
            first panel under it — the way the other tabs do it. */}
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

        <div className="row" style={{ alignItems: 'center' }}>
          <span className="small dim">{t('light.color')}</span>
          <input
            type="color"
            disabled={none}
            value={picked}
            onChange={(e) => choose(parseHex(e.target.value) ?? UNLIT)}
            style={{ width: 56, height: 30, padding: 2 }}
          />
          {/*
            The same colour as text, because a colour picked on one keyboard is
            a value someone wants to type into another — and because the native
            picker cannot be read out loud.
          */}
          <input
            type="text"
            disabled={none}
            value={hexText}
            spellCheck={false}
            aria-label={t('light.hex')}
            className="mono"
            onChange={(e) => {
              setTyped(e.target.value)
              const parsed = parseHex(e.target.value)
              if (parsed) choose(parsed)
            }}
            onBlur={() => setTyped(null)}
            style={{ width: 100 }}
          />
          <span style={{ flex: 1 }} />
          <button disabled={none} onClick={() => paint(UNLIT)}>
            {t('light.clear')}
          </button>
        </div>

        {hexBad && (
          <div className="small dim" style={{ marginTop: 6 }}>
            <T k="light.hexInvalid" />
          </div>
        )}

        <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
          <span className="small dim">{t('light.preset')}</span>
          <div className="swatches">
            {PRESETS.map((color) => (
              <button
                key={hexOf(color)}
                className="accent-swatch"
                disabled={none}
                // As the accent picker does it: the swatch is the control, and
                // what the dot is filled with is the stylesheet's call.
                style={{ '--swatch': hexOf(color) } as CSSProperties}
                aria-label={hexOf(color)}
                title={hexOf(color)}
                onClick={() => choose(color)}
              />
            ))}
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, alignItems: 'baseline' }}>
          <span className="small dim" style={{ flex: 1 }}>
            <T k="light.clearHint" />
          </span>
          {slotMapNote}
        </div>
      </Panel>

      {/*
        Where these colours actually show up.
        This used to be a panel saying nobody knew, because nobody did: the
        block was decoded and the mode that reads it was not. It is Custom
        Light — so the honest thing now is a pointer to that effect and a button
        that switches to it.
      */}
      <Panel title={t('light.showsIn.title')}>
        {perKeyLive ? (
          <Notice kind="ok">
            <T k="light.showsIn.active" />
          </Notice>
        ) : (
          <>
            <div className="small dim">
              <T k="light.showsIn.body" />
            </div>
            {perKeyEffect && (
              <div className="row" style={{ marginTop: 10, alignItems: 'baseline' }}>
                <button
                  className="primary"
                  disabled={!connected || !global?.lighting}
                  onClick={() =>
                    void boardSync.applyGlobal({ lighting: { lightMode: perKeyEffect.mode } })
                  }
                >
                  {t('light.showsIn.switch')}
                </button>
                {global?.lighting && (
                  <span className="small dim">
                    {t('light.showsIn.current', {
                      mode: effect ? effect.name : String(global.lighting.mode),
                    })}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  )

  const sections: SubTab[] = [
    { id: 'effect', labelKey: 'light.section.effect', render: () => <LightEffect /> },
    { id: 'perkey', labelKey: 'light.section.perKey', render: () => perKeyPanels },
  ]

  return (
    <>
      {/*
        The live view is a readout, not an editor — the frame it shows is a RAM
        buffer the firmware rewrites — so the selection gestures go away with
        it, as they do during a calibration pass. So do they on the effect
        section, which has nothing to select either.
      */}
      <GridFrame
        selectable={painting}
        marquee={painting}
        top={
          <>
            <button
              className={live ? '' : 'primary'}
              aria-pressed={!live}
              onClick={() => setView('stored')}
            >
              {t('light.view.stored')}
            </button>
            <button
              className={live ? 'primary' : ''}
              aria-pressed={live}
              disabled={!canFrame}
              onClick={() => {
                setView('live')
                // Opening it is enough: the watch effect starts on the view, and
                // a board with no watch capability still gets the one-shot read
                // below. Neither is asked for by name here.
                if (!canWatch && !frame && connected) void readFrame()
              }}
            >
              {t('light.view.live')}
            </button>
            {live && canWatch && (
              <button
                className={watching ? 'primary' : ''}
                aria-pressed={watching}
                disabled={!connected}
                onClick={() => {
                  // Turning it back on clears the error that turned it off, so a
                  // stale message cannot sit under a view that is working again.
                  if (!watching) setError(null)
                  setWatching((on) => !on)
                }}
              >
                {t('light.view.watch')}
              </button>
            )}
            {live && (
              <button
                disabled={!connected || watching || busy !== null}
                onClick={() => void readFrame()}
              >
                {t('light.view.refresh')}
              </button>
            )}
            {painting && (
              <>
                <hr className="sep" />
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
            )}
          </>
        }
        foot={
          <>
            {/* In the live view the count replaces the selection count the
                frame took away, and stands where it stood. */}
            {live && (
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

      {live ? (
        <Panel title={t('light.live.title')}>
          {!frame && !error && (
            <div style={{ marginBottom: 10 }}>
              <Notice kind="warn">
                <T k={canWatch ? 'light.live.starting' : 'light.live.unread'} />
              </Notice>
            </div>
          )}
          {frame && (
            <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
              <span className="small dim">
                {t('light.lit', { count: litKeys.length, total: keys.length })}
              </span>
              {/* The names, because a colour on a cap says *that* a key is lit
                  and a list says *which* — and the two questions are asked at
                  different distances from the screen. Capped: an effect lights
                  the whole board, and 61 names is not a readout. */}
              {litKeys.length > 0 && (
                <span className="small">
                  {litKeys
                    .slice(0, 16)
                    .map((k) => k.label)
                    .join(', ')}
                  {litKeys.length > 16 && ` … +${litKeys.length - 16}`}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {slotMapNote}
            </div>
          )}
          <div className="small dim">
            <T k="light.live.body" />
          </div>
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="light.live.poll" params={{ ms: spec.keyRgb.framePollMs }} />
          </div>
        </Panel>
      ) : canRead ? (
        <SubTabs
          tabs={sections}
          label={t('light.sections')}
          active={section}
          onActive={setSection}
        />
      ) : (
        /*
         * A board whose spec names no colour command keeps the effect half —
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
