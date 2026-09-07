/**
 * The Raven61's lighting effects — which effects the board has, and which of
 * the four effect controls each one actually uses.
 *
 * The rows live in `lighting.json` beside this file; what is left here is the
 * type, the label keys and the provenance. Same split as `switches.ts`, for
 * the same reasons — the table copies into a user's `*.device.json`, and the
 * footnotes stay in a file that can hold sentences.
 *
 * ## Where the table came from
 *
 * The stock driver keeps its own copy of this table in SQLite, one row per
 * effect per profile, and this is that table:
 *
 *     SELECT * FROM t_light_data WHERE profile = ? AND mode = ?
 *
 * — the statement at `0x57632c`, run by `0x4076d0`, which is the loader the
 * settings-write path calls before it builds its packet. `mode` is the row key
 * and it is the value that goes on the wire; `name` is a **language-string id**
 * into `language/*.lan`, which is where the effect names below come from
 * (`661`-`684`, and the "off" row carries `0` for no string at all).
 *
 * So the names are the vendor's own, in the vendor's own two languages. Where
 * the English and Korean disagree — `Constant Ripple` against 파동, `Single
 * point` against 단일 파동, `Grid` against 폭발 — the disagreement is theirs
 * and both are carried as given rather than reconciled by us.
 *
 * ## `supports` is `config_func`, and its bits are not guessed
 *
 * `config_func` in that table decides which controls the stock driver's
 * lighting page shows for the selected effect, and `0x4310c0` is the code that
 * reads it. Each bit gates a `MControl::SetVisible` on a named control group,
 * and two of them settle their own meaning by the value they push in next to
 * the show:
 *
 *     0x4310c0  test al, 1     -> show two controls, SetProgress(struct+0x10)
 *     0x43117c  test al, 2     -> show two controls, SetLevelValue(struct+0x14)
 *     0x431416  test al, 0x20  -> show one control, SetLightModeColor(struct+0x24)
 *
 * and `struct+0x10` / `+0x14` / `+0x24` are `brightness` / `speed` /
 * `color_value`, because the loader above stores SQLite column *n* at
 * `struct + 4n` and those are columns 4, 5 and 9. So bit 0 is brightness,
 * bit 1 is speed and bit 5 is the colour — read off the same instructions that
 * draw the stock UI, not inferred from which effects look like they need what.
 *
 * Bits 2, 3, 6 and 7 each show a *different pair* of radio buttons, and no
 * effect sets more than one of them: they are the direction toggle, with the
 * pair of labels depending on the effect (the strings include `Within` /
 * `Outside` and `Clockwise` / `Anticlockwise`). Which bit means which pair is
 * **not** established here, so `LIGHT_CONTROL.direction` is their union and the
 * app labels the toggle neutrally rather than claiming a wrong pair.
 *
 * Bit 4 is `colorful`, and bit 8 appears only on Custom Light — the effect that
 * paints from the per-key colour block (see `protocol/keyRgb.ts`), where the
 * stock page offers its own editor instead of a single colour.
 *
 * ## The two rows that are not ordinary effects
 *
 * `mode 255` is the off row. It is what the stock driver's own read-back
 * produces for anything out of range — `0x429300` clamps `>= 23` to `255` —
 * and the firmware's renderers have nothing for it.
 *
 * `mode 128` is Musical Rhythm, and it is `selectable: false`. It is a real
 * firmware mode with a real row, but that same clamp means the stock driver can
 * never send it through this path, and it drives the music layer, which this
 * project has not decoded. Carried as data, kept out of the picker — the same
 * treatment `switches.ts` gives a name with nothing behind it.
 */

import type { LightEffectSpec } from '../../spec'
import type { MessageKey } from '../../../i18n'
import table from './lighting.json'

export const RAVEN61_LIGHT_EFFECTS: readonly LightEffectSpec[] = table.lightEffects

/**
 * Translation keys for the effect names, by mode.
 *
 * Built-in boards only, exactly as `DeviceSpec.labelKey` works: `MessageKey` is
 * derived from the reference bundle at compile time, so a table loaded from a
 * user's JSON cannot name a key that exists and falls back to `name`. The
 * strings behind these keys are the vendor's own translations, lifted from
 * `language/1042.lan` by the string ids the table's `name` column holds.
 */
export const RAVEN61_LIGHT_EFFECT_LABELS: Readonly<Record<number, MessageKey>> = {
  0: 'light.fx.custom',
  1: 'light.fx.spectrum',
  2: 'light.fx.staircase',
  3: 'light.fx.static',
  4: 'light.fx.breathing',
  5: 'light.fx.flowers',
  6: 'light.fx.wave',
  7: 'light.fx.updown',
  8: 'light.fx.fountain',
  9: 'light.fx.galaxy',
  10: 'light.fx.rotation',
  11: 'light.fx.tide',
  12: 'light.fx.seawave',
  13: 'light.fx.ripple',
  14: 'light.fx.constantRipple',
  15: 'light.fx.singlePoint',
  16: 'light.fx.grid',
  17: 'light.fx.piano',
  18: 'light.fx.flowing',
  19: 'light.fx.rain',
  20: 'light.fx.starlight',
  21: 'light.fx.fireworks',
  22: 'light.fx.waveBand',
  128: 'light.fx.music',
  255: 'light.fx.off',
}
