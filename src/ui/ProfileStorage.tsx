import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useDeviceSpec } from '../device/active'
import { useT, type MessageKey } from '../i18n'
import {
  anyApplicable,
  applyProfile,
  blockKey,
  captureProfile,
  checkProfile,
  encodeJsonProfile,
  encodeStockProfile,
  JSON_PROFILE,
  loadProfile,
  lossless,
  PROFILE_ACCEPT,
  STOCK_PROFILE,
  type BlockOutcome,
  type BlockReport,
  type CaptureStage,
  type ProfileBlock,
  type ProfileDocument,
  type ProfileFormat,
  type ProfileReport,
  type StockLoss,
} from '../profile'
import { configStore } from '../state/config'
import { globalStore } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { macroSnapshotStore } from '../state/macroSnapshot'
import { boardSync } from '../state/sync'
import { Dialog, DialogActions } from './Dialog'
import { Notice, PanelGroup } from './Panel'

/**
 * Saving the board to a file, and putting a file back on the board.
 *
 * ## Save reads the board; it does not copy the app
 *
 * The button does not write a file straight away — it reads every block first
 * (`captureProfile`), and only then asks which format. Two reasons, and the
 * second is the one that decided it:
 *
 *   - The app's stores hold whatever the tabs that have been opened happened to
 *     read. A file built from them would have holes that look like settings.
 *   - **The format question cannot be answered before the read.** What a stock
 *     export would drop depends on what is on the board — how many modifiers
 *     are in the keymap, whether any advanced keys exist, how many macro slots
 *     are in use. Asking first would mean either guessing or describing the
 *     loss in the abstract, and the whole point of the dialog is to say what
 *     *this* save costs.
 *
 * ## Load checks before it offers, and offers per block
 *
 * A file is parsed, checked against the live spec, and then shown as a list of
 * blocks with a tick each. A block with errors cannot be ticked; one with
 * warnings can. Nothing is written until the second button, in the dialog, is
 * pressed — the same two-controls-in-two-places rule the factory reset follows.
 */
export function ProfileStorage() {
  const spec = useDeviceSpec()
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()

  const [busy, setBusy] = useState<'reading' | 'writing' | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** The document a save has read and is waiting to be given a format for. */
  const [saving, setSaving] = useState<{ doc: ProfileDocument; loss: StockLoss | null } | null>(null)
  /** The document a load has parsed and checked, and what is ticked. */
  const [loaded, setLoaded] = useState<{
    doc: ProfileDocument
    format: ProfileFormat
    report: ProfileReport
    notes: string[]
  } | null>(null)
  const [chosen, setChosen] = useState<Set<ProfileBlock>>(new Set())
  const [outcomes, setOutcomes] = useState<BlockOutcome[] | null>(null)

  const picker = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setSaving(null)
    setLoaded(null)
    setChosen(new Set())
    setStage(null)
  }, [])

  // A dialog armed for one board must not stay armed for whatever is plugged
  // in next — the same rule the factory reset follows.
  useEffect(() => {
    if (!connected) reset()
  }, [connected, reset])

  const startSave = async () => {
    setError(null)
    setOutcomes(null)
    setBusy('reading')
    try {
      const { doc, failed } = await captureProfile(link, codec, spec, (s: CaptureStage) =>
        setStage(t(stageKey(s))),
      )
      // The loss is computed by encoding, not by predicting — see `stock.ts`.
      const loss = spec.stockProfile ? encodeStockProfile(doc, spec).loss : null
      setSaving({ doc, loss })
      if (failed.length > 0) {
        setError(
          t('profile.save.partial', {
            blocks: failed.map((f) => t(blockKey(f.block))).join(', '),
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setStage(null)
    }
  }

  const write = (format: ProfileFormat) => {
    if (!saving) return
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')
      if (format === 'json') {
        download(
          `${spec.id}-${stamp}${JSON_PROFILE.extension}`,
          JSON_PROFILE.mime,
          new TextEncoder().encode(encodeJsonProfile(saving.doc)),
        )
      } else {
        const { bytes } = encodeStockProfile(saving.doc, spec)
        download(`${spec.id}-${stamp}${STOCK_PROFILE.extension}`, STOCK_PROFILE.mime, bytes)
      }
      setSaving(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pick = async (file: File) => {
    setError(null)
    setOutcomes(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { doc, format, notes } = loadProfile(bytes, spec)
      const report = checkProfile(doc, spec)
      setLoaded({ doc, format, report, notes })
      // Everything that can be written starts ticked. The dialog is a chance to
      // take something out, not a form to fill in — a list that starts empty
      // makes the common case (all of it) the most work.
      setChosen(new Set(report.blocks.filter((b) => b.applicable).map((b) => b.block)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const runApply = async () => {
    if (!loaded) return
    setBusy('writing')
    setError(null)
    /*
     * Before the writes, not after.
     *
     * The per-key store's dirty set is edits the board has not been told about,
     * and a profile is about to overwrite the same keys — left in place they
     * would be written back over it by the next scheduled write, undoing part
     * of what the user just applied. Clearing first also takes `lastRead` back
     * to null, which is what gates the panels that would otherwise offer to
     * write values read before the profile landed.
     */
    configStore.clear()
    globalStore.clear()
    macroSnapshotStore.clear()
    try {
      const result = await applyProfile(link, codec, spec, loaded.doc, chosen, (b) =>
        setStage(t(blockKey(b))),
      )
      setOutcomes(result.outcomes)
      if (result.disconnected) setError(t('profile.apply.disconnected'))
      setLoaded(null)
      setChosen(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setStage(null)
      /*
       * Read the board back, rather than assuming the write took.
       *
       * Every write here verifies itself, so this is not the check — it is what
       * puts the *board's* answer in front of the user. Without it the board
       * settings panel goes on showing the values it read before the apply, and
       * a debounce level that changed reads as one that did not.
       */
      void boardSync.read()
    }
  }

  const toggle = (block: ProfileBlock) => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(block)) next.delete(block)
      else next.add(block)
      return next
    })
  }

  return (
    <PanelGroup>
      <div className="row">
        <span className="small dim" style={{ minWidth: 140 }}>
          {t('profile.fileSave')}
        </span>
        <button disabled={!connected || busy !== null} onClick={() => void startSave()}>
          {t('profile.save.start')}
        </button>
        {busy !== null && (
          <span className="small dim">
            {t(busy === 'reading' ? 'profile.save.reading' : 'profile.apply.writing')}
            {stage ? ` · ${stage}` : ''}
          </span>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <span className="small dim" style={{ minWidth: 140 }}>
          {t('profile.fileLoad')}
        </span>
        <button disabled={!connected || busy !== null} onClick={() => picker.current?.click()}>
          {t('profile.load.start')}
        </button>
      </div>

      <input
        ref={picker}
        type="file"
        accept={PROFILE_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the same file twice fires a second change.
          e.target.value = ''
          if (file) void pick(file)
        }}
      />

      {saving && (
        <SaveDialog
          loss={saving.loss}
          onClose={() => setSaving(null)}
          onPick={write}
          stockName={spec.stockProfile ? spec.name : null}
        />
      )}

      {loaded && (
        <LoadDialog
          report={loaded.report}
          format={loaded.format}
          notes={loaded.notes}
          chosen={chosen}
          onToggle={toggle}
          onClose={reset}
          onApply={() => void runApply()}
          busy={busy === 'writing'}
        />
      )}

      {outcomes && <Outcomes outcomes={outcomes} />}

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}
    </PanelGroup>
  )
}

/** Progress labels — spelled out so the keys stay checkable against the bundle. */
function stageKey(stage: CaptureStage): MessageKey {
  return stage === 'firmware' ? 'profile.stage.firmware' : blockKey(stage)
}

/**
 * A download, from bytes.
 *
 * `Blob` and an object URL rather than a `data:` href: a whole profile is tens
 * of kilobytes and a data URL of that size is a URL some browsers refuse.
 */
function download(name: string, mime: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // A turn of the loop, so the click has the URL before it is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Which format, and what the narrower one would drop.
 *
 * The loss is the dialog's whole content. It is a list of counts rather than a
 * paragraph because every line is a number the user can check against their own
 * board — "3 keys" is answerable, "some bindings" is not.
 */
function SaveDialog({
  loss,
  stockName,
  onClose,
  onPick,
}: {
  loss: StockLoss | null
  stockName: string | null
  onClose: () => void
  onPick: (format: ProfileFormat) => void
}) {
  const t = useT()
  const lines = loss ? lossLines(loss, t) : []

  return (
    <Dialog open onClose={onClose} title={t('profile.save.title')} tone={lines.length > 0 ? 'warn' : undefined}>
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={() => onPick('json')}>{t('profile.save.json')}</button>
        <span className="small dim">{t('profile.save.jsonNote')}</span>
      </div>

      {stockName === null ? (
        <Notice kind="info">{t('profile.save.noStock')}</Notice>
      ) : (
        <>
          <div className="row">
            <button onClick={() => onPick('stock')}>{t('profile.save.stock')}</button>
            {loss && lossless(loss) && <span className="small dim">{t('profile.save.noLoss')}</span>}
          </div>
          {lines.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Notice kind="warn">
                <strong>{t('profile.save.lossTitle')}</strong>
                <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}
        </>
      )}

      <DialogActions>
        <button onClick={onClose}>{t('profile.cancel')}</button>
      </DialogActions>
    </Dialog>
  )
}

function lossLines(loss: StockLoss, t: (k: MessageKey, p?: Record<string, string | number>) => string): string[] {
  const lines: string[] = []
  // First when it applies: the file has no element for any of these, so every
  // board-wide field the document carries is one the save cannot take.
  if (loss.globalFields.length > 0) lines.push(t('profile.loss.global'))
  if (loss.advancedKeys) lines.push(t('profile.loss.advanced'))
  if (loss.bindings > 0) lines.push(t('profile.loss.bindings', { count: loss.bindings }))
  if (loss.multiModifier > 0) lines.push(t('profile.loss.modifiers', { count: loss.multiModifier }))
  if (loss.macroSlots > 0) lines.push(t('profile.loss.macroSlots', { count: loss.macroSlots }))
  if (loss.macroEvents > 0) lines.push(t('profile.loss.macroEvents', { count: loss.macroEvents }))
  if (loss.roundTrip > 0) lines.push(t('profile.loss.roundTrip', { count: loss.roundTrip }))
  return lines
}

/** The blocks a file carries, with a tick each, and why one cannot be ticked. */
function LoadDialog({
  report,
  format,
  notes,
  chosen,
  onToggle,
  onClose,
  onApply,
  busy,
}: {
  report: ProfileReport
  format: ProfileFormat
  notes: string[]
  chosen: ReadonlySet<ProfileBlock>
  onToggle: (block: ProfileBlock) => void
  onClose: () => void
  onApply: () => void
  busy: boolean
}) {
  const t = useT()

  if (report.fatal) {
    return (
      <Dialog open onClose={onClose} title={t('profile.load.title')} tone="danger">
        <Notice kind="err">{report.fatal}</Notice>
        <DialogActions>
          <button onClick={onClose}>{t('profile.cancel')}</button>
        </DialogActions>
      </Dialog>
    )
  }

  const rows = report.blocks.filter((b) => b.present)
  const warnings = [
    ...report.deviceWarnings,
    ...(format === 'stock' ? notes.map(noteLine(t)).filter((s): s is string => s !== null) : []),
  ]

  return (
    <Dialog open onClose={onClose} title={t('profile.load.title')} tone={warnings.length > 0 ? 'warn' : undefined}>
      {warnings.length > 0 && (
        <Notice kind="warn">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      {rows.length === 0 ? (
        <Notice kind="err">{t('profile.load.empty')}</Notice>
      ) : (
        <div style={{ marginTop: warnings.length > 0 ? 10 : 0 }}>
          {rows.map((row) => (
            <BlockRow
              key={row.block}
              row={row}
              checked={chosen.has(row.block)}
              disabled={!row.applicable || busy}
              onToggle={() => onToggle(row.block)}
            />
          ))}
        </div>
      )}

      <DialogActions>
        <button onClick={onClose}>{t('profile.cancel')}</button>
        <button
          className="primary"
          disabled={busy || chosen.size === 0 || !anyApplicable(report)}
          onClick={onApply}
        >
          {t('profile.load.apply', { count: chosen.size })}
        </button>
      </DialogActions>
    </Dialog>
  )
}

function BlockRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: BlockReport
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const t = useT()
  return (
    <div style={{ marginBottom: 8 }}>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
        <span>{t(blockKey(row.block))}</span>
        {row.summary && <span className="small dim mono">{row.summary}</span>}
      </label>
      {row.errors.map((e) => (
        <div key={e} className="small" style={{ paddingLeft: 30, color: 'var(--err)' }}>
          {e}
        </div>
      ))}
      {row.warnings.map((w) => (
        <div key={w} className="small dim" style={{ paddingLeft: 30 }}>
          {w}
        </div>
      ))}
    </div>
  )
}

/**
 * A reader's note as a line, or null for one the UI has nothing to say about.
 *
 * The notes are tags with a count after a colon (`keymap:3`) rather than
 * sentences, so that the sentence lives in the bundle like every other one.
 */
function noteLine(t: (k: MessageKey, p?: Record<string, string | number>) => string) {
  return (note: string): string | null => {
    const [tag, rest] = note.split(':')
    const count = Number(rest ?? 0)
    switch (tag) {
      case 'advanced':
        return t('profile.note.advanced')
      case 'perfShort':
        return t('profile.note.perfShort')
      case 'keymap':
        return t('profile.note.keymap', { count })
      case 'layers':
        return t('profile.note.layers', { count })
      case 'macroEvents':
        return t('profile.note.macroEvents', { count })
      case 'macroSlotsCleared':
        return t('profile.note.macroSlotsCleared', { count })
      case 'perf':
        return t('profile.note.perf', { count })
      case 'derived':
        return null
      default:
        // A `pro_name` mismatch arrives as its own sentence, already formed.
        return note
    }
  }
}

const OUTCOME_KEY: Record<BlockOutcome['status'], MessageKey> = {
  written: 'profile.outcome.written',
  skipped: 'profile.outcome.skipped',
  failed: 'profile.outcome.failed',
  mismatch: 'profile.outcome.mismatch',
}

function Outcomes({ outcomes }: { outcomes: readonly BlockOutcome[] }) {
  const t = useT()
  const bad = outcomes.some((o) => o.status !== 'written')
  return (
    <div style={{ marginTop: 10 }}>
      <Notice kind={bad ? 'warn' : 'ok'}>
        <dl className="facts">
          {outcomes.map((o) => (
            // A fragment rather than a wrapper: `.facts` is a two-column grid
            // and an element between it and its `dt`/`dd` takes them out of it.
            <Fragment key={o.block}>
              <dt>{t(blockKey(o.block))}</dt>
              <dd className="mono">
                {t(OUTCOME_KEY[o.status])}
                {o.detail ? ` · ${o.detail}` : ''}
              </dd>
            </Fragment>
          ))}
        </dl>
      </Notice>
    </div>
  )
}
