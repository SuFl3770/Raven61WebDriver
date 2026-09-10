import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { useDeviceSpec } from '../device/active'
import type { LightEffectSpec } from '../device/spec'
import { supports } from '../protocol/codec'
import { hexOf, parseHex } from '../protocol/keyRgb'
import {
  LIGHT_CONTROL,
  LIGHT_LIMITS,
  effectOf,
  supportsControl,
  type LightingPatch,
} from '../protocol/lighting'
import { RAVEN61_LIGHT_EFFECT_LABELS } from '../device/boards/raven61/lighting'
import { useGlobalSettings } from '../state/global'
import { useCodec, useConnection } from '../state/link'
import { boardSync } from '../state/sync'
import { Notice, NotDecoded, Panel } from '../ui/Panel'
import { useHeldWrites } from '../ui/useHeldWrites'

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
 */

/** The vendor's own name for an effect, translated where we have the key. */
function effectLabel(effect: LightEffectSpec, t: (k: MessageKey) => string): string {
  const key = RAVEN61_LIGHT_EFFECT_LABELS[effect.mode]
  return key ? t(key) : effect.name
}

export function LightEffect() {
  const codec = useCodec()
  const spec = useDeviceSpec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()
  // Brightness and speed are dragged, so they hold the write until release —
  // one block rewrite per pixel is what this is for. See useHeldWrites.
  const held = useHeldWrites()

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

  const lighting = global?.lighting ?? null
  const current = lighting === null ? undefined : effectOf(effects, lighting.mode)
  const disabled = !connected || lighting === null || !canWrite

  const apply = (patch: LightingPatch) => void boardSync.applyGlobal({ lighting: patch })

  const has = (control: number) => supportsControl(current, control)

  return (
    <>
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
        {lighting !== null && current !== undefined && has(LIGHT_CONTROL.perKey) && (
          <div style={{ marginTop: 10 }}>
            <Notice kind="info">
              <T k="light.fxPanel.perKey" />
            </Notice>
          </div>
        )}
      </Panel>

      {/*
        The parameters, in their own panel and only the ones this effect has.
        An effect with none — the off row — gets no panel rather than an empty
        one, which is what "off has no settings" should look like.
      */}
      {lighting !== null &&
        (has(LIGHT_CONTROL.brightness) ||
          has(LIGHT_CONTROL.speed) ||
          has(LIGHT_CONTROL.direction) ||
          has(LIGHT_CONTROL.colorful) ||
          has(LIGHT_CONTROL.color)) && (
          <Panel title={t('light.fxPanel.params')}>
            {has(LIGHT_CONTROL.brightness) && (
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="small dim" style={{ width: 72 }}>
                  {t('light.brightness')}
                </span>
                <input
                  type="range"
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
                <input
                  type="range"
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
                <span className="small dim">
                  <T k="light.dir.note" />
                </span>
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
                <span className="small dim">
                  <T k="light.colorfulHint" />
                </span>
              </label>
            )}

            {has(LIGHT_CONTROL.color) && (
              <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
                <span className="small dim" style={{ width: 72 }}>
                  {t('light.palette')}
                </span>
                <input
                  type="color"
                  disabled={disabled || lighting.colorful}
                  value={hexOf(lighting.color)}
                  onChange={(e) => {
                    const color = parseHex(e.target.value)
                    if (color) apply({ color })
                  }}
                  style={{ width: 56, height: 30, padding: 2 }}
                />
                <span className="mono small">{hexOf(lighting.color)}</span>
                {/*
                  Greyed while `colorful` is on rather than hidden: the byte is
                  still there and still written, and the reason it does nothing
                  right now is the checkbox above — which is worth being able to
                  see and undo.
                */}
                {lighting.colorful && (
                  <span className="small dim">{t('light.colorOverridden')}</span>
                )}
              </div>
            )}

            {/*
              The raw nine bytes. Every settings panel in this app shows the
              block it edits, and this one has the most reason to: a field here
              was misread once as something else entirely, and the numbers are
              what let the next person check rather than trust.
            */}
            {global && (
              <div className="small dim" style={{ marginTop: 12 }}>
                <T
                  k="light.fxPanel.raw"
                  params={{ bytes: rawLighting(global.raw), index: lighting.colorIndex }}
                />
              </div>
            )}
          </Panel>
        )}
    </>
  )
}

/** `payload[16..24]` as hex, which is the whole of what this panel writes. */
function rawLighting(raw: ArrayLike<number>): string {
  const out: string[] = []
  for (let i = 16; i <= 24; i++) out.push((raw[i] ?? 0).toString(16).padStart(2, '0'))
  return out.join(' ')
}
