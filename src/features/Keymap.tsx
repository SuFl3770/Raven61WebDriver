import { useState } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { KEYCODE_GROUPS, keycodeDefLabel, keycodeLabel } from '../keyboard/keycodes'
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
  const t = useT()
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
      <Panel title={t('keymap.title')}>
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
            {t('keymap.readLayer')}
          </button>
          <button
            className="primary"
            disabled={!connected || !canWrite || busy}
            onClick={run(() => codec.writeKeymap!(link, layer, entries))}
          >
            {t('keymap.writeLayer')}
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
          {layer > 0 && `${t('keymap.transparent')} `}
          {t('keymap.pickHint')}
        </div>
      </Panel>

      <Panel
        title={
          selected === null
            ? t('keymap.picker.title')
            : t('keymap.picker.titleFor', { index: selected, key: RAVEN61_KEYS[selected]!.label })
        }
      >
        {selected === null ? (
          <div className="small dim">{t('keymap.picker.empty')}</div>
        ) : (
          KEYCODE_GROUPS.map((g) => (
            <div key={g.nameKey} style={{ marginBottom: 12 }}>
              <div className="small dim" style={{ marginBottom: 4 }}>
                {t(g.nameKey)}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {g.codes.map((c) => (
                  <button
                    key={c.code}
                    className={entries[selected]?.code === c.code ? 'primary' : ''}
                    style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => assign(c.code)}
                  >
                    {keycodeDefLabel(c)}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </Panel>

      {!canWrite && (
        <Panel title={t('keymap.apply')}>
          <NotDecoded what="keymap.writeWhat" />
          <div className="small dim" style={{ marginTop: 8 }}>
            <T k="keymap.writeNote" />
          </div>
        </Panel>
      )}
    </>
  )
}
