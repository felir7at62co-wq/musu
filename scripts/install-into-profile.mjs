/**
 * Install this package into a DSH profile.
 *
 * A profile resolves plugins through its own `node_modules`, and the profile's
 * `pnpm-workspace.yaml` already treats each `vendor` subdirectory as a workspace
 * member — so this copies the package into `<profile>/vendor/muse/drama`, then adds
 * it to the profile `dependencies` and to `dsh.profile.bundles`, which is what makes
 * the loader apply `cordis.patch.yml`. Both edits are idempotent.
 *
 * Prints the plan and changes nothing unless `--apply` is given.
 *
 * @example
 * node scripts/install-into-profile.mjs --profile web            # plan only
 * node scripts/install-into-profile.mjs --profile web --apply    # write
 */

import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-muse-drama'
const VENDOR_PATH = ['vendor', 'muse', 'drama']
const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)))

/** Harness packages this package's compiled entries import, and that the profile must supply. */
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-jubian',
  '@deepseek-ai/dsh-jubian-api',
  'zod',
]

/**
 * Resolve one harness package to the checkout that built this package's `lib/`.
 *
 * The profile may hold an older vendored copy of the same name and would otherwise
 * win for a row of this package (observed: a vendored `dsh-jubian` without
 * `checkBudget`, which fails the `jubian` row at import time).
 *
 * @param harness - Checkout root.
 * @param name - Package specifier.
 * @returns The package directory, or undefined when the checkout does not carry it.
 */
async function fromCheckout(harness, name) {
  const candidates = [join(harness, 'node_modules', name)]
  for (const group of await readdir(join(harness, 'packages'), { withFileTypes: true }).catch(() => [])) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(harness, 'packages', group.name), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) candidates.push(join(harness, 'packages', group.name, entry.name, 'node_modules', name))
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

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
const link = join(profile, 'node_modules', PACKAGE_NAME)
const needsLink = !existsSync(join(link, 'package.json'))

const harness = flag('harness') ?? process.env.HARNESS ?? 'E:/deepseek-harness'
const peers = existsSync(join(harness, 'packages'))
  ? (await Promise.all(PEERS.map(async name => [name, await fromCheckout(harness, name)])))
    .filter(([, found]) => found !== undefined)
  : []
const missingPeers = peers.filter(([name]) => !existsSync(join(target, 'node_modules', name, 'package.json')))

console.log(`profile:  ${profile}`)
console.log(`vendor:   ${target} ${needsCopy ? '(copy this package)' : '(refresh from this package)'}`)
console.log(`deps:     ${needsDependency ? `add "${PACKAGE_NAME}": "workspace:^"` : 'already declared'}`)
console.log(`bundles:  ${needsBundle ? `append "${PACKAGE_NAME}"` : 'already listed'}`)
console.log(`link:     ${link} ${needsLink ? '(create)' : '(already linked)'}`)
console.log(`peers:    ${missingPeers.length === 0
  ? `${peers.length} harness packages already linked`
  : `link ${missingPeers.map(([name]) => name).join(', ')} from ${harness}`}`)

if (!apply) {
  console.log('\nplan only — re-run with --apply to write. No `pnpm install` is needed: the profile'
    + '\nalready resolves the harness packages it links, and this writes the node_modules link itself.')
  process.exit(0)
}

// Always refreshed: the vendored copy is what the host loads, so a stale one would keep
// serving old rows and old plugin builds after this package changed.
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const entry of ['package.json', 'cordis.patch.yml', 'README.md']) {
  await cp(join(SOURCE, entry), join(target, entry))
}
for (const entry of ['lib', 'runtime', 'skills', 'presets', 'assets', 'scripts']) {
  await cp(join(SOURCE, entry), join(target, entry), { recursive: true })
}
const size = (await stat(join(target, 'package.json'))).size
console.log(`${needsCopy ? 'copied package into the profile' : 'refreshed the vendored copy'} (${size} byte manifest)`)

if (needsLink) {
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await rm(link, { recursive: true, force: true })
  await symlink(target, link, 'junction')
  console.log('linked into the profile node_modules')
}

// Recreated on every apply: the refresh above replaces the whole vendored tree, links included.
for (const [name, found] of peers) {
  const peerLink = join(target, 'node_modules', name)
  await mkdir(dirname(peerLink), { recursive: true })
  await rm(peerLink, { recursive: true, force: true })
  await symlink(found, peerLink, 'junction')
}
if (peers.length > 0) console.log(`linked ${peers.length} harness packages beside the vendored copy`)

if (needsDependency || needsBundle) {
  const backup = `${manifestPath}.bak-musu`
  if (!existsSync(backup)) await cp(manifestPath, backup)
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

console.log('\nnext: restart the host (a live profile patch reload may mount the rows without one).\n'
  + `backup of the previous profile manifest: ${manifestPath}.bak-musu`)
