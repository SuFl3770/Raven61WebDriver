import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { useDeviceSpec } from '../device/active'
import { reportRateInfo, reportRateName, reportRates } from '../device/tables'
import { codecLabel, supports } from '../protocol/codec'
import type { GlobalPatch } from '../protocol/global'
import { DEBOUNCE_LEVELS, debounceLevelName } from '../protocol/types'
import { globalStore, useGlobalSettings } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { Dialog, DialogActions } from './Dialog'
import { NotDecoded, Notice, Panel } from './Panel'
import { Select } from './Select'

/**
 * The two board-wide settings this keyboard actually has: the USB polling rate
 * and the debounce level.
 *
 * They live in the same 32-byte block as "always trigger when bottoming"
 * (see BottomOutTrigger) but in different bytes — the rate in the low nibble of
 * `payload[12]`, debounce in bits 5-6 of `payload[15]` — and they are edited
 * together here because the write is one read-modify-write either way. Sending
 * two separate patches would mean two round trips over the same block.
 *
 * Everything else in the block belongs to other screens — the lighting effect
 * (see features/LightEffect.tsx), the game-mode locks — and is carried through
 * untouched, which is what `writeGlobalSettings` is for.
 *
 * Opening the tab reads the block, so there is no read button — see the note
 * on the buttons below. A retry appears only if that read failed.
 *
 * The rate is the one setting here that can end the session that changes it:
 * the board may re-enumerate on USB, and the browser loses the device it was
 * holding. So a rate change is confirmed in a dialog before anything is sent,
 * while a debounce change — which costs nothing if it is a slip — is not.
 */
export function BoardSettings() {
  const spec = useDeviceSpec()
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()
  const [rate, setRate] = useState<number | null>(null)
  const [debounce, setDebounce] = useState<number | null>(null)
  const [busy, setBusy] = useState<'read' | 'write' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Whether the polling-rate confirmation is standing — see the note below. */
  const [confirming, setConfirming] = useState(false)
  const tried = useRef(false)

  const stopConfirming = useCallback(() => setConfirming(false), [])

  const canRead = supports(codec, 'readGlobalSettings')
  const canWrite = supports(codec, 'writeGlobalSettings')

  const read = useCallback(async () => {
    setBusy('read')
    setError(null)
    try {
      globalStore.load(await codec.readGlobalSettings!(link))
      setRate(null)
      setDebounce(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [codec])

  useEffect(() => {
    // The overview and the bottom-out panel read the same block, so this only
    // reads when nothing has yet.
    if (!connected || !canRead || tried.current || globalStore.current() !== null) return
    tried.current = true
    void read()
  }, [connected, canRead, read])

  // A question asked about one board must not still be standing over whatever
  // is plugged in next — and a rate change is one of the ways a board leaves.
  useEffect(() => {
    if (!connected) setConfirming(false)
  }, [connected])

  if (!canRead) {
    return (
      <Panel title={t('board.title')}>
        <NotDecoded what="board.what" />
      </Panel>
    )
  }

  const rateOnBoard = global?.reportRate ?? null
  const debounceOnBoard = global?.debounceLevel ?? null
  const shownRate = rate ?? rateOnBoard
  const shownDebounce = debounce ?? debounceOnBoard
  const rateDirty = rate !== null && rate !== rateOnBoard
  const debounceDirty = debounce !== null && debounce !== debounceOnBoard
  const dirty = rateDirty || debounceDirty
  /** A rate the board holds that the stock driver's own table has no name for. */
  const rateUnknown = rateOnBoard !== null && reportRateInfo(rateOnBoard) === undefined

  const apply = async () => {
    const patch: GlobalPatch = {}
    if (rateDirty) patch.reportRate = rate!
    if (debounceDirty) patch.debounceLevel = debounce!
    setBusy('write')
    setError(null)
    setNote(null)
    try {
      const result = await codec.writeGlobalSettings!(link, patch)
      globalStore.load(result.after)
      setRate(null)
      setDebounce(null)
      if (result.mismatched.length > 0) {
        setError(
          t('board.mismatch', {
            detail: result.mismatched
              .map(
                (m) =>
                  `payload[${m.offset}] 0x${m.wanted.toString(16).padStart(2, '0')} → 0x${m.got
                    .toString(16)
                    .padStart(2, '0')}`,
              )
              .join(', '),
          }),
        )
      } else {
        setNote(result.unchanged ? t('apply.noChange') : t('board.applied'))
      }
    } catch (e) {
      // A polling-rate change can take the USB device with it, and the
      // read-back is what fails when it does. Say that, rather than letting a
      // bare timeout read as "nothing happened".
      setError(
        rateDirty
          ? `${e instanceof Error ? e.message : String(e)} — ${t('board.rate.writeLost')}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel title={t('board.title')}>
      <div className="small dim" style={{ marginBottom: 12 }}>
        <T k="board.hint" />
      </div>

      <div className="row">
        <span className="small dim" style={{ minWidth: 96 }}>
          {t('board.rate.label')}
        </span>
        <Select
          value={shownRate === null ? '' : String(shownRate)}
          disabled={!connected || rateOnBoard === null || busy !== null}
          onChange={(v) => setRate(Number(v))}
          style={{ minWidth: 180 }}
          options={[
            ...(shownRate === null ? [{ value: '', label: '—' }] : []),
            /*
              A value outside the driver's table is listed as disabled rather
              than hidden: the control would otherwise show a blank while the
              board plainly has a value, which reads as "unset".
            */
            ...(rateUnknown
              ? [{
                  value: rateOnBoard === null ? '' : String(rateOnBoard),
                  label: reportRateName(rateOnBoard ?? undefined),
                  disabled: true,
                }]
              : []),
            ...reportRates().map((r) => ({
              value: String(r.value),
              label: t('board.rate.hz', { hz: r.hz }),
            })),
          ]}
        />
        <span className="small dim">
          {t('actuation.board')} <b className="mono">{reportRateName(rateOnBoard ?? undefined)}</b>
        </span>
      </div>

      <div className="small dim" style={{ marginTop: 6 }}>
        <T k="board.rate.note" />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="small dim" style={{ minWidth: 96 }}>
          {t('board.debounce.label')}
        </span>
        <Select
          value={shownDebounce === null ? '' : String(shownDebounce)}
          disabled={!connected || debounceOnBoard === null || busy !== null}
          onChange={(v) => setDebounce(Number(v))}
          style={{ minWidth: 180 }}
          options={[
            ...(shownDebounce === null ? [{ value: '', label: '—' }] : []),
            ...(debounceOnBoard !== null &&
            !DEBOUNCE_LEVELS.some((d) => d.value === debounceOnBoard)
              ? [{
                  value: String(debounceOnBoard),
                  label: debounceLevelName(debounceOnBoard),
                  disabled: true,
                }]
              : []),
            ...DEBOUNCE_LEVELS.map((d) => ({
              value: String(d.value),
              label: `${d.value} · ${t(d.labelKey)}`,
            })),
          ]}
        />
        <span className="small dim">
          {t('actuation.board')}{' '}
          <b className="mono">{debounceLevelName(debounceOnBoard ?? undefined)}</b>
        </span>
      </div>

      <div className="small dim" style={{ marginTop: 10 }}>
        <T k="board.debounce.hint" />
      </div>

      {/*
        Only the buttons that do something appear. There is no read button —
        opening the tab reads — and the apply pair shows up only once one of the
        two selects has been moved away from what the board reported.
      */}
      {(dirty || !canWrite) && (
        <div className="row" style={{ marginTop: 12 }}>
          {dirty && (
            <>
              {/*
                The rate is the one of the two that can take the connection
                with it, so it asks first; debounce goes straight through. The
                same button either way — what changes is whether pressing it
                writes or opens the question.
              */}
              <button
                className="primary"
                disabled={!connected || !canWrite || busy !== null}
                onClick={rateDirty ? () => setConfirming(true) : () => void apply()}
              >
                {busy === 'write' ? t('apply.writing') : t('apply.write')}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  setRate(null)
                  setDebounce(null)
                }}
              >
                {t('apply.revertEdits')}
              </button>
            </>
          )}
          {!canWrite && (
            <span className="small dim">{t('apply.noWrite', { codec: codecLabel(codec) })}</span>
          )}
        </div>
      )}

      {busy === 'read' && (
        <div className="small dim" style={{ marginTop: 12 }}>
          {t('apply.reading')}
        </div>
      )}

      {/*
        The warning about the rate, asked rather than announced.

        It used to be a notice that appeared under the selects the moment the
        rate was moved, which put it on screen before it was anyone's question
        and left it there to be scrolled past. In front of the write it is the
        thing being answered: what the value is going from and to, what that
        costs, and the two buttons.
      */}
      <Dialog open={confirming} onClose={stopConfirming} title={t('board.rate.confirmTitle')}>
        <div className="small">
          <T
            k="board.rate.confirmChange"
            params={{
              from: reportRateName(rateOnBoard ?? undefined),
              to: reportRateName(rate ?? undefined),
            }}
          />
        </div>
        <div className="small dim" style={{ marginTop: 8 }}>
          <T k="board.rate.warn" />
        </div>
        <DialogActions>
          {/* First in the source, so the dialog opens with the keyboard on the
              button that changes nothing. */}
          <button onClick={stopConfirming}>{t('apply.cancel')}</button>
          <button
            className="primary"
            disabled={!connected || busy !== null}
            onClick={() => {
              setConfirming(false)
              void apply()
            }}
          >
            {t('apply.write')}
          </button>
        </DialogActions>
      </Dialog>

      {global && (
        <div className="small dim mono" style={{ marginTop: 10 }}>
          {t('board.raw', {
            rate: `0x${(global.raw[spec.global.offsets.rate] ?? 0).toString(16).padStart(2, '0')}`,
            tick: global.tickRate,
            flags: `0x${(global.raw[spec.global.offsets.flags] ?? 0).toString(16).padStart(2, '0')}`,
          })}
        </div>
      )}

      {note && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="ok">{note}</Notice>
        </div>
      )}
      {error && (
        <div className="row" style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
          {/*
            The only way back to a board whose automatic read failed. Without
            it a single timeout would leave both selects dead until the tab is
            left and opened again.
          */}
          <button disabled={!connected || busy !== null} onClick={() => void read()}>
            {busy === 'read' ? t('apply.reading') : t('apply.retry')}
          </button>
        </div>
      )}
    </Panel>
  )
}
