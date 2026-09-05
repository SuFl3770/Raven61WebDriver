import { useT } from '../i18n'
import { T } from '../i18n/T'
import { supports } from '../protocol/codec'
import { useGlobalSettings } from '../state/global'
import { useCodec, useConnection } from '../state/link'
import { boardSync } from '../state/sync'
import { NotDecoded, Panel } from './Panel'

/**
 * "Always trigger when bottoming out" — `perf_bottomrapidtrigger_mode`.
 *
 * The one rapid-trigger setting that is not per key. It lives in the 32-byte
 * global block at `payload[15]` bit 1, so it needs its own read and its own
 * write (`0x05` / `0x06`) rather than riding along with the per-key apply.
 *
 * That block is shared with settings that belong to other screens — the report
 * rate, the dead zone, the game-lock bits, the sleep timeout — and with the
 * analog-test bits that stop the board typing. So the write is a patch: read
 * the block, flip one bit, write it back, read it again to check. Which is what
 * the stock driver does at both of its own `0x06` call sites.
 *
 * The switch writes as soon as it is flipped. It has no settle delay of its own
 * — a checkbox cannot be dragged — but it shares the queue with the per-key
 * writes, because the two must not interleave. What came of it is reported by
 * the tab's own status line rather than here; one place for that is enough.
 */
export function BottomOutTrigger() {
  const codec = useCodec()
  const { connected } = useConnection()
  const t = useT()
  const global = useGlobalSettings()

  if (!supports(codec, 'readGlobalSettings')) {
    return (
      <Panel title={t('bottomOut.title')}>
        <NotDecoded what="bottomOut.what" />
      </Panel>
    )
  }

  const onBoard = global?.bottomOutTrigger ?? null

  return (
    <Panel title={t('bottomOut.title')}>
      <div className="small dim" style={{ marginBottom: 10 }}>
        <T k="bottomOut.hint" />
      </div>

      <label className="row">
        <input
          type="checkbox"
          checked={onBoard ?? false}
          // Reflects the board, not a pending edit: the write goes out on the
          // change and the store is reloaded from the verify read, so the box
          // only moves once the board agrees.
          disabled={!connected || onBoard === null || !supports(codec, 'writeGlobalSettings')}
          onChange={(e) => void boardSync.applyGlobal({ bottomOutTrigger: e.target.checked })}
        />
        <span>{t('bottomOut.enable')}</span>
        <span className="small dim">
          {onBoard === null ? '—' : onBoard ? t('perf.on') : t('perf.off')}
        </span>
      </label>

      {global && (
        <div className="small dim mono" style={{ marginTop: 10 }}>
          {t('bottomOut.raw', {
            byte: `0x${(global.raw[15] ?? 0).toString(16).padStart(2, '0')}`,
            tachyon: global.tachyon ? t('perf.on') : t('perf.off'),
            actuationCheck: global.actuationCheck ? t('perf.on') : t('perf.off'),
            magnetTest: global.magnetTest ? t('perf.on') : t('perf.off'),
            debounce: global.debounceLevel,
          })}
        </div>
      )}
    </Panel>
  )
}
