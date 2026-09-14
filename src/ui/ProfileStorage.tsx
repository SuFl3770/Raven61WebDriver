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
  PROFILE_ACCEPT,
  STOCK_PROFILE,
  type BlockOutcome,
  type BlockReport,
  type CaptureStage,
  type ProfileBlock,
  type ProfileDocument,
  type ProfileFormat,
  type ProfileReport,
} from '../profile'
import { configStore } from '../state/config'
import { globalStore } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { macroSnapshotStore } from '../state/macroSnapshot'
import { boardSync } from '../state/sync'
import { Dialog, DialogActions } from './Dialog'
import { MessageToast } from './MessageToast'
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
 *   - **A stock export is an encode of the document, not a prediction.** What
 *     that format can hold depends on what is on the board — how many modifiers
 *     are in the keymap, whether any advanced keys exist, how many macro slots
 *     are in use — so there is nothing to offer until the read has happened.
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
  /** How much of the run is behind it, for the bar. Null when nothing is running. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** The document a save has read and is waiting to be given a format for. */
  const [saving, setSaving] = useState<ProfileDocument | null>(null)
  /** The document a load has parsed and checked, and what is ticked. */
  const [loaded, setLoaded] = useState<{
    doc: ProfileDocument
    format: ProfileFormat
    report: ProfileReport
    notes: string[]
  } | null>(null)
  const [chosen, setChosen] = useState<Set<ProfileBlock>>(new Set())
  /** The one-line confirmation an apply that went cleanly leaves behind. */
  const [done, setDone] = useState<string | null>(null)
  /**
   * What an apply that did not go cleanly has to answer for, or null.
   *
   * A dialog rather than a line at the foot of the panel: a block that did not
   * land leaves the board holding half a profile, and that has to be read
   * before anything else is done to it — a notice under the buttons is exactly
   * the kind of thing that is read afterwards, if at all.
   *
   * The two reasons are one state because they are one run: a board that left
   * part way through is also a list of blocks that did and did not make it, and
   * two dialogs stacked over each other would be the same run told twice.
   */
  const [failure, setFailure] = useState<{
    outcomes: readonly BlockOutcome[]
    /** True when the run ended early because the board went away. */
    lost: boolean
  } | null>(null)

  const picker = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setSaving(null)
    setLoaded(null)
    setChosen(new Set())
    setStage(null)
    setProgress(null)
  }, [])

  // A dialog armed for one board must not stay armed for whatever is plugged
  // in next — the same rule the factory reset follows.
  useEffect(() => {
    if (!connected) reset()
  }, [connected, reset])

  const startSave = async () => {
    setError(null)
    setFailure(null)
    setProgress(null)
    setBusy('reading')
    try {
      const { doc, failed } = await captureProfile(link, codec, spec, (p) => {
        setStage(t(stageKey(p.stage)))
        setProgress({ done: p.done, total: p.total })
      })
      setSaving(doc)
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
      setProgress(null)
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
          new TextEncoder().encode(encodeJsonProfile(saving)),
        )
      } else {
        const { bytes } = encodeStockProfile(saving, spec)
        download(`${spec.id}-${stamp}${STOCK_PROFILE.extension}`, STOCK_PROFILE.mime, bytes)
      }
      setSaving(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pick = async (file: File) => {
    setError(null)
    setFailure(null)
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
    setProgress(null)
    setDone(null)
    setFailure(null)
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
      const result = await applyProfile(link, codec, spec, loaded.doc, chosen, (p) => {
        setStage(t(blockKey(p.block)))
        setProgress({ done: p.done, total: p.total })
      })
      /*
       * A clean apply is an event, not a state — the same split the factory
       * reset makes (ui/FactoryReset.tsx). Six lines all reading "applied" are
       * six lines saying what one word says, so the run where every block
       * landed says so once and goes. Anything else — a skip, a failure, a
       * value that read back differently, or a board that left part way
       * through — is a state of the board, and it stops the page to say so.
       */
      const clean =
        !result.disconnected &&
        result.outcomes.length > 0 &&
        result.outcomes.every((o) => o.status === 'written')
      if (clean) setDone(t('profile.toast.ok'))
      else setFailure({ outcomes: result.outcomes, lost: result.disconnected })
      setLoaded(null)
      setChosen(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setStage(null)
      setProgress(null)
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
        {busy === 'reading' && (
          /*
           * Beside the button that started it, not under the panel: the read is
           * the button's own wait, and the answer to "is it doing anything" is
           * wanted where the click was. The writing half of `busy` has its own
           * bar in the load dialog, which is where that run is being watched.
           */
          <Progress label={t('profile.save.reading')} stage={stage} progress={progress} />
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
          stage={stage}
          progress={progress}
        />
      )}

      {/*
        Outlives the reset a disconnect triggers — `reset` takes down the two
        dialogs that were armed for a board that is no longer there, and this
        one is the only thing on screen that is about the board having gone.
      */}
      {/*
        Outlives the reset a disconnect triggers — `reset` takes down the two
        dialogs that were armed for a board that is no longer there, and this
        one is the only thing on screen that is about what happened to it.
      */}
      {failure && (
        <FailureDialog
          outcomes={failure.outcomes}
          lost={failure.lost}
          onClose={() => setFailure(null)}
        />
      )}

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}

      {/*
        Fixed to the window rather than laid out in the panel, so it lands where
        the eye already is once the dialog lifts. See `.toast` in styles.css.
      */}
      <MessageToast message={done} onDone={() => setDone(null)} />
    </PanelGroup>
  )
}

/**
 * How far a read or a write has got: a rail, and the block it is on.
 *
 * The fill is stages *finished* over stages asked for, so it is empty while the
 * first block is in flight and full only when the last one has landed. The rail
 * would otherwise be claiming work the board has not done yet, and the one
 * question it exists to answer is how much of this is already on the board.
 *
 * Determinate from the first frame — `progress` is null only in the gap before
 * the engine's first call, which is a frame or two — so there is no
 * indeterminate state to draw and the label carries that gap on its own.
 */
function Progress({
  label,
  stage,
  progress,
}: {
  label: string
  stage: string | null
  progress: { done: number; total: number } | null
}) {
  const done = progress?.done ?? 0
  const total = progress?.total ?? 0
  const pct = total > 0 ? (done / total) * 100 : 0
  return (
    <>
      <div
        className="progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {/* The stage names itself once there is one; until then the run does. */}
      <span className="small dim">{stage ?? label}</span>
    </>
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
 * Which format the save is written in.
 *
 * Both writes sit in the action row rather than in the body, beside the button
 * that backs out: they are what the dialog is asking, and a dialog's answer
 * belongs where its answers are. That leaves the body to say what the choice
 * costs — a sentence about the two formats, so it lives in the bundle with
 * every other sentence.
 */
function SaveDialog({
  stockName,
  onClose,
  onPick,
}: {
  /** The board's name when it has a stock format, and null when it has none. */
  stockName: string | null
  onClose: () => void
  onPick: (format: ProfileFormat) => void
}) {
  const t = useT()

  return (
    <Dialog open onClose={onClose} title={t('profile.save.title')}>
      <div className="small">{t('profile.save.body')}</div>

      <DialogActions>
        {/* First in the source, so it is what the dialog opens with the keyboard on. */}
        <button onClick={onClose}>{t('profile.cancel')}</button>
        <button onClick={() => onPick('json')}>{t('profile.save.json')}</button>
        {/* Offered only by a board that has a stock format to be narrowed into. */}
        {stockName !== null && (
          <button onClick={() => onPick('stock')}>{t('profile.save.stock')}</button>
        )}
      </DialogActions>
    </Dialog>
  )
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
  stage,
  progress,
}: {
  report: ProfileReport
  format: ProfileFormat
  notes: string[]
  chosen: ReadonlySet<ProfileBlock>
  onToggle: (block: ProfileBlock) => void
  onClose: () => void
  onApply: () => void
  busy: boolean
  stage: string | null
  progress: { done: number; total: number } | null
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

      {busy && (
        /*
         * In the dialog rather than behind it: the apply runs with this open —
         * the board is being written to from a button that is still on screen —
         * and a bar in the panel underneath would be a progress report the veil
         * is covering.
         */
        <div className="row" style={{ marginTop: 12 }}>
          <Progress label={t('profile.apply.writing')} stage={stage} progress={progress} />
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

/**
 * What an apply that did not go cleanly did, block by block.
 *
 * Every block the run reached is listed, not only the ones that went wrong: the
 * question a half-applied board raises is which half, and a list of failures
 * alone answers it only by omission. A board that left part way through says so
 * first — it is why the list stops where it does.
 */
function FailureDialog({
  outcomes,
  lost,
  onClose,
}: {
  outcomes: readonly BlockOutcome[]
  lost: boolean
  onClose: () => void
}) {
  const t = useT()
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(lost ? 'profile.apply.disconnectedTitle' : 'profile.apply.failedTitle')}
      tone="warn"
    >
      {lost && (
        <div className="small" style={{ marginBottom: outcomes.length > 0 ? 10 : 0 }}>
          {t('profile.apply.disconnected')}
        </div>
      )}

      {/* Empty when the board went before the first block — then the line above
          is the whole answer. */}
      {outcomes.length > 0 && (
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
      )}

      <DialogActions>
        <button onClick={onClose}>{t('profile.apply.dismiss')}</button>
      </DialogActions>
    </Dialog>
  )
}
