import { useState } from 'react'
import { KEYCODE_GROUPS, keycodeLabel } from '../keyboard/keycodes'
import { KEY_COUNT, RAVEN61_KEYS } from '../keyboard/raven61'
import { supports } from '../protocol/codec'
import { LAYER_COUNT } from '../protocol/encoding'
import type { KeymapEntry } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { KeyGrid } from '../ui/KeyGrid'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

/**
 * Raven61 stores four layers. The stock database ships layers 0 and 1 filled
 * (base and Fn) and layers 2 and 3 entirely unassigned.
 */
const LAYER_NAMES = ['Main', 'FN 1', 'FN 2', 'FN 3']
const LAYERS = LAYER_COUNT

function defaultLayer(layer: number): KeymapEntry[] {
  // Layer 0 mirrors the physical legends; higher layers start transparent.
  return RAVEN61_KEYS.map((k) => ({ code: layer === 0 ? k.code : 0 }))
}

export function Keymap() {
  const codec = useCodec()
  const { connected } = useConnection()
  const [layer, setLayer] = useState(0)
  const [layers, setLayers] = useState<KeymapEntry[][]>(() =>
    Array.from({ length: LAYERS }, (_, i) => defaultLayer(i)),
  )
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canRead = supports(codec, 'readKeymap')
  const canWrite = supports(codec, 'writeKeymap')
  const entries = layers[layer]!

  const assign = (code: number) => {
    if (selected === null) return
    setLayers((prev) => {
      const next = prev.map((l) => l.slice())
      next[layer]![selected] = { code }
      return next
    })
  }

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Panel title="키맵">
        <div className="row" style={{ marginBottom: 10 }}>
          {LAYER_NAMES.map((name, i) => (
            <button key={i} className={i === layer ? 'primary' : ''} onClick={() => setLayer(i)}>
              {name}
            </button>
          ))}
          <span className="spacer" style={{ flex: 1 }} />
          <button
            disabled={!connected || !canRead || busy}
            onClick={run(async () => {
              const read = await codec.readKeymap!(link, layer)
              setLayers((prev) => {
                const next = prev.map((l) => l.slice())
                next[layer] = read.slice(0, KEY_COUNT)
                return next
              })
            })}
          >
            레이어 읽기
          </button>
          <button
            className="primary"
            disabled={!connected || !canWrite || busy}
            onClick={run(() => codec.writeKeymap!(link, layer, entries))}
          >
            레이어 쓰기
          </button>
        </div>

        {error && <Notice kind="err">{error}</Notice>}

        <KeyGrid
          selected={selected === null ? undefined : new Set([selected])}
          onSelect={(i) => setSelected(i)}
          label={(k) => keycodeLabel(entries[k.index]?.code ?? 0)}
          sub={(k) => (layer > 0 && (entries[k.index]?.code ?? 0) === 0 ? '▽' : undefined)}
        />
        <div className="small dim" style={{ marginTop: 8 }}>
          {layer > 0 && '▽ = 투명(하위 레이어 통과). '}
          키를 고른 뒤 아래에서 코드를 지정하세요.
        </div>
      </Panel>

      <Panel title={selected === null ? '키코드 선택' : `키코드 선택 — #${selected} ${RAVEN61_KEYS[selected]!.label}`}>
        {selected === null ? (
          <div className="small dim">위에서 키를 먼저 선택하세요.</div>
        ) : (
          KEYCODE_GROUPS.map((g) => (
            <div key={g.name} style={{ marginBottom: 12 }}>
              <div className="small dim" style={{ marginBottom: 4 }}>
                {g.name}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {g.codes.map((c) => (
                  <button
                    key={c.code}
                    className={entries[selected]?.code === c.code ? 'primary' : ''}
                    style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => assign(c.code)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </Panel>

      {!canWrite && (
        <Panel title="적용">
          <NotDecoded what="키맵 쓰기" />
          <div className="small dim" style={{ marginTop: 8 }}>
            키맵 명령은 대개 길이가 길어 여러 리포트로 쪼개져 전송됩니다. 순정 드라이버에서 <b>한 키만</b>{' '}
            바꿔 저장한 뒤 캡처를 비교하면, 바뀐 바이트 위치가 곧 그 키의 인덱스입니다 — 매트릭스 순서를
            역산하는 가장 확실한 방법입니다.
          </div>
        </Panel>
      )}
    </>
  )
}
