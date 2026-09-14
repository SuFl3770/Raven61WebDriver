import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { reportRateInfo, reportRateName, reportRates } from '../device/tables'
import { codecLabel, supports } from '../protocol/codec'
import type { GlobalPatch } from '../protocol/global'
import { DEBOUNCE_LEVELS, debounceLevelName } from '../protocol/types'
import { globalStore, useGlobalSettings } from '../state/global'
import { link, useCodec, useConnection } from '../state/link'
import { Dialog, DialogActions } from './Dialog'
import { MessageToast } from './MessageToast'
import { NotDecoded, Notice, PanelGroup } from './Panel'
import { Select } from './Select'

/**
 * The two board-wide settings this keyboard actually has: the USB polling rate
 * and the debounce level.
 *
 * They live in the same 32-byte block as "always trigger when bottoming"
 * (see BottomOutTrigger) but in different bytes — the rate in the low nibble of
 * `payload[12]`, debounce in bits 5-6 of `payload[15]` — and they are edited
 * together here because the write is one read-modify-write either way.
 *
 * Everything else in the block belongs to other screens — the lighting effect
 * (see features/LightEffect.tsx), the game-mode locks — and is carried through
 * untouched, which is what `writeGlobalSettings` is for.
 *
 * Opening the tab reads the block, so there is no read button. A retry appears
 * only if that read failed.
 *
 * Neither select has an apply button. There is nothing to compose here — one
 * select is one setting, and a draft of a single value that you then have to
 * confirm with a second click is a step that buys nothing. So moving a select
 * is the write:
 *
 *   - Debounce goes straight to the board. It costs nothing if it was a slip:
 *     move it back.
 *   - The rate opens the question first. It is the one setting here that takes
 *     the connection with it — the board re-enumerates on USB — so the dialog
 *     stands in front of the write, showing what the value is going from and
 *     to. The select shows the chosen value while the question is open;
 *     cancelling puts it back to what the board holds.
 *
 * What that costs is now only the few seconds of the reconnect: the board
 * leaving no longer ends the session, it holds it open and reopens the same
 * board when it comes back (state/reconnect.ts). So nothing here reports the
 * disconnect any more — neither the write that it interrupts nor a warning
 * afterwards. The panel only has to be ready to be read again, which is what
 * re-arming `tried` on the way out is for.
 *
 * The write's outcome splits the same way it does everywhere else in the app:
 * success is an event and leaves as a toast (ui/MessageToast.tsx), a real
 * failure is a state and stays as a notice until something changes it.
 */
export function BoardSettings() {
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()
  /**
   * What the reader just picked, held only until the write settles. Without it
   * the selects would snap back to the board's old value for the length of the
   * round trip, which reads as the click having missed.
   */
  const [pending, setPending] = useState<GlobalPatch | null>(null)
  const [busy, setBusy] = useState<'read' | 'write' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Whether the polling-rate confirmation is standing — see the note above. */
  const [confirming, setConfirming] = useState(false)
  const tried = useRef(false)

  const clearNote = useCallback(() => setNote(null), [])

  const canRead = supports(codec, 'readGlobalSettings')
  const canWrite = supports(codec, 'writeGlobalSettings')

  const read = useCallback(async () => {
    setBusy('read')
    setError(null)
    try {
      globalStore.load(await codec.readGlobalSettings!(link))
      setPending(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [codec])

  const apply = useCallback(
    async (patch: GlobalPatch) => {
      setBusy('write')
      setError(null)
      setNote(null)
      try {
        const result = await codec.writeGlobalSettings!(link, patch)
        globalStore.load(result.after)
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
        // A polling-rate change can take the USB device with it — the board
        // re-enumerates and the in-flight read-back is what fails. That is no
        // longer this panel's news: the session is held open, the dialog over
        // it says the board is gone and counts, and the same board arriving is
        // opened again (state/reconnect.ts) — after which the read below runs
        // and the selects say what the board holds. An error here would be a
        // red line about something that fixed itself while it was being read.
        if (link.connected) setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
        // Either way the store now holds what the board actually reported, so
        // the selects go back to reading from it — including after a failure,
        // where the chosen value is precisely what did not happen.
        setPending(null)
      }
    },
    [codec, t],
  )

  const cancelRate = useCallback(() => {
    setConfirming(false)
    setPending(null)
  }, [])

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
    if (!connected) {
      setConfirming(false)
      setPending(null)
      setError(null)
      // The block went with the device (globalStore clears on disconnect), so
      // the one-read-per-panel latch is re-armed: the board that comes back —
      // the same one, after a rate change — is read again rather than leaving
      // two selects showing a dash for the rest of the session.
      tried.current = false
    }
  }, [connected])

  if (!canRead) {
    return (
      <PanelGroup>
        <NotDecoded what="board.what" />
      </PanelGroup>
    )
  }

  const rateOnBoard = global?.reportRate ?? null
  const debounceOnBoard = global?.debounceLevel ?? null
  const shownRate = pending?.reportRate ?? rateOnBoard
  const shownDebounce = pending?.debounceLevel ?? debounceOnBoard
  /** A rate the board holds that the stock driver's own table has no name for. */
  const rateUnknown = rateOnBoard !== null && reportRateInfo(rateOnBoard) === undefined

  return (
    <PanelGroup>
      <div className="row">
        <span className="small dim" style={{ minWidth: 96 }}>
          {t('board.rate.label')}
        </span>
        <Select
          value={shownRate === null ? '' : String(shownRate)}
          disabled={!connected || !canWrite || rateOnBoard === null || busy !== null}
          onChange={(v) => {
            setPending({ reportRate: Number(v) })
            setConfirming(true)
          }}
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
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="small dim" style={{ minWidth: 96 }}>
          {t('board.debounce.label')}
        </span>
        <Select
          value={shownDebounce === null ? '' : String(shownDebounce)}
          disabled={!connected || !canWrite || debounceOnBoard === null || busy !== null}
          onChange={(v) => {
            const patch = { debounceLevel: Number(v) }
            setPending(patch)
            void apply(patch)
          }}
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
      </div>

      {!canWrite && (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small dim">{t('apply.noWrite', { codec: codecLabel(codec) })}</span>
        </div>
      )}

      {/*
        Only the read says it is working. A write has nothing to wait through:
        both selects go dead for the length of it and come back holding the new
        value, with the toast behind them — a line that appears and leaves in
        the same second would only move the panel down and back.
      */}
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
      <Dialog open={confirming} onClose={cancelRate} title={t('board.rate.confirmTitle')}>
        <div className="small">
          <T
            k="board.rate.confirmChange"
            params={{
              from: reportRateName(rateOnBoard ?? undefined),
              to: reportRateName(pending?.reportRate ?? undefined),
            }}
          />
        </div>
        <DialogActions>
          {/* First in the source, so the dialog opens with the keyboard on the
              button that changes nothing. */}
          <button onClick={cancelRate}>{t('apply.cancel')}</button>
          <button
            className="primary"
            disabled={!connected || busy !== null}
            onClick={() => {
              setConfirming(false)
              if (pending) void apply(pending)
            }}
          >
            {t('apply.write')}
          </button>
        </DialogActions>
      </Dialog>

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

      {/*
        Fixed to the window rather than laid out in the panel, so a confirmation
        that is over the moment it is read does not push the selects down the
        page and then let them back up. See `.toast` in styles.css.
      */}
      <MessageToast message={note} onDone={clearNote} />
    </PanelGroup>
  )
}
