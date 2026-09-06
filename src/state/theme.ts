import { settings } from './settings'

/**
 * Light or dark, as a preference.
 *
 * Three values rather than two. The app was drawn dark first and everything in
 * it is written against a ladder of fills (see styles.css), so "dark" is not
 * merely the default — it is what the stylesheet itself declares, and pinning
 * it has to stay possible for someone whose machine says light but who wants
 * the interface it was designed as. "system" exists because a browser tab that
 * ignores the desktop it is on is the odd one out on that desktop.
 */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/**
 * Not `THEMES[0]`: this is the theme the stylesheet already paints, so a
 * browser with nothing stored and a browser that has never had the attribute
 * written look the same. Following the machine is a choice someone makes, not
 * one made for them by upgrading.
 */
export const DEFAULT_THEME: Theme = 'dark'

export function resolveTheme(value: string): Theme {
  return (THEMES as readonly string[]).includes(value) ? (value as Theme) : DEFAULT_THEME
}

/**
 * The one media query this app asks the platform.
 *
 * Made on first use rather than at module scope, so the state layer stays
 * importable where there is no window — the hardware checks under tools/check
 * pull pieces of it in under node — and *kept* once made, which is the part
 * that matters. A `MediaQueryList` is collectable while nothing but its own
 * listener refers to it, and a collected one simply stops reporting changes:
 * the query still answers when asked, so the bug looks like "following the
 * system works until it doesn't" rather than like a missing listener.
 */
let query: MediaQueryList | null = null

function media(): MediaQueryList | null {
  if (!query && typeof window !== 'undefined' && window.matchMedia) {
    query = window.matchMedia('(prefers-color-scheme: light)')
  }
  return query
}

/** What the preference resolves to right now: never "system", always a paint. */
export function effectiveTheme(value: Theme): 'light' | 'dark' {
  if (value !== 'system') return value
  return media()?.matches ? 'light' : 'dark'
}

function apply(): void {
  const theme = effectiveTheme(resolveTheme(settings.current().theme))
  // Written for both, not only for light. The attribute is what the light block
  // in styles.css keys off, and leaving it absent for dark would mean the two
  // themes are told apart by presence rather than by value — which anything
  // wanting to read the current theme back out would have to know.
  document.documentElement.dataset.theme = theme
}

/**
 * Wire the stored choice to the root element.
 *
 * Called from main.tsx before the first render rather than from an effect, so
 * the app is painted once in the theme it is going to keep instead of flashing
 * the stylesheet's dark default first. The media listener is attached for the
 * life of the page even while the preference is pinned: it costs nothing, and
 * it means switching to "system" is live rather than waiting for a reload.
 */
export function startTheme(): void {
  apply()
  settings.subscribe(apply)
  media()?.addEventListener('change', apply)
}
