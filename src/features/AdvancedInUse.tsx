import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeviceSpec } from '../device/active'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { keycodeLabel } from '../keyboard/keycodes'
import {
  MT_HOLD_MS_PER_UNIT,
  UNSTABLE_KINDS,
  decodeAdvancedRecord,
  decodePairRecord,
  dksStepsToMm,
  kindKey,
  mtBindings,
  oksBindings,
  pairUsages,
  recordHex,
  type AdvancedKind,
} from '../protocol/advancedKeys'
import { supports } from '../protocol/codec'
import { bindingLabel, type KeyBinding } from '../protocol/keymap'
import type { AdvancedKeySnapshot, AdvancedKeyUse } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * What the board already runs, as a table.
 *
 * It answers a different question from the tab it came out of: the advanced-key
 * tab chooses one record to write, this says what has been written. That is why
 * it is a section of the overview rather than a seventh section on the strip
 * over there — the other six open an editor, and this one never did.
 *
 * Handed the snapshot rather than reading one, so that whoever owns the read
 * owns it alone: two reads of the same three tables could disagree, and the
 * advanced-key tab's read also sweeps orphans, which is a write. See
 * `useAdvancedSnapshot` for the plain read the overview does.
 */
export function AdvancedInUse({
  snapshot,
  uses,
  debug,
  hidden,
}: {
  snapshot: AdvancedKeySnapshot | null
  /**
   * The open layer's uses, already filtered by the owner.
   *
   * Both owners have a layer strip in the grid's bar — which key runs an
   * advanced key is a keymap entry, so it is per layer, and a table that mixed
   * them would contradict the strip above it.
   */
  uses: readonly AdvancedKeyUse[]
  /*
   * Whether the two protocol columns are drawn — which record holds the setting
   * and that record read back as hex. Without them the table is "these keys run
   * that kind, and here is what they do", which is what the layer looks like;
   * with them it is what was written, which is a question only the
   * reverse-engineering work asks. Passed rather than read here so the tab and
   * its section agree in one place — see features/Advanced.
   */
  debug: boolean
  /**
   * Kinds the advanced-key tab is not offering an editor for — see
   * `UNSTABLE_KINDS`. Empty in debug mode. A board can still hold one of them,
   * written before this app or by the stock driver, and a row nobody can open
   * is the one thing this table would otherwise leave unexplained.
   */
  hidden: readonly AdvancedKind[]
}) {
  const t = useT()
  const rows = rowsOf(uses)
  const blocked = hidden.filter((k) => rows.some((row) => row.kind === k))
  return (
    <Panel title={t('advanced.inUse')}>
      {rows.length === 0 ? (
        <div className="small dim">
          <T k="advanced.noneBound" />
        </div>
      ) : (
        <table className="small" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>{t('advanced.key')}</th>
              <th>{t('advanced.kind')}</th>
              {debug && <th>{t('advanced.record')}</th>}
              <th>{t('advanced.param')}</th>
              {debug && <th>{t('advanced.bytes')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                <td>
                  {row.uses
                    .map((u) => u.label || t('advanced.unmappedSlot', { slot: u.slot }))
                    .join(', ')}
                </td>
                <td>{t(kindKey(row.kind))}</td>
                {debug && <td>{row.uses.map((u) => `#${u.record}`).join(', ')}</td>}
                <td>
                  <Argument row={row} snapshot={snapshot} />
                </td>
                {debug && (
                  <td>
                    {row.uses.map((u) => (
                      <div key={u.slot}>
                        <code>
                          {snapshot ? recordHex(blobOf(snapshot, row.kind), u.record, row.kind) : ''}
                        </code>
                      </div>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {blocked.length > 0 && (
        <Notice kind="warn">
          <T
            k="advanced.unstableInUse"
            params={{ kinds: blocked.map((k) => t(kindKey(k))).join(', ') }}
          />
        </Notice>
      )}
      {debug && snapshot && snapshot.orphans.length > 0 && (
        <Notice kind="info">
          {t('advanced.orphans', { records: snapshot.orphans.map((r) => `#${r}`).join(', ') })}
        </Notice>
      )}
    </Panel>
  )
}

/** A read of the board's three advanced-key tables, and how it went. */
export interface AdvancedRead {
  snapshot: AdvancedKeySnapshot | null
  /** False when this codec does not decode the tables at all. */
  canRead: boolean
  error: string | null
}

/**
 * The board's advanced-key tables, read once for whoever is showing them.
 *
 * A read of its own rather than the advanced-key tab's, because that one is not
 * a plain read: it sweeps orphan records on the way through, which is a write,
 * and the overview writes nothing. What is left here is the one command.
 *
 * A hook rather than a read inside the table, because the table is not the only
 * thing that needs it. The overview's caps carry the advanced-key bands, and
 * which key runs one is per layer — so the grid and the section below it have
 * to be answering out of the same snapshot, or the strip in the grid's bar
 * would move the bands and the table separately.
 *
 * Reads once per mount, and does not re-run itself on failure: a board that
 * answers nothing would otherwise be asked once per render. Leaving the tab and
 * coming back is the retry, and the refresh.
 */
export function useAdvancedSnapshot(): AdvancedRead {
  const codec = useCodec()
  const { connected } = useConnection()
  const [snapshot, setSnapshot] = useState<AdvancedKeySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A ref, not state: it guards the effect below from starting a second read
  // while the first is in the air, and nothing on screen changes when it moves.
  const inFlight = useRef(false)
  const canRead = supports(codec, 'readAdvancedKeys')

  useEffect(() => {
    if (!connected || !canRead || inFlight.current || snapshot) return
    inFlight.current = true
    void (async () => {
      try {
        setSnapshot(await codec.readAdvancedKeys!(link))
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
      }
    })()
  }, [codec, connected, canRead, snapshot])

  return { snapshot, canRead, error }
}

/**
 * The table as the overview's section: one layer of a read taken further up.
 *
 * The read is not done here — see `useAdvancedSnapshot` for why the tab owns
 * it. What is here is the two ways a read can have nothing to show, which are
 * the section's to say rather than the grid's.
 */
export function AdvancedInUseSection({
  read,
  layer,
  debug,
}: {
  read: AdvancedRead
  /** The layer the strip in the grid's bar has open. */
  layer: number
  debug: boolean
}) {
  const t = useT()
  const { snapshot, canRead, error } = read

  if (!canRead) {
    return (
      <Panel title={t('advanced.inUse')}>
        <NotDecoded what="advanced.what" />
      </Panel>
    )
  }

  if (error) {
    return (
      <Panel title={t('advanced.inUse')}>
        <Notice kind="err">{error}</Notice>
      </Panel>
    )
  }

  return (
    <AdvancedInUse
      snapshot={snapshot}
      uses={snapshot?.uses.filter((u) => u.layer === layer) ?? []}
      debug={debug}
      // Debug mode offers every kind an editor, so nothing is unexplained and
      // the caution below the table has nothing to warn about.
      hidden={debug ? [] : UNSTABLE_KINDS}
    />
  )
}

/**
 * One line of the table.
 *
 * Usually one use, because five of the six kinds are one key doing something on
 * its own. RS and SOCD are not: they are a rule *between* two keys, and each
 * half carries its own record and its own keymap entry. Drawn as two rows they
 * read as two settings that happen to mention each other's slot — which is the
 * shape of the bytes, not of the setting. So a pair is one row with both keys
 * in the key column, and the argument column says what each of them sends.
 */
export interface InUseRow {
  kind: AdvancedKind
  /** Both halves of an RS or SOCD pair when the layer holds both, else one. */
  uses: AdvancedKeyUse[]
}

function rowKey(row: InUseRow): string {
  return `${row.uses[0]?.layer ?? 0}:${row.uses.map((u) => u.slot).join('-')}`
}

/**
 * The layer's uses, with each RS/SOCD pair folded into one row.
 *
 * Both halves have to name each other — this key's partner slot is that key's
 * own slot and the other way round — before they are drawn as one. A half whose
 * partner is missing or points somewhere else keeps its own row: it is a pair
 * that was never finished, and saying so is the point.
 */
export function rowsOf(uses: readonly AdvancedKeyUse[]): InUseRow[] {
  const rows: InUseRow[] = []
  /** Slots already drawn as somebody else's other half. */
  const taken = new Set<number>()
  for (const u of uses) {
    if (taken.has(u.slot)) continue
    if (u.kind === 'rs' || u.kind === 'socd') {
      const partner = uses.find(
        (o) => o.slot !== u.slot && o.slot === u.param && o.kind === u.kind && o.param === u.slot,
      )
      if (partner) {
        taken.add(partner.slot)
        rows.push({ kind: u.kind, uses: [u, partner] })
        continue
      }
    }
    rows.push({ kind: u.kind, uses: [u] })
  }
  return rows
}

/**
 * What the row's records hold, read out rather than counted in bytes.
 *
 * Each kind is asked its own question, because each one means something
 * different by the same six bytes — see the note on `PairRecord`. The record
 * number and the hex beside it are still the byte-level answer; this column is
 * the one that says what pressing the key will do.
 */
export function Argument({
  row,
  snapshot,
  inline,
}: {
  row: InUseRow
  snapshot: AdvancedKeySnapshot | null
  /*
   * One line rather than a stack.
   *
   * The table gives each of DKS's four tracks a row of its own, because there
   * the column is as tall as it needs to be. The grid's foot is a single line
   * of flow under the keyboard — see `.gridfoot` — and a block element in it
   * breaks the line it is sitting on. Same sentences, joined instead.
   */
  inline?: boolean
}) {
  const t = useT()
  const spec = useDeviceSpec()
  const first = row.uses[0]
  if (!snapshot || !first) return <>—</>
  const label = (binding: KeyBinding) => bindingLabel(binding, keycodeLabel)
  /** A part of the readout: its own row in the table, a clause in the foot. */
  const Part = ({ children }: { children: ReactNode }) =>
    inline ? <span>{children}</span> : <div>{children}</div>

  /*
   * The paired kinds read one usage out of each half's own record, so this is
   * per use rather than per row — and in the key column's order, so that the
   * two columns are read across.
   */
  // Read out of the row rather than off `row.kind`, because the narrowing does
  // not reach inside the callback below.
  const kind = row.kind
  if (kind === 'rs' || kind === 'socd') {
    const sends = row.uses.map((u) =>
      keycodeLabel(pairUsages(decodePairRecord(snapshot.blobs.pair, u.record, kind)).own),
    )
    const partner = snapshot.slotMap.keyBySlot.get(first.param)
    return (
      <>
        {sends.join(', ')}
        {/* A half-built pair: the other key is named so the row says what it is
            still waiting for rather than looking like a whole setting. */}
        {row.uses.length === 1 && (
          <>
            {inline && ' · '}
            <Part>
              <span className="dim">
                {partner
                  ? t('advanced.partnerKey', { key: partner.label })
                  : t('advanced.partnerSlot', { slot: first.param })}
              </span>
            </Part>
          </>
        )}
      </>
    )
  }

  const rec = decodeAdvancedRecord(snapshot.blobs, first.record, row.kind)

  if (rec.kind === 'dks') {
    const mm = (steps: number) => dksStepsToMm(steps, spec.encoding.countsPerMm).toFixed(1)
    /*
     * A track with no bits set and nothing bound is one of the four left empty,
     * which is most of a record that only uses two of them.
     */
    const bound = rec.spans.filter((s) => s.mask !== 0 || s.binding.kind !== 'none')
    if (bound.length === 0) return <>—</>
    return (
      <>
        {bound.map((span, i) => (
          <Fragment key={i}>
            {inline && i > 0 && ' · '}
            <Part>
              {label(span.binding)}{' '}
              <span className="dim">
                {t('advanced.arg.stroke', { from: span.pressAt + 1, to: span.releaseAt + 1 })} ·{' '}
                {t('advanced.arg.range', {
                  from: mm(rec.thresholds[span.pressAt] ?? 0),
                  to: mm(rec.thresholds[span.releaseAt] ?? 0),
                })}
              </span>
            </Part>
          </Fragment>
        ))}
      </>
    )
  }

  if (rec.kind === 'tgl') return <>{label(rec.binding)}</>

  if (rec.kind === 'mt') {
    // The hold time is the keymap entry's third byte rather than the record's —
    // see the note on `MT_HOLD_MS_PER_UNIT` for why it lives over there.
    const { tap, hold } = mtBindings(rec)
    return (
      <>
        {t('advanced.holdMs', { ms: first.param * MT_HOLD_MS_PER_UNIT })} ·{' '}
        {t('advanced.arg.tap', { binding: label(tap) })} ·{' '}
        {t('advanced.arg.hold', { binding: label(hold) })}
      </>
    )
  }

  if (rec.kind === 'oks') {
    const { own, onRelease } = oksBindings(rec)
    return (
      <>
        {t('advanced.arg.sends', { binding: keycodeLabel(own) })} ·{' '}
        {t('advanced.arg.onRelease', { binding: keycodeLabel(onRelease) })}
      </>
    )
  }

  return <>—</>
}

function blobOf(snapshot: AdvancedKeySnapshot, kind: AdvancedKind): Uint8Array {
  if (kind === 'dks') return snapshot.blobs.dks
  if (kind === 'tgl') return snapshot.blobs.toggle
  return snapshot.blobs.pair
}
