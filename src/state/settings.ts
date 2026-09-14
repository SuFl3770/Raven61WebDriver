import { useSyncExternalStore } from 'react'
import { DEFAULT_ACCENT } from './accent'
import { DEFAULT_THEME, type Theme } from './theme'

/**
 * App preferences, kept out of the protocol layer and persisted per browser.
 *
 * `debug` decides whether the reverse-engineering panels are shown. They earned
 * their place while the protocol was being decoded, but for someone who just
 * wants to see key travel they are noise — so they are off by default, and the
 * only way back to them is five quick taps of Shift (state/debugGesture.ts).
 * There is no checkbox: a control everyone can see for something almost nobody
 * should touch was the wrong trade.
 *
 * Being persisted matters more for `debug` than it looks. The gesture is
 * deliberately obscure, so someone who found it once should not have to find it
 * again after a reload — and equally, someone who turned it off should not have
 * the lab reappear on them.
 *
 * `accent` is the point colour, as one of the hex values state/accent.ts
 * offers. Stored as the colour rather than as an index or a name so that
 * reordering or renaming the list cannot repaint someone's app behind them.
 *
 * `theme` is light, dark, or whatever the machine says — see state/theme.ts.
 * Stored alongside the accent because they are the same kind of thing: how this
 * browser draws the app, which never reaches the board.
 *
 * `bgBlur` and `bgDim` are the two amounts that go with the wallpaper — how far
 * it is blurred, and how much of the page colour is laid back over it. The
 * picture itself is not here: it is a `Blob` in IndexedDB, because this store
 * is `localStorage` and a photograph in it would either not fit or crowd out
 * every other preference. See state/background.ts. They stay even with no
 * wallpaper set, so that picking a second one lands on the amounts that suited
 * the first rather than back at the defaults.
 *
 * How big the interface is drawn is deliberately *not* here. It follows the
 * window on its own — see `html { font-size }` in styles.css — and a control
 * for it would be a second answer to a question already answered, with the
 * browser's own zoom as a third.
 */
export interface Settings {
  debug: boolean
  accent: string
  theme: Theme
  bgBlur: number
  bgDim: number
}

const STORAGE_KEY = 'raven61.settings.v1'

const DEFAULTS: Settings = {
  debug: false,
  accent: DEFAULT_ACCENT,
  theme: DEFAULT_THEME,
  /*
   * Not zero, either of them.
   *
   * A wallpaper is the only thing in this app someone can choose that the app
   * then has to draw its own text on, and a photograph at full strength behind
   * a column of 13-pixel labels is unreadable. The defaults are what makes the
   * first picture anyone picks a background rather than a problem; both slide
   * to zero for anyone who wants the picture itself.
   */
  bgBlur: 14,
  bgDim: 55,
}

class SettingsStore {
  private value: Settings = DEFAULTS
  private listeners = new Set<() => void>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.value = known(JSON.parse(raw) as Partial<Settings>)
    } catch {
      // A corrupt or unavailable store just means defaults.
    }
  }

  current(): Settings {
    return this.value
  }

  set<K extends keyof Settings>(key: K, next: Settings[K]): void {
    if (this.value[key] === next) return
    this.value = { ...this.value, [key]: next }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value))
    } catch {
      // Private browsing and blocked storage are fine; it is only a preference.
    }
    for (const fn of this.listeners) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/**
 * Projected onto the fields this version knows about rather than spread over
 * the defaults. Stored settings are only JSON and may be from an older build,
 * a newer one, or a text editor; a key that is no longer a setting should be
 * dropped on the way in instead of being carried around and written back
 * forever.
 */
function known(value: Partial<Settings>): Settings {
  return {
    debug: Boolean(value.debug ?? DEFAULTS.debug),
    // Only the shape is checked here; whether the colour is still one this
    // version offers is state/accent.ts's call, and it decides that every time
    // it applies rather than once at load.
    accent: typeof value.accent === 'string' ? value.accent : DEFAULTS.accent,
    // Same division of labour as the accent above: shape here, and whether the
    // name is still one this version knows is state/theme.ts's call.
    theme: typeof value.theme === 'string' ? (value.theme as Theme) : DEFAULTS.theme,
    // And again: a number is a number here, and whether it is in range is
    // state/background.ts's call, made every time it applies.
    bgBlur: typeof value.bgBlur === 'number' ? value.bgBlur : DEFAULTS.bgBlur,
    bgDim: typeof value.bgDim === 'number' ? value.bgDim : DEFAULTS.bgDim,
  }
}

export const settings = new SettingsStore()

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => settings.subscribe(fn),
    () => settings.current(),
  )
}
