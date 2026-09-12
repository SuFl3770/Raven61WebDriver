import type { CSSProperties, ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { useDeviceSpec } from '../device/active'
import type { LightEffectSpec } from '../device/spec'
import { supports } from '../protocol/codec'
import { hexOf, parseHex, type Rgb } from '../protocol/keyRgb'
import {
  LIGHT_CONTROL,
  LIGHT_LIMITS,
  applyLightingPatch,
  effectOf,
  supportsControl,
  type LightingPatch,
} from '../protocol/lighting'
import { RAVEN61_LIGHT_EFFECT_LABELS } from '../device/boards/raven61/lighting'
import { useGlobalSettings } from '../state/global'
import { useCodec, useConnection } from '../state/link'
import { boardSync, useSyncState } from '../state/sync'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { useHeldWrites } from '../ui/useHeldWrites'
import { Slider } from '../ui/Slider'

/**
 * The board-wide lighting effect: which one runs, and its four parameters.
 *
 * These nine bytes live in the **settings block** — the one 0x05 reads and
 * 0x06 writes — so this panel is not a new transport. It is a patch on a block
 * the app already reads, writes and verifies, which is why it needs no apply
 * button and no undo: every change is a read-modify-write that reads the block
 * back and compares the bytes, exactly as the polling rate and the bottom-out
 * trigger do. See `protocol/lighting.ts` for the field layout and where it came
 * from, and `global.ts` for the write.
 *
 * Two things it does differently from the stock driver, both because it can:
 *
 *   - **It shows what the board holds, not what a database remembers.** The
 *     stock page reads brightness, speed, direction and colour out of its own
 *     SQLite copy and only ever writes them to the keyboard; there is no
 *     read-back path for those bytes in the driver at all. The board answers
 *     for all nine, so this reads them off the hardware and a board configured
 *     elsewhere shows up as it is.
 *   - **It offers only what the effect uses.** Every effect declares which
 *     controls it has (`LightEffectSpec.supports`, the stock table's
 *     `config_func`), and a control an effect ignores is hidden rather than
 *     left to send a byte with no effect — which would read as a broken slider.
 *
 * The direction toggle is labelled neutrally on purpose. The stock page swaps
 * in one of four label pairs depending on the effect — Within/Outside,
 * Clockwise/Anticlockwise and two more — and which of its four `config_func`
 * bits selects which pair is not established. A neutral pair of arrows says
 * what the byte does without claiming the wrong words for it.
 *
 * There is **one colour control**, and what it writes depends on the effect.
 * The board has two colours and they are never both live: `color` is the
 * effect's own byte in the settings block, `perKey` is the 384-byte colour
 * block, and the effect table gives no row both bits — bit 5 is on every effect
 * that mixes its own colour and bit 8 is on Custom Light alone. Two pickers
 * side by side, one of them inert, was this app inventing a choice the firmware
 * does not offer. So the row is one row: it says **팔레트** and writes the
 * effect's byte where the effect has one, and **색** and paints the selected
 * keys where it does not. The presets serve whichever it is.
 *
 * The colours sit at the top of the panel, over the brightness slider, because
 * on Custom Light they are what the panel is opened for.
 */

/**
 * Somewhere to start, and the primaries in one click.
 *
 * Not a palette with a claim behind it: the lighting block's factory defaults
 * sit in code flash and have never been dumped, so there is no "board colours"
 * to offer. These are the corners of the cube plus white — enough to make the
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

/** The vendor's own name for an effect, translated where we have the key. */
function effectLabel(effect: LightEffectSpec, t: (k: MessageKey) => string): string {
  const key = RAVEN61_LIGHT_EFFECT_LABELS[effect.mode]
  return key ? t(key) : effect.name
}

export function LightEffect({
  perKey,
}: {
  /**
   * The keys as a colour target, or nothing on a board with no colour block.
   *
   * The selection, the pending edits and the block they are written to all live
   * in the tab above; what this panel owns is the one control they share with
   * the effect's own colour, and which of the two it is pointed at.
   */
  perKey?: {
    /** Warnings about the colour block, shown while the keys are the target. */
    notices?: ReactNode
    /** The colour last chosen, as `#rrggbb` — what the picker shows. */
    picked: string
    /** What is in the hex box, which is not a colour yet while it is typed. */
    typed: string | null
    /** Nothing is selected: the controls stay put and do nothing. */
    none: boolean
    /** The hex box changed, or was left (`null`). */
    onType: (text: string | null) => void
    /** A colour was chosen: paint the selection with it. */
    onPick: (color: Rgb) => void
    /** Put the selection back to no custom colour. */
    onClear: () => void
  }
}) {
  const codec = useCodec()
  const spec = useDeviceSpec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()
  /*
   * The controls that move are dragged, so they hold the write until release —
   * one block rewrite per pixel is what this is for, and a block rewrite here
   * carries a settle delay. See `useHeldWrites` and `applyGlobal`.
   */
  const held = useHeldWrites()
  // What has been dragged but not sent yet. Without it every control would read
  // its value back out of the board's last reply and refuse to move.
  const pending = useSyncState().pendingGlobal?.lighting

  const canRead = supports(codec, 'readGlobalSettings')
  const canWrite = supports(codec, 'writeGlobalSettings')
  const effects = spec.lightEffects

  /*
   * Three different "no": the board's protocol has no settings block, its spec
   * does not place the lighting bytes inside it, and nobody has read its effect
   * table. All three land on the same notice, because from here they are the
   * same fact — this app cannot say what this board's lighting is.
   */
  if (!canRead || !effects || effects.length === 0) {
    return (
      <Panel title={t('light.fxPanel.title')}>
        <NotDecoded what="light.effect.what" />
        <div className="small dim" style={{ marginTop: 10 }}>
          <T k="light.effect.body" />
        </div>
      </Panel>
    )
  }

  // The board's own values with the unsent edit laid over them — which is what
  // every control below shows, and what the next write will make true.
  const onBoard = global?.lighting ?? null
  const lighting = onBoard === null ? null : applyLightingPatch(onBoard, pending)
  const current = lighting === null ? undefined : effectOf(effects, lighting.mode)
  const disabled = !connected || lighting === null || !canWrite

  const apply = (patch: LightingPatch) => void boardSync.applyGlobal({ lighting: patch })

  const has = (control: number) => supportsControl(current, control)

  /**
   * Whether this effect has a parameter of its own under the colours.
   *
   * The colour is not one of them any more — it moved to the top of the panel
   * and shares its row with the stored colours — so an effect whose only
   * control is `color` would leave nothing here. None do: every row with bit 5
   * carries brightness too.
   */
  const hasParams =
    lighting !== null &&
    (has(LIGHT_CONTROL.brightness) ||
      has(LIGHT_CONTROL.speed) ||
      has(LIGHT_CONTROL.direction) ||
      has(LIGHT_CONTROL.colorful))

  /**
   * What the colour control writes, or null when there is nothing to write.
   *
   * The effect's own byte wherever the effect mixes its own colour; the keys
   * otherwise. "Otherwise" covers Custom Light, which is the point, and it also
   * covers the effects that read neither — Spectrum, Hundred Flowers, off —
   * where the keys are still worth painting for the effect you switch to next.
   * The warning that says so is `perKey.notices`.
   */
  const target: 'palette' | 'keys' | null = has(LIGHT_CONTROL.color)
    ? 'palette'
    : perKey
      ? 'keys'
      : null

  /** The colour the picker opens on, which is always a real colour. */
  const baseHex =
    target === 'palette' && lighting !== null ? hexOf(lighting.color) : (perKey?.picked ?? '#000000')
  /** What the hex box holds: what is being typed, or the colour itself. */
  const hexText = perKey?.typed ?? baseHex
  const hexBad = perKey != null && perKey.typed !== null && parseHex(perKey.typed) === null
  const colorDisabled =
    target === 'palette' ? disabled || (lighting?.colorful ?? false) : (perKey?.none ?? true)

  /** Send a chosen colour wherever this effect reads its colour from. */
  const pick = (color: Rgb) => {
    if (target === 'palette') apply({ color })
    else perKey?.onPick(color)
  }

  return (
    /*
     * Picker on the left, the effect's own settings on the right.
     *
     * They are one subject read in one direction — pick an effect, then set it
     * up — and stacked they put the settings a scroll below the card that was
     * just clicked, so the thing the click changed was off screen at the moment
     * it changed. Side by side the parameters sit beside the grid and move
     * under the pointer. Below the breakpoint `.fx-cols` is a plain block and
     * the two panels stack in the order they are written, which is the same
     * order.
     */
    <div className="fx-cols">
      <Panel title={t('light.fxPanel.title')}>
        {lighting === null && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">{t('light.fxPanel.unread')}</Notice>
          </div>
        )}

        {/*
          A grid of effects rather than a dropdown, for the reason the switch
          picker is one: there are two dozen, they never change while the app is
          running, and a menu hides the list behind a click. The one the board is
          on is the accent card — the same "this is what the hardware holds"
          the rest of the app uses.
        */}
        <div className="fxgrid">
          {effects
            .filter((e) => e.selectable !== false)
            .map((e) => (
              <button
                key={e.mode}
                className={e.mode === lighting?.mode ? 'fxcard on' : 'fxcard'}
                aria-pressed={e.mode === lighting?.mode}
                disabled={disabled}
                onClick={() => apply({ lightMode: e.mode })}
              >
                <span className="fxname">{effectLabel(e, t)}</span>
                <span className="fxmode mono small dim">{e.mode}</span>
              </button>
            ))}
        </div>

        {/*
          The mode the board reports that this table has no row for.
          Not folded into the grid: a card for it would invite a click that
          writes a value nothing here can explain.
        */}
        {lighting !== null && current === undefined && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">{t('light.fxPanel.unknownMode', { mode: lighting.mode })}</Notice>
          </div>
        )}
      </Panel>

      {/*
        The settings, and only the ones this effect has. An effect with none —
        the off row — gets no panel rather than an empty one, which is what "off
        has no settings" should look like. Unless the section brought its own
        colours: those are settings too, and they do not stop being editable
        because the running effect is one that ignores them.
      */}
      {(target !== null || hasParams) && (
          <Panel title={t('light.fxPanel.params')}>
            {/*
              One colour row, pointed at whichever colour this effect reads —
              see `target`. Over the sliders rather than under them: on Custom
              Light it is what the panel is opened for, and the effect's own
              parameters are what you reach for after. The rule under it is
              drawn only when something follows, since a rule with nothing below
              reads as something that failed to load.
            */}
            {target !== null && (
              <>
                {target === 'keys' && perKey?.notices}

                <div className="row" style={{ alignItems: 'center' }}>
                  <span className="small dim" style={{ width: 72 }}>
                    {target === 'palette' ? t('light.palette') : t('light.color')}
                  </span>
                  {/*
                    Held like the sliders. The native picker is an OS dialog, so
                    the release lands when it opens rather than when it closes —
                    what stops the drag inside it from queueing a write per frame
                    is the coalescing in `applyGlobal`, not this. Kept anyway,
                    because it does cover the swatch's own click.
                  */}
                  <input
                    type="color"
                    {...held}
                    disabled={colorDisabled}
                    value={baseHex}
                    onChange={(e) => {
                      const color = parseHex(e.target.value)
                      if (color) pick(color)
                    }}
                    style={{ width: 56, height: 30, padding: 2 }}
                  />
                  {/*
                    The same colour as text, because a colour picked on one
                    keyboard is a value someone wants to type into another — and
                    because the native picker cannot be read out loud. A board
                    with no colour block has nowhere to keep what is half-typed,
                    so there it stays a readout.
                  */}
                  {perKey ? (
                    <input
                      type="text"
                      disabled={colorDisabled}
                      value={hexText}
                      spellCheck={false}
                      aria-label={t('light.hex')}
                      className="mono"
                      onChange={(e) => {
                        perKey.onType(e.target.value)
                        const parsed = parseHex(e.target.value)
                        if (parsed) pick(parsed)
                      }}
                      onBlur={() => perKey.onType(null)}
                      style={{ width: 100 }}
                    />
                  ) : (
                    <span className="mono small">{baseHex}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {target === 'keys' && perKey && (
                    <button disabled={perKey.none} onClick={perKey.onClear}>
                      {t('light.clear')}
                    </button>
                  )}
                  {/*
                    Greyed while `colorful` is on rather than hidden: the byte is
                    still there and still written, and the reason it does nothing
                    right now is the checkbox below — which is worth being able
                    to see and undo.
                  */}
                  {target === 'palette' && lighting?.colorful && (
                    <span className="small dim">{t('light.colorOverridden')}</span>
                  )}
                </div>

                {hexBad && (
                  <div className="small dim" style={{ marginTop: 6 }}>
                    <T k="light.hexInvalid" />
                  </div>
                )}

                <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
                  <span className="small dim" style={{ width: 72 }}>
                    {t('light.preset')}
                  </span>
                  <div className="swatches">
                    {PRESETS.map((color) => (
                      <button
                        key={hexOf(color)}
                        className="accent-swatch"
                        disabled={colorDisabled}
                        // As the accent picker does it: the swatch is the
                        // control, and what the dot is filled with is the
                        // stylesheet's call.
                        style={{ '--swatch': hexOf(color) } as CSSProperties}
                        aria-label={hexOf(color)}
                        title={hexOf(color)}
                        onClick={() => pick(color)}
                      />
                    ))}
                  </div>
                </div>

                {hasParams && <hr className="panel-sep" />}
              </>
            )}
            {lighting !== null && (
              <>
                {has(LIGHT_CONTROL.brightness) && (
                  <div className="row" style={{ alignItems: 'center' }}>
                    <span className="small dim" style={{ width: 72 }}>
                      {t('light.brightness')}
                    </span>
                    <Slider
                      {...held}
                      disabled={disabled}
                      min={0}
                      max={LIGHT_LIMITS.brightnessMax}
                      step={1}
                      value={lighting.brightness}
                      onChange={(e) => apply({ brightness: Number(e.target.value) })}
                      style={{ flex: '1 1 200px' }}
                    />
                    <span className="mono small" style={{ width: 44, textAlign: 'right' }}>
                      {lighting.brightness}%
                    </span>
                  </div>
                )}

                {has(LIGHT_CONTROL.speed) && (
                  <div className="row" style={{ alignItems: 'center', marginTop: 10 }}>
                    <span className="small dim" style={{ width: 72 }}>
                      {t('light.speed')}
                    </span>
                    {/*
                      Five steps, not a percentage: the firmware reads this byte as
                      a period and rejects anything above 4 (it rewrites it to 2),
                      so a finer slider would offer values the board would not keep.
                    */}
                    <Slider
                      {...held}
                      disabled={disabled}
                      min={0}
                      max={LIGHT_LIMITS.speedMax}
                      step={1}
                      value={lighting.speed}
                      onChange={(e) => apply({ speed: Number(e.target.value) })}
                      style={{ flex: '1 1 200px' }}
                    />
                    <span className="mono small" style={{ width: 44, textAlign: 'right' }}>
                      {lighting.speed} / {LIGHT_LIMITS.speedMax}
                    </span>
                  </div>
                )}

                {has(LIGHT_CONTROL.direction) && (
                  <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
                    <span className="small dim" style={{ width: 72 }}>
                      {t('light.direction')}
                    </span>
                    <button
                      className={lighting.direction ? '' : 'primary'}
                      aria-pressed={!lighting.direction}
                      disabled={disabled}
                      onClick={() => apply({ direction: false })}
                    >
                      {t('light.dir.a')}
                    </button>
                    <button
                      className={lighting.direction ? 'primary' : ''}
                      aria-pressed={lighting.direction}
                      disabled={disabled}
                      onClick={() => apply({ direction: true })}
                    >
                      {t('light.dir.b')}
                    </button>
                  </div>
                )}

                {has(LIGHT_CONTROL.colorful) && (
                  <label className="row" style={{ marginTop: 12 }}>
                    <input
                      type="checkbox"
                      checked={lighting.colorful}
                      disabled={disabled}
                      onChange={(e) => apply({ colorful: e.target.checked })}
                    />
                    <span>{t('light.colorful')}</span>
                  </label>
                )}

              </>
            )}
          </Panel>
        )}
    </div>
  )
}
