import { useT, type MessageKey } from '../i18n'
import { T } from '../i18n/T'
import { DEFAULT_TRAVEL_MM, RAVEN61_KEYS } from '../keyboard/raven61'
import { MM_PER_COUNT, mmToCounts, quantizeMm } from '../protocol/encoding'
import { switchTypeInfo, type KeyConfig } from '../protocol/types'
import { configStore, useBaseline, useKeyConfigs, useLastRead } from '../state/config'
import { selection, targetKeys, useSelection } from '../state/selection'
import { Notice, Panel } from '../ui/Panel'
import { useHeldWrites } from '../ui/useHeldWrites'

/** 1.5mm is the board's factory default (global_key_actuation = 75). */
const PRESETS: { labelKey: MessageKey; value: number }[] = [
  { labelKey: 'actuation.preset.fast', value: 0.5 },
  { labelKey: 'actuation.preset.default', value: 1.5 },
  { labelKey: 'actuation.preset.deep', value: 2.5 },
]

/**
 * Full travel of the switch a key has fitted.
 *
 * Not a constant: the board reports switch_type per key, and the stock driver's
 * own table gives five different strokes across the eight types (2.50 to 4.00
 * mm). A slider that always ran to 4 mm would offer depths a 2.5 mm switch
 * cannot reach.
 */
function travelOf(config: KeyConfig | undefined): number {
  return switchTypeInfo(config?.switchType)?.travelMm ?? DEFAULT_TRAVEL_MM
}

/** The shallowest travel among the targets — the deepest all of them can reach. */
function travelLimit(configs: readonly KeyConfig[], targets: readonly number[]): number {
  let min = Infinity
  for (const i of targets) min = Math.min(min, travelOf(configs[i]))
  return Number.isFinite(min) ? min : DEFAULT_TRAVEL_MM
}

/** One value if the targets agree, null if they do not. */
function commonActuation(
  configs: readonly KeyConfig[],
  targets: readonly number[],
): number | null {
  const first = configs[targets[0] ?? 0]?.actuationMm
  if (first === undefined) return null
  return targets.every((i) => configs[i]?.actuationMm === first) ? first : null
}

export function Actuation() {
  const configs = useKeyConfigs()
  const base = useBaseline()
  const lastRead = useLastRead()
  const sel = useSelection()
  const t = useT()
  // The slider and the spinners move while held; see useHeldWrites.
  const held = useHeldWrites()

  const targets = targetKeys(sel)
  const limit = travelLimit(configs, targets)
  const pending = commonActuation(configs, targets)
  const onBoard = commonActuation(base, targets)
  const first = configs[targets[0] ?? 0]

  // Targets are read at event time, not render time: a click and the slider
  // move that follows must not disagree about what is selected.
  const setActuation = (mm: number) =>
    configStore.update(targetKeys(selection.current()), (c) => ({
      ...c,
      // The board stores whole 0.02 mm counts; snap so the UI cannot show a
      // value the hardware would silently round. Clamped to the switch's own
      // travel rather than to a nominal 4 mm.
      actuationMm: Math.min(quantizeMm(mm), travelOf(c)),
    }))

  const tooDeep = RAVEN61_KEYS.filter((k) => {
    const c = configs[k.index]
    return c !== undefined && c.actuationMm > travelOf(c)
  })

  // The value the controls sit on. With mixed targets there is no single one,
  // so the first target's value stands in — moving the slider then makes them
  // agree, which is what the edit means anyway.
  const shown = pending ?? first?.actuationMm ?? 0
  /**
   * Nothing selected: the controls stay on screen but do nothing.
   *
   * Disabled rather than hidden, so the panel does not rearrange itself around
   * an empty selection — and so it is plain that there is a setting here and a
   * reason it cannot be touched yet. The selection column carries that reason.
   */
  const none = targets.length === 0

  return (
    <Panel title={t('actuation.title')}>

      {lastRead === null && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="warn">{t('actuation.unread')}</Notice>
        </div>
      )}


      <div className="row" style={{ marginTop: 16 }}>
        <input
          type="range"
          {...held}
          disabled={none}
          min={MM_PER_COUNT}
          max={limit}
          step={MM_PER_COUNT}
          value={shown}
          onChange={(e) => setActuation(Number(e.target.value))}
          style={{ flex: '1 1 260px' }}
        />
        <input
          type="number"
          {...held}
          disabled={none}
          min={MM_PER_COUNT}
          max={limit}
          step={MM_PER_COUNT}
          value={shown}
          onChange={(e) => setActuation(Number(e.target.value))}
          style={{ width: 90 }}
        />
        <span className="dim small">
          {t('actuation.counts', {
            counts: mmToCounts(shown),
            step: MM_PER_COUNT,
            travel: limit.toFixed(2),
          })}
        </span>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        {PRESETS.map((p) => (
          <button
            key={p.value}
            disabled={none || p.value > limit}
            onClick={() => setActuation(p.value)}
          >
            {t(p.labelKey, { mm: p.value.toFixed(1) })}
          </button>
        ))}
      </div>

      {/*
        Board value next to the pending one. Without it the slider shows a
        number with no way to tell whether it is what the hardware holds or an
        edit waiting to be applied — and the whole point of reading the board on
        entry was to stop showing values that only exist in this app.
      */}
      <div className="row" style={{ marginTop: 12, alignItems: 'baseline' }}>
        <span className="small dim">{t('actuation.target', { count: targets.length })}</span>
        <span className="small">
          <span className="dim">{t('actuation.board')} </span>
          <b className="mono">{onBoard === null ? t('actuation.mixed') : onBoard.toFixed(2)}</b>
        </span>
        {pending !== onBoard && (
          <span className="small">
            <span className="dim">→ {t('actuation.pending')} </span>
            <b className="mono" style={{ color: 'var(--warn)' }}>
              {pending === null ? t('actuation.mixed') : pending.toFixed(2)}
            </b>
          </span>
        )}
      </div>

      <div className="small dim" style={{ marginTop: 6 }}>
        <T k="actuation.travelNote" params={{ travel: limit.toFixed(2) }} />
      </div>

      {tooDeep.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="warn">
            {t('actuation.deeperThanTravel', { count: tooDeep.length })}
            <div className="small dim" style={{ marginTop: 4 }}>
              {tooDeep.map((k) => k.label).join(', ')}
            </div>
          </Notice>
        </div>
      )}
    </Panel>
  )
}
