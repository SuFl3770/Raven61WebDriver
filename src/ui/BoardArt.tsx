import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { layoutOf } from '../device/layout'
import { defaultSpec } from '../device/registry'
import type { KeyDef } from '../device/spec'
import { useAttaching } from '../state/attach'

/** Gap between caps, in keyboard units. The same one `ui/KeyGrid.tsx` uses. */
const PAD = 0.06

/**
 * What the board is showing, and how long it shows it for.
 *
 * The keyboard first, with nothing written on it — that is the one of these
 * that is not an example, and it is where the round starts and comes back to.
 * Then four of the things this app puts on a cap, in the order the tabs that
 * hold them come in the rail: where the key triggers, its rapid trigger, which
 * switch is fitted, and what advanced behaviour it carries. Long enough to read
 * one and look up again, which is what someone waiting at this screen is doing.
 */
const SHOWS = ['bare', 'actuation', 'rapid', 'switch', 'advanced'] as const
type Show = (typeof SHOWS)[number]
const SHOW_MS = 3000
/**
 * How long the board takes to stop saying one thing before it says the next.
 *
 * The change is a blink rather than a swap: everything on the caps goes out
 * together, the example underneath is exchanged while there is nothing to see,
 * and it all comes back together. Has to agree with the transition on
 * `.board-cap-sub` and the bands in styles.css.
 */
const FADE_MS = 320

/**
 * The example itself.
 *
 * Made up, and it has to be: nothing is attached, so there is no board to ask
 * and nothing here may be mistaken for a reading. What keeps it honest is that
 * it is *shaped* like the real thing — a stock board's own actuation, the pair
 * of colours rapid trigger is always drawn in, the switch colours out of the
 * board's own table — so what it advertises is what the app does once there is
 * a keyboard in front of it.
 *
 * Keyed by legend rather than by index: an index belongs to one key table and
 * this draws whichever board `defaultSpec()` is. A legend that board does not
 * have simply does not light up, which is the failure that needs no handling.
 */
const ACTUATION = '1.00'

/**
 * Legends this board has two of, where the example is about the right-hand one.
 *
 * A board has two Alts, two Shifts and two Ctrls, and an example keyed by what
 * is printed on a cap reaches both. Rapid trigger on one modifier and not its
 * twin is a real thing to set, and drawing it on both says the opposite.
 */
const RIGHT_HAND = new Set(['Alt'])

/** Rapid trigger, as press and release — the pair `.sub.pair` is drawn for. */
const RAPID: Record<string, readonly [string, string]> = {
  Q: ['0.20', '0.20'],
  W: ['0.20', '0.20'],
  E: ['0.20', '0.20'],
  P: ['0.20', '0.20'],
  '[': ['0.20', '0.20'],
  ']': ['0.20', '0.20'],
  Caps: ['0.20', '0.20'],
  Enter: ['0.20', '0.20'],
  Space: ['0.20', '0.20'],
  Alt: ['0.20', '0.20'],
}

/**
 * Which switch is under which cap, as a value in the board's own table.
 *
 * Values rather than colours, so a band is the colour that board says that
 * switch is — see `boards/raven61/switches.json`. Anything not named here is
 * the one most of a board is built out of.
 */
const SWITCH_DEFAULT = 2
const SWITCH: Record<string, number> = {
  '1': 4,
  '2': 4,
  '3': 4,
  '4': 4,
  '5': 4,
  '6': 4,
  Q: 5,
  E: 5,
  X: 5,
  C: 5,
  W: 6,
  A: 6,
  S: 6,
  D: 6,
  Esc: 0,
  Tab: 0,
  Caps: 0,
  Space: 0,
}

/** The advanced-key kinds, as the cap's own band spells them. */
const ADVANCED: Record<string, string> = {
  Backspace: 'MT',
  W: 'RS',
  I: 'DKS',
  O: 'DKS',
  P: 'DKS',
  A: 'SOCD',
  S: 'RS',
  D: 'SOCD',
  Space: 'TGL',
}

/**
 * The keyboard on the connect screen.
 *
 * A picture, not a grid. `KeyGrid` is a control — it selects, it paints, it
 * carries a second line per cap and refuses to draw a board no spec claims —
 * and none of that has anything to do here, where nothing is attached yet.
 * What is left is the shape of the board, drawn from the same key table so it
 * is the keyboard this app is for rather than a stock keyboard someone drew:
 * see `device/boards/index.ts` on why `defaultSpec()` is that board.
 *
 * Decorative, so it is out of the accessibility tree entirely — the legends
 * are a picture of caps, not sixty-one words to read out before reaching the
 * one button on the screen, and what is written on them is an example rather
 * than a fact about anybody's keyboard.
 *
 * The caps breathe the whole time nothing is attached (`board-breathe`), and a
 * light crosses the board from the top edge outward each time the round comes
 * back to the bare keyboard (`board-sweep`) — both in styles.css. Each cap is
 * handed how far it is from the point that light starts at as `--phase`,
 * because that is the one thing the stylesheet cannot work out: it has no idea
 * where any cap is.
 *
 * When a board answers, the examples are put away, the board goes back to bare,
 * and the same wave runs once and far brighter while the window waits for it —
 * see state/attach.ts. Which is the point of that wave being the one that
 * greets a keyboard: whoever has been watching this screen has already seen it
 * three or four times, on a keyboard that was not there yet.
 */
export function BoardArt() {
  const spec = defaultSpec()
  const { keys, units } = layoutOf(spec.layout)
  const attaching = useAttaching()
  const [show, setShow] = useState<Show>(SHOWS[0])
  /** False for the blink between two of them — see `FADE_MS`. */
  const [saying, setSaying] = useState(true)

  /*
   * The board works through the five, and puts them away when it is being lit:
   * a keyboard has answered, and the last thing it should be greeted by is an
   * invented actuation on every cap. So the examples go out the way they
   * always do and the board is bare again for the wave — which is also the
   * board every one of those waves has crossed while nothing was attached.
   *
   * Someone who has asked for less motion gets the bare board and no cycle.
   * What the panels can do is still there to be found in the app; what that
   * preference asks for is a screen that does not change on its own.
   */
  useEffect(() => {
    if (attaching) {
      setSaying(false)
      const id = setTimeout(() => {
        setShow('bare')
        setSaying(true)
      }, FADE_MS)
      return () => clearTimeout(id)
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let swap: ReturnType<typeof setTimeout> | undefined
    const id = setInterval(() => {
      setSaying(false)
      /*
       * The exchange and the coming back are one step, which they can be
       * because every cap carries its line and its band the whole time — see
       * the markup below. Nothing is built at this moment, so there is nothing
       * that would arrive at full strength with no value to fade from, and
       * nothing here has to wait for a frame to be painted. A tab in the
       * background paints no frames at all, and a board that waited for one
       * would be a blank keyboard for as long as somebody was looking
       * elsewhere.
       */
      swap = setTimeout(() => {
        setShow((current) => SHOWS[(SHOWS.indexOf(current) + 1) % SHOWS.length]!)
        setSaying(true)
      }, FADE_MS)
    }, SHOW_MS)
    return () => {
      clearInterval(id)
      clearTimeout(swap)
    }
  }, [attaching])

  /*
   * Where the light comes on from: the top edge, in the middle — between the 6
   * and the 7 on a board whose top row is a number row.
   *
   * Distances are in keyboard units and taken from each cap's *centre*, which
   * makes the wave a circle on the screen rather than on the key table: a unit
   * is as wide as it is tall wherever the board is drawn, so the plain
   * distance between two caps is the distance the eye sees.
   */
  const origin = { x: units.width / 2, y: 0 }
  const distance = (k: KeyDef): number => Math.hypot(k.x + k.w / 2 - origin.x, k.y + 0.5 - origin.y)
  // The furthest cap, so what each one is handed runs 0 to 1 whatever the
  // board's shape.
  const span = Math.max(1, ...keys.map(distance))

  const switchColor = (value: number): string | undefined =>
    spec.switchTypes.find((s) => s.value === value)?.color

  /*
   * The rapid-trigger example against this board's own keys, by index.
   *
   * Resolved here rather than looked up per cap because of `RIGHT_HAND`: which
   * Alt is the right one is a question about the whole key table, not about
   * the cap being drawn. Rightmost wins, which is what "right-hand" means on a
   * board laid out in units from the left edge.
   */
  const rapid = useMemo(() => {
    const out = new Map<number, readonly [string, string]>()
    for (const [label, pair] of Object.entries(RAPID)) {
      const matches = keys.filter((k) => k.label === label)
      const only =
        RIGHT_HAND.has(label) && matches.length > 1
          ? matches.reduce((far, k) => (k.x > far.x ? k : far))
          : undefined
      for (const k of matches) if (!only || k === only) out.set(k.index, pair)
    }
    return out
  }, [keys])

  /**
   * What one cap has to say in the show that is running, if anything.
   *
   * `band` is the colour along the bottom edge whichever show put it there —
   * the switch's, or the advanced key's — because it is the same strip of cap
   * either way, and the same element has to draw both for the change between
   * them to be something that can fade.
   */
  const says = (
    k: KeyDef,
  ): { sub?: ReactNode; pair?: boolean; band?: string; kind?: string } => {
    // The board as it is. Nothing invented on it, and the caps say what is
    // moulded into them and no more.
    if (show === 'bare') return {}
    if (show === 'actuation') return { sub: ACTUATION }
    if (show === 'rapid') {
      const pair = rapid.get(k.index)
      if (!pair) return {}
      return {
        pair: true,
        sub: (
          <>
            <span className="press">{pair[0]}</span> <span className="release">{pair[1]}</span>
          </>
        ),
      }
    }
    if (show === 'switch') return { band: switchColor(SWITCH[k.label] ?? SWITCH_DEFAULT) }
    const kind = ADVANCED[k.label]
    return kind ? { kind, band: `var(--adv-${kind.toLowerCase()})` } : {}
  }

  return (
    /* The case the keys sit in. Its height comes from the keys, so nothing
       here has to know how tall a board is. */
    <div
      className={`board-plate${show === 'bare' ? ' bare' : ''}${attaching ? ' attaching' : ''}${
        saying ? '' : ' quiet'
      }`}
      aria-hidden="true"
    >
      <div
        className="board-keys"
        /* The board's own proportions, from its `units` — the stylesheet
           cannot hold them, because a second board would not be 15 by 5. */
        style={{ aspectRatio: `${units.width} / ${units.height}` }}
      >
        {keys.map((k) => {
          const said = says(k)
          return (
            <span
              key={k.index}
              className={`board-cap${said.kind ? ' lit' : ''}${
                said.sub === undefined ? '' : ' saying'
              }`}
              style={
                {
                  left: `${((k.x + PAD) / units.width) * 100}%`,
                  top: `${((k.y + PAD) / units.height) * 100}%`,
                  width: `${((k.w - PAD * 2) / units.width) * 100}%`,
                  height: `${((1 - PAD * 2) / units.height) * 100}%`,
                  '--phase': distance(k) / span,
                } as CSSProperties
              }
            >
              {/* Wrapped so the light comes on *behind* it — the glow is an
                  overlay on the cap, and a bare text node would be under it. */}
              <span className="board-cap-label">{k.label}</span>

              {/*
                Keyed by the show rather than left to React to reuse: a line
                that changes what it is *about* has to be a new element, or it
                swaps one number for another with nothing to say that the two
                are answers to different questions. The real grid has `subKey`
                for the same reason.
              */}
              {/*
                Both are on every cap in every show, empty when that cap has
                nothing to say. Not because they always show something — they
                are invisible with nothing in them — but because a transition
                needs the *same* element on both sides of a change: one that is
                built at the moment of the swap has no value to fade from, and
                arrives at full strength beside the ones that faded. Which is
                the jump this is replacing.
              */}
              <span className={`board-cap-sub${said.pair ? ' pair' : ''}`}>{said.sub}</span>
              <span
                className={`board-cap-band${said.kind ? ' chip' : ''}`}
                style={{ background: said.band ?? 'transparent' }}
              >
                {said.kind}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
