/**
 * Loads the board definitions a user has dropped into `src/device/user/`.
 *
 * Everything matching `*.device.json` there is bundled at build time, checked
 * by `validate.ts` and registered. There is no runtime importer and no upload
 * button: adding a board means putting the file in the tree and running the
 * build, which is deliberate — a definition decides what bytes get written to
 * someone's keyboard, and the file that does it should be in the source tree
 * where it can be read and kept.
 *
 * A file that fails validation is **skipped**, with every complaint written to
 * the console naming the file and the field. One bad file never stops the app
 * or the other boards from loading.
 *
 * Imported once, from `main.tsx`. `registry.ts` deliberately does not import
 * it: `import.meta.glob` is Vite's, and the protocol checks in `tools/check`
 * bundle these modules under plain node.
 */

import { registerDevice } from './registry'
import { validateSpec } from './validate'

/**
 * Vite inlines this at build time, so the JSON is part of the bundle and there
 * is no fetch at runtime.
 */
const files = import.meta.glob<{ default: unknown }>('./user/*.device.json', { eager: true })

export interface LoadReport {
  loaded: string[]
  skipped: { file: string; errors: string[] }[]
  warnings: { file: string; warnings: string[] }[]
}

export function loadUserSpecs(): LoadReport {
  const report: LoadReport = { loaded: [], skipped: [], warnings: [] }
  for (const [path, module] of Object.entries(files)) {
    const file = path.replace('./user/', '')
    const { spec, errors, warnings } = validateSpec(module.default, file)
    if (warnings.length > 0) report.warnings.push({ file, warnings })
    if (!spec) {
      report.skipped.push({ file, errors })
      continue
    }
    if (!registerDevice(spec)) {
      report.skipped.push({
        file,
        errors: [`${file}: id "${spec.id}" is already registered — keeping the first`],
      })
      continue
    }
    report.loaded.push(`${spec.name} (${spec.id})`)
  }
  return report
}

/**
 * Loads them and says what happened, once, at startup.
 *
 * The console is the right place for this: a spec is a source file, the person
 * who added it is the person running the build, and a validation error is a
 * message for them rather than for whoever uses the app afterwards.
 */
export function loadUserSpecsAndReport(): LoadReport {
  const report = loadUserSpecs()
  for (const { file, warnings } of report.warnings) {
    for (const warning of warnings) console.warn(`device spec ${file}: ${warning}`)
  }
  for (const { errors } of report.skipped) {
    for (const error of errors) console.error(`device spec rejected — ${error}`)
  }
  if (report.loaded.length > 0) {
    console.info(`user device specs loaded: ${report.loaded.join(', ')}`)
  }
  return report
}
