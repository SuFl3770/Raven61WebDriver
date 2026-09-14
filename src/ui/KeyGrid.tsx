import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useActiveDevice, useLayout } from '../device/active'
import type { KeyDef } from '../device/spec'
import { useT } from '../i18n'
import { kindKey, kindOfType, type AdvancedKind } from '../protocol/advancedKeys'
import { useBand } from './GridFrame'
import { legendFor, useLegends } from '../state/legends'
import type { KeymapEntry } from '../protocol/types'

import { useConnection } from '../state/link'

export interface KeyGridProps {
  selected?: ReadonlySet<number>
  /**
   * Pick one key. Plain click, no drag — for the panels that bind or inspect a
   * single key rather than editing a set.
   */
  onSelect?: (index: number) => void
  /**
   * Multi-select: click toggles a key, and dragging across the grid paints.
   *
   * Given instead of `onSelect`. `on` is what the key should become — for a
   * click that is simply the opposite of its current state, and for a drag it
   * is whatever the key the drag *started* on became, so one gesture either
   * selects a run of keys or clears one, and never alternates as it crosses
   * keys that disagree.
   */
  onToggle?: (index: number, on: boolean) => void
  /** 0…1 travel fill drawn from the bottom of the cap — used by the monitor. */
  fill?: (key: KeyDef) => number
  /**
   * Secondary line inside the cap (actuation value, keycode, …).
   *
   * Markup rather than a string because some of these are a pair — rapid
   * trigger's press and release — and the two halves are told apart by colour,
   * which a string cannot carry.
   */
  sub?: (key: KeyDef) => ReactNode
  /** Extra class for that line — `pair` when it holds two numbers. */
  subClass?: string
  /**
   * A name for what the second line is *about* — the metric, the layer.
   *
   * The grid stays mounted while a tab switches between its sections, so the
   * line's text is swapped in place and sixty-one numbers change between two
   * frames with nothing to say that they are now measuring something else.
   * Naming it makes the line a new element whenever the meaning changes,
   * which is what replays its fade — see `cap-info-in` in styles.css.
   *
   * It has to be a *name*, not the value: a key that changed every time the
   * board was read would rebuild the line under a calibration pass sixty
   * times a second.
   */
  subKey?: string
  /**
   * A name for what the *legend* is about, when that can change under the grid.
   *
   * `subKey` for the first line. Only one grid needs it: the overview's, where
   * a strip in the band picks the layer and every cap is then naming what it
   * sends on a different one. Without it eighty-seven names are rewritten
   * between two frames, which is the one kind of change a cap cannot make
   * quietly — a legend is the thing a reader uses to find a key, and finding
   * them all renamed with no motion at all reads as a redraw rather than an
   * answer.
   *
   * Left off everywhere else on purpose. The legend is normally the key's own
   * name and is the same name on the tab just left, and a name that fades in
   * reads as a name that changed — see `cap-info-in` in styles.css.
   */
  legendKey?: string
  /**
   * The second line is a live reading, not a setting.
   *
   * It changes what happens when a cap starts having something to say: the
   * line is simply there, rather than the room for it opening under the
   * legend. A quarter of a second is right for a value that changed because
   * somebody changed it, and wrong for one that changed because a key moved
   * — the answer to "what is this key reading" must not arrive late.
   *
   * Only the arrival. A reading that stops is still allowed to leave the way
   * every other line does, and the room it was taking to close behind it —
   * nothing is waiting on that.
   */
  subLive?: boolean
  /**
   * A thin band along the bottom edge of the cap, as a CSS background.
   *
   * For a value that is a *category* rather than a quantity — which switch is
   * fitted, today. A category has no business being a number on a cap: "S4"
   * has to be looked up, is the same width as the actuation value it replaces,
   * and 61 of them is a page of codes. A colour is recognised without being
   * read, and the panel below spells out whatever the pointer is on.
   *
   * A background rather than a colour so the caller can hand over a gradient —
   * `var(--hatch)` is the app's "known to be unknown", and it has to mean the
   * same thing here as it does on the swatch beside a switch's name.
   */
  stripe?: (key: KeyDef) => string | undefined
  /**
   * The whole cap painted a colour, with a legend colour to read it against.
   *
   * For the lighting tab, where the colour *is* the setting: a stripe along the
   * bottom edge says "this key is in category blue", and what a lighting tab
   * has to show is a keyboard that looks the way the keyboard looks. So this
   * covers the cap.
   *
   * The caller supplies `fg` rather than the grid deriving it, because only the
   * caller knows the colour as numbers — a CSS string can be anything, and a
   * legend that guesses wrong is white text on yellow. See `luminanceOf` in
   * protocol/keyRgb.ts.
   */
  tint?: (key: KeyDef) => { color: string; fg: string } | undefined
  /**
   * The key under the pointer, or undefined on the way out.
   *
   * Only a report. The grid does not draw anything differently for it — the
   * cap already lights on hover — and nothing about the selection changes.
   */
  onHover?: (index: number | undefined) => void
  /**
   * Per-key condition, drawn as a border colour.
   *
   * A border rather than a fill or a label: the cap already carries both, and
   * this has to be readable at a glance across 61 keys without displacing the
   * value being edited.
   *
   * `done` is drawn as well as the two warnings, which is a deliberate
   * exception to "a key that is fine looks like a key". During a calibration
   * pass the whole grid is the progress display, and "this one is finished" is
   * the thing being waited for — a green cap and an untouched cap have to be
   * distinguishable. Outside a pass nothing passes `done`.
   */
  status?: (key: KeyDef) => 'done' | 'marginal' | 'bad' | undefined
  /**
   * Replaces the cap's legend.
   *
   * Return `undefined` for a key with nothing of the caller's own to say, and
   * the cap falls back to the legend every other grid shows — the binding, or
   * the board's printing when the two agree. Returning `''` blanks the cap,
   * which is a different thing and almost never the one wanted.
   */
  label?: (key: KeyDef) => string | undefined
  /**
   * Draw the advanced-key band along the bottom edge of the caps that run one.
   *
   * `true` is "answer it yourself", from the base layer the legend store holds.
   * It is what keeps the band still while tabs are switched between: the store
   * is read once per connection and is already there, so there is no moment
   * where a tab has arrived and its own answer has not.
   *
   * A callback is a grid that shows one layer at a time saying which. The store
   * only holds the base layer, and its band would be wrong the moment the Fn
   * layer is opened — so the three tabs with a layer strip all pass one. Every
   * one of them falls back to `true` until its own read has landed, rather than
   * to nothing: a band that vanished for the length of a read is the flicker
   * this is arranged to avoid.
   *
   * Omitted on the grids that are about something else: what the switch under
   * the key is, what the key is lit, what the sensor under it reads. A band
   * there is a fact from another tab painted over the one being edited — and on
   * two of them it would be painted over the setting itself, which is the cap's
   * own colour and the stripe along the same edge.
   */
  advanced?: true | ((key: KeyDef) => AdvancedKind | undefined)
  /**
   * Draw the board's own printing, ignoring the keymap.
   *
   * For the grids that are about the key as a piece of hardware rather than as
   * something that types: the debug tab's event grid binds a sensor to a
   * physical key, and the remap tab carries the binding on the cap's second
   * line so that the first can stay the thing being remapped *from*. See
   * `state/legends.ts` for what the rest of the app shows instead.
   */
  physical?: boolean
  /**
   * The keymap the caps read against, instead of the shared store's.
   *
   * The store holds the base layer and only the base layer — see
   * state/legends.ts — which is the right answer on every grid that is not
   * choosing a layer. The overview's grid is: its strip picks one, and on the
   * Fn layer every cap that is remapped there would otherwise go on reading
   * what it sends on layer 0.
   *
   * The legend is still worked out here rather than handed over as text, so a
   * layer's remapped caps get the same accent the base layer's do — see
   * `legendFor`, which is the one place that decides when the board's printing
   * survives. Undefined falls back to the store, which is what every other
   * grid wants and what this one wants until its read has landed.
   */
  legends?: readonly (KeymapEntry | undefined)[]
}

/**
 * What one cap is *saying* about the setting, which is not the same as what
 * the caller returns for it this render.
 *
 * Neither the band nor the second line can be transitioned to nothing: the
 * moment a section stops painting one, the caller stops naming it and there
 * is nothing left on the element to animate. So both are kept after the
 * caller has let go, drawn on their way out under a class that takes them off
 * the cap — see `.keycap .stripe.gone` and `.sub-slot.shut` in styles.css.
 *
 * The second line needs one thing more. Three things happen to it and no two
 * of them want the same element: a line whose *subject* changed — the same
 * cap, now measuring something else — should be a new element, so the value
 * fades in rather than being rewritten where it stands; a line going away
 * should be the *same* element, because a new one cannot leave; and a line
 * arriving where there was none should be the same element too, so the room
 * opens under the legend rather than appearing under it. So the id changes on
 * the first of those and holds still for the other two.
 */
interface CapSaid {
  /** The band's colour, kept after it stops being painted. */
  band?: string
  /** Whether the band is on the cap, rather than on its way off it. */
  banded: boolean
  /** The second line's text, kept for the same reason as the colour. */
  text?: ReactNode
  /** Whether that line has anything to say at the moment. */
  saying: boolean
  /** The advanced key's band, kept after the cap stops running one. */
  adv?: AdvancedKind
  /** Whether that band is on the cap, rather than on its way off it. */
  advOn: boolean
  /** What it is about, so a change of subject reads differently to a new value. */
  about?: string
  /** Which element is showing it — see the note above. */
  id: number
}

/**
 * The band's caps, remembered across the tab switch that rebuilds them.
 *
 * Module scope for the same reason `bandOnScreen` in ui/GridFrame.tsx is: the
 * thing being remembered outlives every element that could hold it. Emptied
 * by the first grid to arrive where there was none, which is the only moment
 * at which what is in here could belong to a different keyboard.
 */
const BAND_SAID = new Map<number, CapSaid>()

const PAD = 0.06 // gap between caps, in keyboard units

export function KeyGrid({
  selected,
  onSelect,
  onToggle,
  fill,
  sub,
  subClass,
  subKey,
  subLive,
  stripe,
  tint,
  onHover,
  label,
  status,
  advanced,
  physical,
  legends,
  legendKey,
}: KeyGridProps) {
  // The board's own key table and size in units. A different keyboard is a
  // different grid, and nothing here knows which one it is drawing.
  const { keys, units } = useLayout()
  const { matched, forced } = useActiveDevice()
  const { device, connected } = useConnection()
  /* The base layer, so a remapped key reads as what it now sends. Empty until
     something has read it, and on every board that cannot be asked — and
     overridden by a caller that is drawing a layer of its own. */
  const store = useLegends()
  const entries = legends ?? store
  const t = useT()
  /** What the in-progress drag is painting, or null when none is running. */
  const painting = useRef<boolean | null>(null)
  /** Where the pointer was at the previous move, so the gap can be filled in. */
  const last = useRef<{ x: number; y: number } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  /*
   * What each cap is saying, and how — see `CapSaid`.
   *
   * A tab switch rebuilds the grid, so a per-grid memory would be thrown away
   * at exactly the moment it is needed: the caps carrying a value on the tab
   * being left have to keep it long enough to put it down. The band's memory
   * therefore outlives the band, and only the band's — the debug tab draws a
   * second grid of its own, and two grids sharing one memory would each keep
   * finding the other's values where their own should be.
   */
  const band = useBand()
  const own = useRef(new Map<number, CapSaid>())
  const saidOn = band ? BAND_SAID : own.current
  /*
   * Whether this grid is done arriving.
   *
   * A grid replacing another one is built showing what that one was showing,
   * and only then told what it is actually for — in two steps rather than
   * one, so that what changed has a state to change *from*. Without it the
   * caps would be new elements already holding their final values, and a new
   * element has nothing to transition from.
   *
   * A grid arriving where there was none has nothing to carry on from, so it
   * skips the extra frame and drops whatever the last board's grid left here.
   */
  const [settled, setSettled] = useState(() => {
    if (!band) return true
    if (band.arriving) BAND_SAID.clear()
    return band.arriving
  })
  useLayoutEffect(() => {
    if (settled) return
    /*
     * Measured, and the measurement thrown away. A transition starts when a
     * property changes between two of the browser's own style calculations,
     * and these caps were built moments ago in the same task — asking for
     * their geometry is what forces the first calculation, so that the
     * change made on the next line is a change *from* something.
     *
     * Not a frame later. Waiting on `requestAnimationFrame` would read
     * better and be wrong: a window that is not being drawn — a background
     * tab — never runs one, and the grid would sit there showing the values
     * of the tab before it until somebody looked at it again.
     */
    grid.current?.getBoundingClientRect()
    setSettled(true)
  }, [settled])

  /**
   * The drag is tracked by hit-testing the pointer rather than by listening for
   * `pointerenter` on each cap.
   *
   * Because the grid captures the pointer on the way down. That is what makes
   * the gesture survive leaving the grid and coming back, and guarantees the
   * `pointerup` that ends it — but a captured pointer sends every event to the
   * capturing element, so the caps themselves stop hearing about it.
   */
  const keyUnder = (x: number, y: number): number | undefined => {
    const el = document.elementFromPoint(x, y)
    const cap = el?.closest<HTMLElement>('.keycap')
    const index = cap?.dataset.key
    return index === undefined ? undefined : Number(index)
  }

  const startPaint = (e: React.PointerEvent, index: number) => {
    if (!onToggle) return
    // Left button only: a right-click is the context menu, and a middle-click
    // paste has no business changing the selection.
    if (e.button !== 0) return
    const on = !selected?.has(index)
    painting.current = on
    last.current = { x: e.clientX, y: e.clientY }
    onToggle(index, on)
    // After the toggle, never before: capture throws when the pointer is
    // already gone, and losing it must not lose the click as well.
    try {
      grid.current?.setPointerCapture(e.pointerId)
    } catch {
      // The drag still paints inside the grid without it.
    }
  }

  /**
   * Paints every key between the last pointer position and this one.
   *
   * Hit-testing only where the pointer happens to land drops keys, because
   * pointer samples are as far apart as the pointer moved between them: flick
   * across a row and the row comes out with gaps in it. Walking the segment in
   * steps of half a cap closes them, and costs nothing on a slow drag where the
   * two points are already in the same cap.
   */
  const paintAt = (e: React.PointerEvent) => {
    if (painting.current === null || !onToggle) return
    const on = painting.current
    const from = last.current ?? { x: e.clientX, y: e.clientY }
    const dx = e.clientX - from.x
    const dy = e.clientY - from.y
    // One keyboard unit wide, halved — narrow enough that no cap fits between
    // two samples, and it follows the grid when the window resizes.
    const step = Math.max(4, (grid.current?.clientWidth ?? 0) / units.width / 2)
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step))
    for (let i = 1; i <= steps; i++) {
      const index = keyUnder(from.x + (dx * i) / steps, from.y + (dy * i) / steps)
      if (index !== undefined) onToggle(index, on)
    }
    last.current = { x: e.clientX, y: e.clientY }
  }

  const endPaint = (e: React.PointerEvent) => {
    painting.current = null
    last.current = null
    if (grid.current?.hasPointerCapture(e.pointerId)) {
      grid.current.releasePointerCapture(e.pointerId)
    }
  }

  /**
   * Which advanced key a cap runs, or nothing on a grid that does not say.
   *
   * The caller's answer when it gave a callback, the base layer's when it asked
   * for one — see the `advanced` prop.
   */
  const advancedOf = (key: KeyDef): AdvancedKind | undefined => {
    if (!advanced) return undefined
    if (advanced !== true) return advanced(key)
    const binding = entries[key.index]?.binding
    return binding?.kind === 'advanced' ? kindOfType(binding.type) : undefined
  }

  /*
   * A keyboard no spec claims gets no grid.
   *
   * The layout store falls back to a placeholder board so the rest of the app
   * has a shape to work with, and drawing that placeholder here would be this
   * app's worst lie: 61 caps, laid out like a real keyboard, for hardware whose
   * key count nobody knows. The ids are shown instead, because they are what a
   * definition needs — see src/device/README.md.
   */
  if (connected && !matched && !forced) {
    const hex = (n: number) => n.toString(16).padStart(4, '0')
    return (
      <div className="keygrid-unknown">
        <b>{t('keygrid.unknown.title')}</b>
        <div className="small dim" style={{ marginTop: 6 }}>
          {t('keygrid.unknown.body')}
        </div>
        {device && (
          <div className="mono small" style={{ marginTop: 6 }}>
            {hex(device.vendorId)}:{hex(device.productId)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={grid}
      /*
       * `flagged` means the caps are carrying a per-key state on their edge,
       * which today is only a calibration pass. `painted` means their colour
       * is the board's rather than this app's — the lighting tab, and only it.
       * Both are derived from the callback that does the drawing rather than
       * passed in, so the grid cannot be told it is showing something while no
       * cap has it.
       */
      className={`keygrid${onToggle ? ' selectable' : ''}${status ? ' flagged' : ''}${
        tint ? ' painted' : ''
      }`}
      /*
       * The board's own proportions. Every cap inside is placed as a percentage
       * of `units`, so the one thing left that has to know the shape is the box
       * they are placed in — and the stylesheet cannot, because it is the same
       * stylesheet for every board. It carried 15/5 until a board that is not
       * 15 by 5 turned up, and squashed it.
       */
      style={{ aspectRatio: `${units.width} / ${units.height}` }}
      role="group"
      aria-label={t('keygrid.label')}
      onPointerMove={onToggle ? paintAt : undefined}
      onPointerUp={onToggle ? endPaint : undefined}
      onPointerCancel={onToggle ? endPaint : undefined}
      /*
        Leaving any cap for the gap between caps would otherwise leave the last
        one reported, so the grid clears it rather than each cap clearing its
        own.
      */
      onPointerLeave={onHover ? () => onHover(undefined) : undefined}
    >
      {keys.map((k) => {
        const style = {
          left: `${((k.x + PAD) / units.width) * 100}%`,
          top: `${((k.y + PAD) / units.height) * 100}%`,
          width: `${((k.w - PAD * 2) / units.width) * 100}%`,
          height: `${((1 - PAD * 2) / units.height) * 100}%`,
        }
        const amount = fill?.(k) ?? 0
        const paint = tint?.(k)
        /*
          What this cap is saying. Left exactly as the grid before it left it
          until this one has settled — a frame later, when what it is actually
          for is put on and the difference is something the cap can animate.
        */
        let cap = saidOn.get(k.index)
        if (settled) {
          const colour = stripe?.(k)
          const text = sub?.(k)
          const saying = Boolean(text)
          const adv = advancedOf(k)
          // A line already saying something about a different subject is
          // replaced rather than rewritten.
          const turned = cap?.saying === true && saying && cap.about !== subKey
          cap = {
            // The colour outlives the painting of it, and the text outlives
            // the caller's returning of it: both are what is drawn leaving.
            band: colour ?? cap?.band,
            banded: colour !== undefined,
            text: saying ? text : cap?.text,
            saying,
            about: saying ? subKey : cap?.about,
            id: (cap?.id ?? 0) + (turned ? 1 : 0),
            // The kind outlives the running of it, for the same reason the
            // stripe's colour does: a band cannot leave with nothing on it.
            adv: adv ?? cap?.adv,
            advOn: adv !== undefined,
          }
          saidOn.set(k.index, cap)
        }
        const state = status?.(k)
        const stateClass = state ? ` ${state}` : ''
        const isSelected = selected?.has(k.index) ?? false
        /*
          The caller's legend wins outright — including the decision that a cap
          should be blank — and only a cap it had nothing to say about asks what
          the key sends.
        */
        const given = label?.(k)
        const legend =
          given === undefined && !physical
            // Entries of the caller's own are a layer above the base one — that is
            // the only reason to pass them — and an Fn layer's never-set keys are
            // not unbound keys. See `legendFor`.
            ? legendFor(k, entries, legends === undefined)
            : undefined
        return (
          <button
            key={k.index}
            type="button"
            data-key={k.index}
            className={`keycap${isSelected ? ' selected' : ''}${stateClass}${
              paint ? ' tinted' : ''
            }${legend?.remapped ? ' remapped' : ''}`}
            /*
              The tint goes on the cap itself rather than on a layer inside it,
              so a selected cap keeps its accent edge and the legend inherits a
              colour that can be read against the paint. A layer would have had
              to sit under the label and above the fill, and there is nothing
              for it to be under here — a lit key has no travel bar.
            */
            style={paint ? { ...style, background: paint.color, color: paint.fg } : style}
            aria-pressed={isSelected}
            /* The printing stays in the tooltip whatever the cap reads, because
               it is how the key is pointed at out loud — "the one where Caps
               Lock is". */
            title={`#${k.index} ${k.label}`}
            onPointerDown={onToggle ? (e) => startPaint(e, k.index) : undefined}
            onPointerEnter={onHover ? () => onHover(k.index) : undefined}
            /*
              Focus reports too: a cap reached by tab is the one being asked
              about, and without this the readout below stays on whatever the
              pointer last touched.
            */
            onFocus={onHover ? () => onHover(k.index) : undefined}
            onBlur={onHover ? () => onHover(undefined) : undefined}
            onClick={(e) => {
              // The pointer path already ran on the way down. A click with no
              // pointer behind it (`detail === 0`) is the keyboard activating
              // the focused cap, which is the only case left to handle.
              if (onToggle) {
                if (e.detail === 0) onToggle(k.index, !isSelected)
                return
              }
              onSelect?.(k.index)
            }}
          >
            {amount > 0 && <span className="fill" style={{ height: `${Math.min(1, amount) * 100}%` }} />}

            {/* Always drawn, even with nothing to say — see `lastBand`. An
                empty one is transparent and covers nothing. */}
            <span
              className={`stripe${cap?.banded ? '' : ' gone'}`}
              style={cap?.band ? { background: cap.band } : undefined}
            />
            {/*
              The advanced key's band, drawn and hidden the same way the stripe
              above it is: always on the cap, pushed out through the bottom edge
              when the key is not running one. The word goes inside the fill
              rather than beside it — six kinds is more than a colour can carry
              on its own — and the legend does not move over for it, so a row of
              caps reads level whether or not they are bound.
            */}
            <span
              className={`advband${cap?.advOn ? '' : ' gone'}${
                cap?.adv ? ` advband-${cap.adv}` : ''
              }`}
            >
              {cap?.adv ? t(kindKey(cap.adv)) : null}
            </span>
            {/*
              Keyed only where a caller said the legend can change meaning —
              see `legendKey`. A new key is a new element, which is what
              replays the fade; with no key the span is reused and the text is
              simply swapped, which is what every other grid wants.
            */}
            <span
              key={legendKey}
              className={`cap-label${legendKey === undefined ? '' : ' relegend'}`}
            >
              {given ?? legend?.text ?? k.label}
            </span>
            {/*
              Always here, the way the two bands above it are, even on the caps
              and in the sections where there is nothing to put on it — an empty
              slot is a closed slot, and it is the slot opening and closing that
              moves the legend gently rather than in one step. See `.sub-slot`
              in styles.css for how a row of no height is animated to the height
              of its contents.

              Unconditional rather than `sub &&`, which is what it was. A tab
              that gives no second line at all — the advanced-key one — dropped
              the element outright, so the cap it was replacing had nothing left
              to close: 87 legends fell 7px in a single frame on the way in from
              the input-point tab. The carry in `CapSaid` cannot help with that,
              because what it keeps is what the slot *says* and the slot was
              gone. So it stays, shut and empty, and the tab it is leaving gets
              its exit.
            */}
            <span
              className={`sub-slot${subLive ? ' at-once' : ''}${cap?.saying ? '' : ' shut'}`}
              /*
                A shut slot is clipped to nothing, but the text it is holding
                on its way out is still in the tree — and the cap is a button,
                so that text is part of its name. Without this a cap on the
                advanced-key tab announces as "Esc 1.50": the actuation value
                the input-point tab left behind, read out on a tab that is not
                about actuation. Hidden while shut, on the way out and after.
              */
              aria-hidden={!cap?.saying}
            >
              <span key={cap?.id ?? 0} className={`sub cap-label${subClass ? ` ${subClass}` : ''}`}>
                {cap?.text}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
