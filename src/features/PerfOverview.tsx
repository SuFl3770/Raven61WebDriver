import { t as translate, useT } from '../i18n'
import { T } from '../i18n/T'
import { activeLayout, useLayout } from '../device/active'
import type { KeyDef } from '../device/spec'
import { switchTypeName, travelMmFor } from '../device/tables'
import { supports } from '../protocol/codec'
import { mmToCounts } from '../protocol/encoding'
import { type KeyConfig } from '../protocol/types'
import { useDirtyKeys, useKeyConfigs } from '../state/config'
import { useGlobalSettings } from '../state/global'
import { useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * What the board currently has, for every key.
 *
 * It does not read. Opening a section reads the board (see Overview), and this
 * panel is one of those sections — a read here as well would send the same
 * blocks twice on every visit, and there is no longer a button to ask for one:
 * a report tab with a refresh button is a report that admits it might be stale.
 * When it was read is under the grid, in the band's foot.
 *
 * The byte-level half of this panel is not here either. Which slot holds which
 * key, which slots are empty, the block as hex, and the one-row-per-key table —
 * those are questions about the protocol rather than about the keyboard, and
 * they need the raw block, which the shared read does not keep. They are the
 * debug tab's key-perf tool; see tools/KeyPerfBlock.tsx.
 */

/** Full travel depends on the switch fitted — see SWITCH_TYPES. */
export function travelOf(config: KeyConfig): number {
  return travelMmFor(config.switchType)
}

export function rtLabel(config: KeyConfig): string {
  const rt = config.rapidTrigger
  if (!rt.enabled) return translate('perf.off')
  return rt.continuous ? translate('perf.rt.full') : translate('perf.on')
}

export function sensitivityLabel(config: KeyConfig): string {
  const rt = config.rapidTrigger
  if (!rt.enabled) return '—'
  return rt.pressMm === rt.releaseMm
    ? rt.pressMm.toFixed(2)
    : `${rt.pressMm.toFixed(2)} / ${rt.releaseMm.toFixed(2)}`
}

export function deadZoneLabel(config: KeyConfig): string {
  const dz = config.deadZone
  if (!dz.enabled) return translate('perf.off')
  return `${dz.topMm.toFixed(2)} / ${dz.bottomMm.toFixed(2)}`
}

/**
 * Keys that share every value collapse into one row. With 61 keys usually set
 * identically, the per-key list buries the one key that differs — which is the
 * thing worth seeing.
 */
export function signatureOf(c: KeyConfig): string {
  return [
    c.actuationMm,
    c.rapidTrigger.enabled,
    c.rapidTrigger.continuous,
    c.rapidTrigger.pressMm,
    c.rapidTrigger.releaseMm,
    c.deadZone.enabled,
    c.deadZone.topMm,
    c.deadZone.bottomMm,
    c.switchType,
  ].join('|')
}

interface Group {
  keys: KeyDef[]
  config: KeyConfig
}

export function groupKeys(configs: readonly KeyConfig[]): Group[] {
  const byId = new Map<string, Group>()
  for (const key of activeLayout().keys) {
    const config = configs[key.index]
    if (!config) continue
    const id = signatureOf(config)
    const hit = byId.get(id)
    if (hit) hit.keys.push(key)
    else byId.set(id, { keys: [key], config })
  }
  // Largest group first: the board's baseline, then the exceptions.
  return [...byId.values()].sort((a, b) => b.keys.length - a.keys.length)
}

/**
 * Whether this group is the board's baseline rather than an exception to it.
 *
 * More than half the keys, so there can only ever be one. Naming them was the
 * old rule and it only read well at exactly all of them: a board with a handful
 * of keys tuned differently left the largest group as ten labels and a `+51`,
 * which is a list nobody can use standing in for the one row that means "and
 * everything else". The rows worth reading are the exceptions, and they are the
 * ones still spelled out key by key.
 */
function isBaseline(group: Group): boolean {
  return group.keys.length * 2 > activeLayout().count
}

function groupLabel(group: Group): string {
  if (isBaseline(group)) return translate('perf.allKeys', { count: group.keys.length })
  const shown = group.keys.slice(0, 10).map((k) => k.label)
  const rest = group.keys.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}

/**
 * The table itself, shared by the two panels that draw it.
 *
 * Reads the store rather than taking the values as props: both callers want
 * whatever the board last said, and the one difference between them is whether
 * the rows are grouped — which is the one thing passed in.
 */
export function PerfTable({ perKey = false }: { perKey?: boolean }) {
  const { keys } = useLayout()
  const configs = useKeyConfigs()
  const t = useT()
  const groups = groupKeys(configs)

  return (
    <div style={{ marginTop: 8, overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>{t('perf.col.key')}</th>
            <th>{t('perf.col.actuation')}</th>
            <th>{t('perf.col.rt')}</th>
            <th>{t('perf.col.sensitivity')}</th>
            <th>{t('perf.col.deadzone')}</th>
            <th>{t('perf.col.switch')}</th>
            <th>{t('perf.col.travel')}</th>
          </tr>
        </thead>
        <tbody>
          {perKey
            ? keys.map((k) => {
                const c = configs[k.index]
                if (!c) return null
                return <Row key={k.index} name={k.label} config={c} />
              })
            : groups.map((g) => (
                <Row
                  key={signatureOf(g.config)}
                  name={groupLabel(g)}
                  config={g.config}
                  // The baseline label already carries the count; the rows that
                  // name their keys do not, so they get it after the names.
                  count={isBaseline(g) ? undefined : g.keys.length}
                />
              ))}
        </tbody>
      </table>
    </div>
  )
}

export function PerfOverview() {
  const { keys } = useLayout()
  const codec = useCodec()
  const { connected } = useConnection()
  const dirty = useDirtyKeys()
  const global = useGlobalSettings()
  const t = useT()

  const canRead = supports(codec, 'readKeyConfigs')

  // Disconnected means the fallback codec is active, which implements nothing —
  // reporting that as "protocol not decoded" would blame the wrong thing.
  if (!canRead) {
    return (
      <Panel title={t('perf.title')}>
        {connected ? (
          <NotDecoded what="perf.what" />
        ) : (
          <Notice>
            <T k="perf.needDevice" params={{ keys: keys.length }} />
          </Notice>
        )}
      </Panel>
    )
  }

  return (
    <Panel title={t('perf.title')}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="small dim" style={{ flex: '1 1 320px' }}>
          <b style={{ color: 'var(--fg)' }}>{t('perf.bottomOut')}</b>{' '}
          {global ? (
            <span className={global.bottomOutTrigger ? '' : 'dim'}>
              {global.bottomOutTrigger ? t('perf.on') : t('perf.off')}
            </span>
          ) : (
            <span>—</span>
          )}
        </div>
        {/*
          The one warning this panel carries. The table is what the app holds,
          and while an edit is queued that is not what the board holds — the
          band's foot says the same thing above the grid, and it is worth
          saying again beside the values it is about.
        */}
        {dirty.length > 0 && (
          <span className="small" style={{ color: 'var(--warn)' }}>
            {t('perf.dirty', { count: dirty.length })}
          </span>
        )}
      </div>

      <PerfTable />
    </Panel>
  )
}

function Row({ name, config, count }: { name: string; config: KeyConfig; count?: number }) {
  const rt = config.rapidTrigger
  const travel = travelOf(config)
  return (
    <tr>
      <td>
        {name}
        {count !== undefined && count > 1 && (
          <span className="dim small"> {translate('perf.keyCount', { count })}</span>
        )}
      </td>
      <td className="mono">
        {config.actuationMm.toFixed(2)}
        <span className="dim small"> ({mmToCounts(config.actuationMm)})</span>
      </td>
      <td className={rt.enabled ? undefined : 'dim'}>{rtLabel(config)}</td>
      <td className="mono">{sensitivityLabel(config)}</td>
      <td className={config.deadZone.enabled ? 'mono' : 'dim'}>{deadZoneLabel(config)}</td>
      <td>
        {switchTypeName(config.switchType)}
        {config.switchType !== undefined && (
          <span className="dim small"> ({config.switchType})</span>
        )}
      </td>
      <td className="mono dim">{travel.toFixed(2)}</td>
    </tr>
  )
}
