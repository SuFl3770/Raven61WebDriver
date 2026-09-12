import { useT } from '../i18n'
import { T } from '../i18n/T'
import {
  MT_HOLD_MS_PER_UNIT,
  PAIRED_KINDS,
  kindKey,
  recordHex,
  type AdvancedKind,
} from '../protocol/advancedKeys'
import type { AdvancedKeySnapshot, AdvancedKeyUse } from '../protocol/types'
import { Notice, Panel } from '../ui/Panel'

/**
 * What the open layer already runs, as a table.
 *
 * A section of the advanced-keys tab rather than a panel stacked under the
 * editor, because it answers a different question: the strip above chooses one
 * record to write, this one says what has been written. Under the editor it was
 * a readout of the whole layer that had to be scrolled past to reach the fields.
 *
 * Handed the snapshot rather than reading one. The tab it sits in has already
 * read the three tables — a second read here would ask the board for bytes it
 * is holding one component up, and could disagree with the grid above it.
 */
export function AdvancedInUse({
  snapshot,
  uses,
}: {
  snapshot: AdvancedKeySnapshot | null
  /** The open layer's uses, already filtered by the tab that owns the strip. */
  uses: readonly AdvancedKeyUse[]
}) {
  const t = useT()
  return (
    <Panel title={t('advanced.inUse')}>
      {uses.length === 0 ? (
        <div className="small dim">
          <T k="advanced.noneBound" />
        </div>
      ) : (
        <table className="small" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>{t('advanced.key')}</th>
              <th>{t('advanced.kind')}</th>
              <th>{t('advanced.record')}</th>
              <th>{t('advanced.param')}</th>
              <th>{t('advanced.bytes')}</th>
            </tr>
          </thead>
          <tbody>
            {uses.map((u) => (
              <tr key={`${u.layer}:${u.slot}`}>
                <td>{u.label || t('advanced.unmappedSlot', { slot: u.slot })}</td>
                <td>{t(kindKey(u.kind))}</td>
                <td>#{u.record}</td>
                <td>{paramLabel(t, u)}</td>
                <td>
                  <code>{snapshot ? recordHex(blobOf(snapshot, u.kind), u.record, u.kind) : ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {snapshot && snapshot.orphans.length > 0 && (
        <Notice kind="info">
          {t('advanced.orphans', { records: snapshot.orphans.map((r) => `#${r}`).join(', ') })}
        </Notice>
      )}
    </Panel>
  )
}

function blobOf(snapshot: AdvancedKeySnapshot, kind: AdvancedKind): Uint8Array {
  if (kind === 'dks') return snapshot.blobs.dks
  if (kind === 'tgl') return snapshot.blobs.toggle
  return snapshot.blobs.pair
}

function paramLabel(t: ReturnType<typeof useT>, u: AdvancedKeyUse): string {
  if (u.kind === 'mt') return t('advanced.holdMs', { ms: u.param * MT_HOLD_MS_PER_UNIT })
  if (PAIRED_KINDS.includes(u.kind)) return t('advanced.partnerSlot', { slot: u.param })
  return '—'
}
