import { useSyncExternalStore } from 'react'
import en from './locales/en.json'
import ko from './locales/ko.json'

/**
 * Tiny in-house i18n layer.
 *
 * There is no runtime dependency on purpose: the app ships two small bundles
 * and needs lookup, interpolation and a two-form plural — an i18n library
 * would be larger than the feature. Everything a translator touches lives in
 * `locales/*.json`; nothing in `src/` outside this folder holds display text.
 *
 * Korean is the reference bundle: it is the language the UI was written in, so
 * it is the one guaranteed to be complete and the one a missing key falls back
 * to. `MessageKey` is derived from it, which makes a typo or a key that only
 * exists in a translation a compile error rather than a blank label.
 */

export const LOCALES = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/** The bundle keys are derived from, and the fallback for a missing message. */
export const REFERENCE_LOCALE: Locale = 'ko'

/** Dot paths to every string leaf in the reference bundle. */
type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`
}[keyof T & string]

export type MessageKey = Paths<typeof ko>

export type MessageParams = Record<string, string | number>

type Bundle = Record<string, string>

function flatten(node: unknown, prefix = '', out: Bundle = {}): Bundle {
  if (typeof node === 'string') {
    out[prefix] = node
    return out
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out)
  }
  return out
}

const BUNDLES: Record<Locale, Bundle> = { ko: flatten(ko), en: flatten(en) }

const STORAGE_KEY = 'raven61.locale.v1'

function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.id === value)
}

/**
 * Stored choice first, then the browser's list. Region subtags are dropped, so
 * `ko-KR` and `en-GB` both land on a bundle we have.
 */
function detect(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // Blocked storage just means we detect every load.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}

class I18n {
  private locale: Locale = detect()
  private listeners = new Set<() => void>()

  constructor() {
    this.applyDocumentLang()
  }

  current(): Locale {
    return this.locale
  }

  set(next: Locale): void {
    if (this.locale === next) return
    this.locale = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Preference only; not worth surfacing.
    }
    this.applyDocumentLang()
    for (const fn of this.listeners) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private applyDocumentLang(): void {
    document.documentElement.lang = this.locale
  }
}

export const i18n = new I18n()

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

/**
 * Look a message up in `locale`, then in the reference bundle. A key missing
 * from both is returned as-is so the UI shows the path instead of nothing —
 * `MessageKey` should make that unreachable, but a hand-edited bundle can
 * still drop a line.
 *
 * `count` additionally selects between `<key>_one` and `<key>_other` when
 * those exist, which is what English needs and Korean ignores.
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const candidates =
    params && typeof params.count === 'number'
      ? [`${key}_${params.count === 1 ? 'one' : 'other'}`, key]
      : [key]

  for (const candidate of candidates) {
    const hit = BUNDLES[locale][candidate] ?? BUNDLES[REFERENCE_LOCALE][candidate]
    if (hit !== undefined) return interpolate(hit, params)
  }
  return key
}

/**
 * Translate outside React — log lines, thrown messages, values computed in the
 * protocol layer. Text produced this way is frozen at the language in effect
 * when it was produced, which is right for a log and wrong for a label, so
 * components should use {@link useT} instead.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(i18n.current(), key, params)
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (fn) => i18n.subscribe(fn),
    () => i18n.current(),
  )
}

/** The translator for the active locale; re-renders the caller on a change. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const locale = useLocale()
  return (key, params) => translate(locale, key, params)
}
