import { settings } from './settings'

/**
 * The point colour, as a preference.
 *
 * A short list rather than a colour picker. Everything interactive in the app
 * is this one hue and several things are mixed from it — the fill behind a
 * selected tab, the ring on a focused control — so a free choice would let
 * someone land on a colour that reads as an error, or one that disappears into
 * the page. These are picked to work against the surfaces they sit on.
 *
 * The stylesheet's own `--accent-src` is the default, and this only ever
 * overrides it as an inline property on the root element. With nothing stored,
 * or with a value that is not on the list any more, the page keeps what the
 * stylesheet says — see styles.css.
 */
export const ACCENTS = ["#6366F1", "#7C3AED", "#E11D48", "#0284C7",
 "#0D9488", "#D97706", "#D8BD68", "#0891B2"] as const

/**
 * Not `ACCENTS[0]`: this is the colour the stylesheet already declares, so a
 * browser with nothing stored and a browser that has never had the property
 * written look the same. Reordering the list above must not silently change
 * what an existing user sees.
 */
export const DEFAULT_ACCENT = '#D8BD68'

export function resolveAccent(value: string): string {
  return (ACCENTS as readonly string[]).includes(value) ? value : DEFAULT_ACCENT
}

/*
 * Written as `--accent-src` — the colour as chosen — rather than as `--accent`,
 * which is what the app actually paints with. The two hold the same colour in
 * both themes, but the sheet mixes the fills and edges it needs off `--accent`,
 * and an inline `--accent` would beat every rule that does so.
 */
function apply(): void {
  document.documentElement.style.setProperty(
    '--accent-src',
    resolveAccent(settings.current().accent),
  )
}

/**
 * Wire the stored choice to the root element.
 *
 * Called from main.tsx before the first render rather than from an effect, so
 * the app is painted once in the colour it is going to keep instead of
 * flashing the stylesheet's default first.
 */
export function startAccent(): void {
  apply()
  settings.subscribe(apply)
}
