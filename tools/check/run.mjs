/**
 * Runs the checks in this directory under node. `npm run check`.
 *
 * There is no test framework here on purpose: the checks are a handful of
 * assertions about byte layouts and packet sequences, and they need to import
 * the real `src/protocol` modules rather than a copy. esbuild bundles each one
 * to a temporary ESM file, a small shim stands in for the browser globals the
 * i18n layer touches at import time, and node runs it.
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * `src/i18n` detects a locale when its module loads, and the protocol layer
 * imports it for its log messages. Nothing here exercises the browser, so the
 * globals only have to exist.
 */
const SHIM = `
globalThis.navigator = { languages: ['ko'], language: 'ko' }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.document = { documentElement: {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }
await import(process.argv[2])
`

const files = (await readdir(here)).filter((f) => f.endsWith('.ts')).sort()
if (files.length === 0) {
  console.error('no checks found in tools/check')
  process.exit(1)
}

const dir = await mkdtemp(join(tmpdir(), 'raven61-check-'))
const shim = join(dir, 'shim.mjs')
await writeFile(shim, SHIM)

let failed = 0
try {
  for (const file of files) {
    const out = join(dir, basename(file, '.ts') + '.mjs')
    await build({
      entryPoints: [join(here, file)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: out,
      logLevel: 'error',
    })
    process.stdout.write(`${file}: `)
    const { spawnSync } = await import('node:child_process')
    const run = spawnSync(process.execPath, [shim, pathToFileURL(out).href], {
      stdio: 'inherit',
    })
    if (run.status !== 0) failed++
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
