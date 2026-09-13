import { useRef, useState, type CSSProperties } from 'react'
import { useT } from '../i18n'
import {
  background,
  BLUR_MAX,
  clampBlur,
  clampDim,
  DIM_MAX,
  IMAGE_ACCEPT,
  IMAGE_MAX_BYTES,
  useBackground,
} from '../state/background'
import { settings, useSettings } from '../state/settings'
import { Notice, PanelGroup } from './Panel'
import { Slider } from './Slider'

const LABEL: CSSProperties = { width: '3.5rem' }

/**
 * A picture behind the app, and the two amounts that make it a background
 * rather than an obstacle — see state/background.ts.
 *
 * The sliders stay on screen with no picture chosen, disabled. They are what
 * the picture is going to be subject to, and hiding them until a file is picked
 * would mean the row of controls moves under the pointer the moment the file
 * dialog closes — the same reason the lighting panel keeps its parameters in
 * place rather than popping them in.
 */
export function BackgroundPicker() {
  const image = useBackground()
  const { bgBlur, bgDim } = useSettings()
  const t = useT()

  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const pick = async (file: File) => {
    setError(null)
    // Checked here rather than in the store, which deals in bytes: these two
    // are refusals a person reads, and every sentence the app says lives in the
    // bundle. `accept` on the input is a filter, not a guarantee — a file
    // dragged past it, or one the platform types as something else, still
    // arrives here.
    if (!file.type.startsWith('image/')) {
      setError(t('settings.background.notImage'))
      return
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError(t('settings.background.tooLarge', { max: Math.round(IMAGE_MAX_BYTES / 1024 / 1024) }))
      return
    }
    try {
      await background.set(file)
    } catch {
      // What went wrong is an IndexedDB message nobody can act on; that it was
      // not kept is the part that matters.
      setError(t('settings.background.failed'))
    }
  }

  return (
    <PanelGroup title={t('settings.background.title')}>
      <div className="row">
        <button onClick={() => picker.current?.click()}>{t('settings.background.choose')}</button>
        <button disabled={!image} onClick={() => void background.clear()}>
          {t('settings.background.clear')}
        </button>
        {image && (
          <span className="small dim" style={{ overflowWrap: 'anywhere' }}>
            {image.name}
          </span>
        )}
      </div>

      <input
        ref={picker}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the same file twice fires a second change.
          e.target.value = ''
          if (file) void pick(file)
        }}
      />

      <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
        <span className="small dim" style={LABEL}>
          {t('settings.background.blur')}
        </span>
        <Slider
          disabled={!image}
          min={0}
          max={BLUR_MAX}
          step={1}
          value={clampBlur(bgBlur)}
          onChange={(e) => settings.set('bgBlur', Number(e.target.value))}
          style={{ flex: '1 1 200px' }}
        />
        <span className="mono small" style={{ width: 44, textAlign: 'right' }}>
          {clampBlur(bgBlur)}px
        </span>
      </div>

      <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
        <span className="small dim" style={LABEL}>
          {t('settings.background.dim')}
        </span>
        <Slider
          disabled={!image}
          min={0}
          max={DIM_MAX}
          step={1}
          value={clampDim(bgDim)}
          onChange={(e) => settings.set('bgDim', Number(e.target.value))}
          style={{ flex: '1 1 200px' }}
        />
        <span className="mono small" style={{ width: 44, textAlign: 'right' }}>
          {clampDim(bgDim)}%
        </span>
      </div>

      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">{error}</Notice>
        </div>
      )}
    </PanelGroup>
  )
}
