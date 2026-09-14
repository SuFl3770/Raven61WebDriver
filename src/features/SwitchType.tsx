import { useT } from '../i18n'
import { T } from '../i18n/T'
import { useLayout } from '../device/active'
import { selectableSwitchTypes, switchColor, switchTypeInfo } from '../device/tables'
import { configStore, useKeyConfigs, useLastRead } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { Notice, Panel } from '../ui/Panel'

/**
 * Which magnetic switch each key has fitted — `switch_type`, the low 5 bits of
 * the perf record's first byte.
 *
 * It sits above actuation and rapid trigger because it is what their
 * millimetres are measured against: the types the board knows span 3.32 to 4.00
 * mm of travel, so the same 1.5 mm actuation is a different fraction of the
 * stroke depending on this one value. Choosing a type the board does not
 * physically have does not break the board, but it makes every depth this app
 * shows wrong.
 *
 * Only the type is edited. Bits 5-7 of the same byte are carried straight back
 * from the read (see KeyPerfRecord.switchFlags) — their meaning is unknown, and
 * inventing them would be a write we cannot justify.
 *
 * ## The shape of the panel
 *
 * Two things, and no prose between them:
 *
 *   - **Cards, not a menu.** A handful of types that never change while the app
 *     runs were behind a click and a second click, so comparing two travels
 *     meant opening the list twice. Laid out in a fixed grid of equal cards —
 *     maker, name, magnet and travel, with the switch's colour down the leading
 *     edge — they are also the legend for the bands on the caps above.
 *   - **A readout that follows the pointer.** The caps show the switch as a
 *     colour, which is recognisable but not readable, so hovering one spells it
 *     out here. With nothing hovered it falls back to what the *selection*
 *     holds, which is the value the cards are about to overwrite.
 *
 * What is offered is `selectableSwitchTypes()`, which today is the whole table:
 * the one entry that named a part nobody could find has been dropped from the
 * board's definition (see `boards/raven61/switches.ts`). The flag stays in the
 * schema, so a board that ships a name with nothing behind it still keeps it
 * out of this grid — and a value the table has no entry for at all is reported
 * as exactly that, rather than being quietly overwritten.
 */

/** One value if the targets agree, null if they do not. */
function commonType(
  configs: readonly { switchType?: number }[],
  targets: readonly number[],
): number | null {
  const first = configs[targets[0] ?? 0]?.switchType
  if (first === undefined) return null
  return targets.every((i) => configs[i]?.switchType === first) ? first : null
}

export function SwitchType() {
  const { keys } = useLayout()
  const configs = useKeyConfigs()
  const lastRead = useLastRead()
  const sel = useSelection()
  const t = useT()

  const targets = targetKeys(sel)
  /** Nothing selected: the buttons stay put but do nothing — see Actuation. */
  const none = targets.length === 0
  /*
   * Nothing targeted means nothing to show, not "whatever key 0 happens to
   * hold" — which is what `commonType` returns for an empty list, and what a
   * card lit as chosen would then be claiming about a selection that does not
   * exist.
   */
  const pending = none ? null : commonType(configs, targets)

  // Targets are read at event time, not render time — see the note in Actuation.
  const setType = (value: number) =>
    configStore.update(targetKeys(selection.current()), (c) => ({ ...c, switchType: value }))


  /** Keys whose actuation no longer fits the switch they are now set to. */
  const tooDeep = keys.filter((k) => {
    const c = configs[k.index]
    const travel = switchTypeInfo(c?.switchType)?.travelMm
    return c !== undefined && travel !== undefined && c.actuationMm > travel
  })

  /** A value the board holds that this table has no name for. */
  const unknown = [...new Set(configs.map((c) => c.switchType))].filter(
    (v): v is number => v !== undefined && switchTypeInfo(v) === undefined,
  )

  return (
    <Panel title={t('switch.title')} hintKey="inputPoint.hint.switch">
      {lastRead === null && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="warn">{t('switch.unread')}</Notice>
        </div>
      )}

      <div className="small dim" style={{ marginBottom: 8 }}>{t('switch.select')}</div>
      <div className="switch-picker">
        {selectableSwitchTypes().map((s) => (
          <button
            key={s.value}
            type="button"
            className="switch-card"
            disabled={none}
            aria-pressed={pending === s.value}
            onClick={() => setType(s.value)}
          >
            {/* The switch's colour, the same mark as the band on the caps. */}
            <span className="bar" style={{ background: switchColor(s.value) }} aria-hidden="true" />
            <span className="text">
              {/* Rendered whether or not there is a maker, so the names of two
                  cards side by side sit on the same line. */}
              <span className="vendor">{s.vendor ?? ''}</span>
              <span className="name">{s.name}</span>
              <span className="spec">
                {s.magnetGauss !== undefined && `${t('switch.magnet', { gauss: s.magnetGauss })} `}
                {t('switch.mm', { travel: s.travelMm.toFixed(2) })}
              </span>
            </span>
          </button>
        ))}
      </div>


      {unknown.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">{t('switch.unknownValue', { value: unknown.join(', ') })}</Notice>
        </div>
      )}

      {tooDeep.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">
            <T k="switch.deeper" params={{ count: tooDeep.length }} />
            <div className="small dim" style={{ marginTop: 4 }}>
              {tooDeep.map((k) => k.label).join(', ')}
            </div>
          </Notice>
        </div>
      )}

    </Panel>
  )
}
