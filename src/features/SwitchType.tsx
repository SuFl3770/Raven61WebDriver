import { useT } from '../i18n'
import { T } from '../i18n/T'
import { RAVEN61_KEYS } from '../keyboard/raven61'
import {
  SELECTABLE_SWITCH_TYPES,
  SWITCH_TYPES,
  switchTypeInfo,
  switchTypeName,
} from '../protocol/types'
import { configStore, useBaseline, useKeyConfigs, useLastRead } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { Notice, Panel } from '../ui/Panel'

/**
 * Which magnetic switch each key has fitted — `switch_type`, the low 5 bits of
 * the perf record's first byte.
 *
 * It sits above actuation and rapid trigger because it is what their
 * millimetres are measured against: the eight types the stock driver knows span
 * 2.50 to 4.00 mm of travel, so the same 1.5 mm actuation is a different
 * fraction of the stroke depending on this one value. Choosing a type the board
 * does not physically have does not break the board, but it makes every depth
 * this app shows wrong.
 *
 * Only the type is edited. Bits 5-7 of the same byte are carried straight back
 * from the read (see KeyPerfRecord.switchFlags) — their meaning is unknown, and
 * inventing them would be a write we cannot justify.
 *
 * The list offered is SELECTABLE_SWITCH_TYPES, not all eight: one entry in the
 * driver's table is not a switch that exists. A value already on the board is
 * still shown and still written back unchanged; it just cannot be chosen.
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
  const configs = useKeyConfigs()
  const base = useBaseline()
  const lastRead = useLastRead()
  const sel = useSelection()
  const t = useT()

  const targets = targetKeys(sel)
  /** Nothing selected: the control stays put but does nothing — see Actuation. */
  const none = targets.length === 0
  const pending = commonType(configs, targets)
  const onBoard = commonType(base, targets)

  // Targets are read at event time, not render time — see the note in Actuation.
  const setType = (value: number) =>
    configStore.update(targetKeys(selection.current()), (c) => ({ ...c, switchType: value }))

  /** Keys whose actuation no longer fits the switch they are now set to. */
  const tooDeep = RAVEN61_KEYS.filter((k) => {
    const c = configs[k.index]
    const travel = switchTypeInfo(c?.switchType)?.travelMm
    return c !== undefined && travel !== undefined && c.actuationMm > travel
  })

  /** A value the board holds that this table has no name for. */
  const unknown = [...new Set(configs.map((c) => c.switchType))].filter(
    (v): v is number => v !== undefined && switchTypeInfo(v) === undefined,
  )

  const phantoms = SWITCH_TYPES.filter((s) => !s.selectable)
  /** A non-existent type the board is actually reporting. */
  const phantomOnBoard = phantoms.find((s) => configs.some((c) => c.switchType === s.value))

  return (
    <Panel title={t('switch.title')}>
      <div className="small dim" style={{ marginBottom: 10 }}>
        <T k="switch.intro" />
      </div>


      {lastRead === null && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="warn">{t('switch.unread')}</Notice>
        </div>
      )}


      <div className="row" style={{ marginTop: 16 }}>
        <span className="small dim">{t('switch.select')}</span>
        <select
          disabled={none}
          value={pending ?? ''}
          onChange={(e) => setType(Number(e.target.value))}
          style={{ minWidth: 260 }}
        >
          {pending === null && <option value="">{t('switch.mixed')}</option>}
          {/*
            A non-selectable type the board already holds is listed as disabled
            rather than hidden: the select would otherwise show a blank while
            the board plainly has a value, which reads as "unset".
          */}
          {pending !== null && switchTypeInfo(pending)?.selectable === false && (
            <option value={pending} disabled>
              {pending} · {switchTypeName(pending)}
            </option>
          )}
          {SELECTABLE_SWITCH_TYPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value} · {s.name} — {t('switch.travel', { travel: s.travelMm.toFixed(2) })}
            </option>
          ))}
        </select>
        <span className="small dim">{t('switch.target', { count: targets.length })}</span>
      </div>

      {/*
        Board value beside the pending one, the same way actuation shows it: a
        select on its own cannot say whether what it displays is what the
        hardware holds or an edit waiting to be applied.
      */}
      <div className="row" style={{ marginTop: 12, alignItems: 'baseline' }}>
        <span className="small">
          <span className="dim">{t('switch.board')} </span>
          <b className="mono">{onBoard === null ? t('switch.mixed') : switchTypeName(onBoard)}</b>
        </span>
        {pending !== onBoard && (
          <span className="small">
            <span className="dim">→ {t('switch.pending')} </span>
            <b className="mono" style={{ color: 'var(--warn)' }}>
              {pending === null ? t('switch.mixed') : switchTypeName(pending)}
            </b>
          </span>
        )}
      </div>

      <div className="small dim" style={{ marginTop: 6 }}>
        <T k="switch.flagsNote" />
      </div>

      {phantoms.length > 0 && (
        <div className="small dim" style={{ marginTop: 6 }}>
          <T k="switch.phantom" params={{ names: phantoms.map((s) => s.name).join(', ') }} />
        </div>
      )}

      {phantomOnBoard && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">
            <T k="switch.phantomOnBoard" params={{ name: phantomOnBoard.name }} />
          </Notice>
        </div>
      )}

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
