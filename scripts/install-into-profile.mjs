/**
 * Install this package into a DSH profile.
 *
 * A profile resolves plugins through its own `node_modules`, and the profile's
 * `pnpm-workspace.yaml` already treats `vendor/*/*` as workspace members — so this
 * copies the package into `<profile>/vendor/muse/drama`, then adds it to the profile
 * `dependencies` and to `dsh.profile.bundles`, which is what makes the loader apply
 * `cordis.patch.yml`. Both edits are idempotent.
 *
 * Prints the plan and changes nothing unless `--apply` is given.
 *
 * @example
 * node scripts/install-into-profile.mjs --profile web            # plan only
 * node scripts/install-into-profile.mjs --profile web --apply    # write
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-muse-drama'
const VENDOR_PATH = ['vendor', 'muse', 'drama']
const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)))

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const dshHome = flag('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = flag('profile') ?? 'web'
const profile = join(dshHome, 'profiles', profileName)
const target = join(profile, ...VENDOR_PATH)

if (!existsSync(join(profile, 'package.json'))) {
  console.error(`not a profile: ${profile}`)
  process.exit(1)
}

const manifestPath = join(profile, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const dependencies = manifest.dependencies ?? {}
const bundles = manifest.dsh?.profile?.bundles ?? []

const needsCopy = !existsSync(join(target, 'package.json'))
const needsDependency = dependencies[PACKAGE_NAME] === undefined
const needsBundle = !bundles.includes(PACKAGE_NAME)

console.log(`profile:  ${profile}`)
console.log(`vendor:   ${target} ${needsCopy ? '(copy this package)' : '(already vendored)'}`)
console.log(`deps:     ${needsDependency ? `add "${PACKAGE_NAME}": "workspace:^"` : 'already declared'}`)
console.log(`bundles:  ${needsBundle ? `append "${PACKAGE_NAME}"` : 'already listed'}`)

if (!needsCopy && !needsDependency && !needsBundle) {
  console.log('\nnothing to do; restart the host if the plugin is not mounted yet')
  process.exit(0)
}

if (!apply) {
  console.log('\nplan only — re-run with --apply to write, then run `pnpm install` in the profile and restart the host')
  process.exit(0)
}

if (needsCopy) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const entry of ['package.json', 'cordis.patch.yml', 'README.md']) {
    await cp(join(SOURCE, entry), join(target, entry))
  }
  for (const entry of ['lib', 'skills', 'presets', 'assets', 'scripts']) {
    await cp(join(SOURCE, entry), join(target, entry), { recursive: true })
  }
  const size = (await stat(join(target, 'package.json'))).size
  console.log(`copied package (${size} byte manifest)`)
}

if (needsDependency || needsBundle) {
  manifest.dependencies = { ...dependencies, ...needsDependency ? { [PACKAGE_NAME]: 'workspace:^' } : {} }
  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      ...manifest.dsh?.profile,
      bundles: needsBundle ? [...bundles, PACKAGE_NAME] : bundles,
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log('updated profile package.json')
}

console.log(`\nnext: cd "${profile}" && pnpm install, then restart the host`)
