/**
 * Build identity, resolved from git at build time by vite.config.ts.
 *
 * Reading the constants through this module keeps the rest of the app free of
 * build-time globals, and gives one place for the fallbacks that apply when the
 * build has no git available.
 */
export interface BuildInfo {
  /** `stable` on main, `nightly` elsewhere. */
  channel: string
  branch: string
  /** Short commit hash, hexadecimal. */
  commit: string
  /** Commit date as YYYY-MM-DD — when the code was committed, not built. */
  date: string
  /** The tree had uncommitted changes, so this build is not exactly `commit`. */
  dirty: boolean
}

function read<T>(value: () => T, fallback: T): T {
  try {
    return value()
  } catch {
    return fallback
  }
}

export const BUILD: BuildInfo = {
  channel: read(() => __APP_CHANNEL__, 'dev'),
  branch: read(() => __APP_BRANCH__, ''),
  commit: read(() => __APP_COMMIT__, 'unknown'),
  date: read(() => __APP_DATE__, ''),
  dirty: read(() => __APP_DIRTY__, false),
}

/** e.g. `stable · 2026-08-29 · 3d37be5c` */
export function versionLine(build: BuildInfo = BUILD): string {
  return [build.channel, build.date, build.commit + (build.dirty ? '+' : '')]
    .filter(Boolean)
    .join(' · ')
}
