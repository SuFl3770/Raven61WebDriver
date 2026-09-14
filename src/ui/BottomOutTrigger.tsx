import { useT } from '../i18n'
import { supports } from '../protocol/codec'
import { useGlobalSettings } from '../state/global'
import { useCodec, useConnection } from '../state/link'
import { boardSync } from '../state/sync'
import { Hint } from './Hint'
import { NotDecoded } from './Panel'

/**
 * "Always trigger when bottoming out" — `perf_bottomrapidtrigger_mode`.
 *
 * The one rapid-trigger setting that is not per key. It lives in the 32-byte
 * global block at `payload[15]` bit 1, so it needs its own read and its own
 * write (`0x05` / `0x06`) rather than riding along with the per-key apply.
 *
 * That block is shared with settings that belong to other screens — the report
 * rate, the dead zone, the game-lock bits, the lighting effect — and with the
 * analog-test bits that stop the board typing. So the write is a patch: read
 * the block, flip one bit, write it back, read it again to check. Which is what
 * the stock driver does at both of its own `0x06` call sites.
 *
 * The switch writes as soon as it is flipped. It has no settle delay of its own
 * — a checkbox cannot be dragged — but it shares the queue with the per-key
 * writes, because the two must not interleave. What came of it is reported by
 * the tab's own status line rather than here; one place for that is enough.
 *
 * A row rather than a panel: it sits with the two per-key rapid-trigger
 * switches, because that is where someone looking for it will look. The price
 * is that nothing around it says which of the three is the odd one — so the
 * label carries "(global)" itself, and the readout beside it shows the board's
 * value rather than a pending one, which is the visible difference.
 */
export function BottomOutToggle() {
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()

  if (!supports(codec, 'readGlobalSettings')) {
    return <NotDecoded what="bottomOut.what" />
  }

  const onBoard = global?.bottomOutTrigger ?? null

  return (
    <>
      <label className="row switch-row">
        <span className="switch-label">{t('bottomOut.enable')}</span>
        {/* Before the switch: it is the last thing in every switch row, which
            is what puts all of them on one x. */}
        <input
          type="checkbox"
          checked={onBoard ?? false}
          // Reflects the board, not a pending edit: the write goes out on the
          // change and the store is reloaded from the verify read, so the box
          // only moves once the board agrees.
          disabled={!connected || onBoard === null || !supports(codec, 'writeGlobalSettings')}
          onChange={(e) => void boardSync.applyGlobal({ bottomOutTrigger: e.target.checked })}
        />
      </label>
      <Hint k="bottomOut.hint" />
    </>
  )
}
