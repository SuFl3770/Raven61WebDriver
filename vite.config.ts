import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function git(args: string, fallback = ''): string {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No git, no repository, or a source tarball — the badge falls back.
    return fallback
  }
}

/**
 * `main` ships as stable, every other branch as nightly.
 *
 * CI checks out a detached HEAD, so when the branch name is unavailable we look
 * at which branches point at this commit instead. RAVEN_CHANNEL overrides both,
 * for builds where neither is meaningful.
 */
function resolveChannel(branch: string): string {
  const override = process.env.RAVEN_CHANNEL
  if (override) return override
  const names =
    branch && branch !== 'HEAD'
      ? [branch]
      : git('branch --points-at HEAD --format=%(refname:short)')
          .split('\n')
          .map((n) => n.trim())
  return names.includes('main') ? 'stable' : 'nightly'
}

// Sampled once, when the config loads. A running dev server therefore keeps
// showing the commit it started on; production builds are always current.
const branch = git('rev-parse --abbrev-ref HEAD')
const commit = git('rev-parse --short=8 HEAD', 'unknown')
// %cs is the committer date as YYYY-MM-DD: the commit's date, not the build's.
const commitDate = git('log -1 --format=%cs')
const dirty = git('status --porcelain') !== ''

export default defineConfig({
  // base: '' keeps the build relocatable (GitHub Pages, file://, sub-paths).
  base: '',
  plugins: [react()],
  server: { port: 5173 },
  define: {
    __APP_CHANNEL__: JSON.stringify(resolveChannel(branch)),
    __APP_BRANCH__: JSON.stringify(branch),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_DATE__: JSON.stringify(commitDate),
    __APP_DIRTY__: JSON.stringify(dirty),
  },
})
