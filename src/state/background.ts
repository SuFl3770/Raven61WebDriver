import { useSyncExternalStore } from 'react'
import { settings } from './settings'

/**
 * The page's own wallpaper: an image behind the app, as a preference.
 *
 * Almost nothing in this interface is a box — a panel is a run of padding down
 * the page rather than a card (see `.panel` in styles.css) — so the page colour
 * is most of what the window actually is. Putting a picture there changes how
 * readable everything on it is, which is why the image arrives with two amounts
 * attached rather than on its own: how far it is blurred, and how much of the
 * page colour is laid back over it. Both live in `settings` with the theme and
 * the accent, because they are the same kind of thing — how this browser draws
 * the app, and none of it reaches the board.
 *
 * ## Why the image is not in `settings`
 *
 * Everything else the app remembers is a word or a number and goes to
 * `localStorage`. A photograph does not: the quota there is a few megabytes of
 * *string*, so a base64 copy of a wallpaper either does not fit or fills the
 * store every other preference shares — and a quota error in that store would
 * take the theme and the accent down with it. So the bytes go to IndexedDB, as
 * the `Blob` the file picker already handed us, and only the two numbers stay
 * with the rest of the preferences.
 *
 * That split is also why this module has a store of its own. IndexedDB is
 * asynchronous, so the image cannot be in place before the first paint the way
 * the theme is — the app starts on its plain background and the wallpaper
 * arrives a frame or two later. Nothing depends on it being there, so a read
 * that is slow, blocked, or refused outright just means no wallpaper.
 */

const DB_NAME = 'raven61'
const DB_VERSION = 1
const STORE = 'background'
/** One image, so one key: setting a new one replaces the record. */
const KEY = 'image'

/** What the file picker offers. */
export const IMAGE_ACCEPT = 'image/*'

/**
 * As big an image as this will keep.
 *
 * IndexedDB would take far more, and that is the problem: a 60-megapixel
 * original is a wallpaper the browser decodes on every load to draw something
 * the window shows at a fraction of the size. The limit is stated so the picker
 * can refuse with a sentence, rather than leaving someone with an app that
 * takes a second to paint and no clue why.
 */
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024

/** How far the picture can be blurred, and how far it can be veiled. */
export const BLUR_MAX = 60
export const DIM_MAX = 90

export function clampBlur(value: number): number {
  return Number.isFinite(value) ? Math.min(BLUR_MAX, Math.max(0, Math.round(value))) : 0
}

export function clampDim(value: number): number {
  return Number.isFinite(value) ? Math.min(DIM_MAX, Math.max(0, Math.round(value))) : 0
}

/** The image as the page can use it: an object URL, and the name it came in as. */
export interface BackgroundImage {
  url: string
  name: string
}

interface StoredImage {
  blob: Blob
  name: string
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    // Private browsing, a blocked origin, a database another tab is holding
    // open across a version change. All of them mean the same thing here.
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused'))
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}

/**
 * One transaction, with the connection closed after it.
 *
 * Held open, a connection blocks a version change in another tab of the same
 * app — and this is a preference touched once in a while, not a hot path, so
 * the open costs nothing worth keeping a handle for.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = fn(tx.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'))
    })
  } finally {
    db.close()
  }
}

class BackgroundStore {
  private image: BackgroundImage | null = null
  private listeners = new Set<() => void>()

  current(): BackgroundImage | null {
    return this.image
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** What is stored, put on screen. Called once, from {@link startBackground}. */
  async restore(): Promise<void> {
    try {
      const stored = await withStore<StoredImage | undefined>('readonly', (store) =>
        store.get(KEY),
      )
      if (stored?.blob instanceof Blob) this.hold(stored.blob, stored.name)
    } catch {
      // A store that cannot be read is a browser without a wallpaper.
    }
  }

  /**
   * Keep this file, then show it.
   *
   * Written before it is shown rather than after: the whole point of the
   * control is that the choice survives a reload, so a browser that will not
   * store it should say so instead of showing a wallpaper that quietly
   * disappears on the next load.
   */
  async set(file: File): Promise<void> {
    await withStore('readwrite', (store) =>
      store.put({ blob: file, name: file.name } satisfies StoredImage, KEY),
    )
    this.hold(file, file.name)
  }

  async clear(): Promise<void> {
    try {
      await withStore('readwrite', (store) => store.delete(KEY))
    } finally {
      // Off the screen either way. A delete that failed leaves a record that
      // comes back on the next load, which is a smaller surprise than a page
      // that ignored the button that was just pressed.
      this.hold(null, null)
    }
  }

  /**
   * Swap in a new object URL and let the old one go.
   *
   * An object URL keeps its blob alive for the life of the document, so
   * changing wallpaper five times without revoking leaves five images in
   * memory — and the four that are not on screen are not coming back.
   */
  private hold(blob: Blob | null, name: string | null): void {
    if (this.image) URL.revokeObjectURL(this.image.url)
    this.image = blob ? { url: URL.createObjectURL(blob), name: name ?? '' } : null
    for (const fn of this.listeners) fn()
  }
}

export const background = new BackgroundStore()

export function useBackground(): BackgroundImage | null {
  return useSyncExternalStore(
    (fn) => background.subscribe(fn),
    () => background.current(),
  )
}

/*
 * Three properties and a flag on the root element — see `:root[data-bg]` in
 * styles.css, which is where the layers themselves are drawn.
 *
 * The flag is what turns those layers on, rather than an absent `--bg-image`: a
 * veil keyed on the image alone would go on darkening a page that has no
 * picture under it, and the layer would still be composited to draw nothing.
 */
function apply(): void {
  const root = document.documentElement
  const image = background.current()
  const { bgBlur, bgDim } = settings.current()

  if (image) {
    root.style.setProperty('--bg-image', `url("${image.url}")`)
    root.dataset.bg = 'on'
  } else {
    root.style.removeProperty('--bg-image')
    delete root.dataset.bg
  }
  root.style.setProperty('--bg-blur', `${clampBlur(bgBlur)}px`)
  root.style.setProperty('--bg-dim', String(clampDim(bgDim) / 100))
}

/**
 * Wire the stored choice to the root element.
 *
 * Called from main.tsx like the theme and the accent — but unlike them it does
 * not finish before the first render. The two amounts are applied at once,
 * since they come from `localStorage`; the picture follows when IndexedDB
 * answers.
 */
export function startBackground(): void {
  apply()
  settings.subscribe(apply)
  background.subscribe(apply)
  void background.restore()
}
