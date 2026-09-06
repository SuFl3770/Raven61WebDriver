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
export const ACCENTS = ['#f8f7b9', '#77ec77'] as const

/**
 * Not `ACCENTS[0]`: this is the colour the stylesheet already declares, so a
 * browser with nothing stored and a browser that has never had the property
 * written look the same. Reordering the list above must not silently change
 * what an existing user sees.
 */
export const DEFAULT_ACCENT = '#77ec77'

export function resolveAccent(value: string): string {
  return (ACCENTS as readonly string[]).includes(value) ? value : DEFAULT_ACCENT
}

/*
 * Written as `--accent-src` — the colour as chosen — rather than as `--accent`,
 * which is what the app actually paints with. The two are the same in the dark
 * theme; in the light one the stylesheet derives `--accent` by knocking the
 * chosen colour down until it can be read as ink on a white panel, and it can
 * only do that if the raw choice arrives under a name it is allowed to sit
 * above. An inline `--accent` would beat every rule in the sheet.
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
