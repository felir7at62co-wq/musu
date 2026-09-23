/**
 * Load this package the way a DSH profile does, and report what each row registered.
 *
 * Two modes:
 *   node scripts/verify-load.mjs                # this package's own subpaths
 *   node scripts/verify-load.mjs --profile web   # the rows a real profile's bundles contribute
 *
 * Both boot a real Cordis Loader over a generated `cordis.yml`, import the same compiled
 * files the host would import, and read the Tool registry — the evidence a profile shows,
 * without touching any host or profile.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_NAME = 'dsh-muse-drama'

/** Package subpath -> the tool names the row must register (`null` = guard/settings row). */
const EXPECTED = new Map([
  ['jubian', ['jubian_catalog', 'jubian_asset', 'jubian_video', 'jubian_storyboard', 'jubian_media', 'jubian_organize', 'jubian_model', 'jubian_watch']],
  ['drama-gate', null],
  ['drama-assets', ['drama_assets']],
  ['drama-shot', ['drama_shot']],
  ['drama-bgm', ['drama_bgm']],
  ['drama-render', ['drama_render', 'drama_video']],
  ['drama-settings', null],
  ['bgm-match', ['bgm_match']],
  ['skill-source', null],
])

/** Where one subpath's entry lives: the vendored plugins under `lib/`, hand-written code under `runtime/`. */
function entryOf(id) {
  return id === 'skill-source' ? join(ROOT, 'runtime', 'skills.js') : join(ROOT, 'lib', id, 'index.js')
}

/** Host services these plugins inject but this verification composition does not mount. */
const STUBS = [
  ['musu-verify/credentials', { name: 'verify-credentials', apply(ctx) { ctx.provide('credentials', { resolve: async () => undefined }) } }],
  ['musu-verify/subprocess', { name: 'verify-subprocess', apply(ctx) { ctx.provide('subprocess', {}) } }],
]

/** Rows this package would contribute on its own, keyed by subpath. */
async function ownRows() {
  const rows = new Map()
  for (const id of EXPECTED.keys()) rows.set(`${PACKAGE_NAME}/${id}`, entryOf(id))
  return rows
}

/** Rows a real profile's bundle layers contribute, resolved through that profile's resolver. */
async function profileRows(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const rows = new Map()
  for (const bundle of manifest.dsh?.profile?.bundles ?? []) {
    let patch
    try {
      patch = require.resolve(`${bundle}/cordis.patch.yml`)
    } catch {
      continue
    }
    // Bundle patches may carry `!!js` config expressions this check does not evaluate.
    const layers = YAML.parse(await readFile(patch, 'utf8'), { logLevel: 'silent' }) ?? []
    for (const layer of Array.isArray(layers) ? layers : []) {
      for (const row of layer?.insert ?? []) {
        if (typeof row?.name !== 'string' || !row.name.startsWith(`${PACKAGE_NAME}/`)) continue
        rows.set(row.name, require.resolve(row.name))
      }
    }
  }
  return rows
}

const argv = process.argv.slice(2)
const flagIndex = argv.indexOf('--profile')
const profileName = flagIndex === -1 ? undefined : argv[flagIndex + 1]
const profileDir = profileName === undefined
  ? undefined
  : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName)

const rows = profileDir === undefined ? await ownRows() : await profileRows(profileDir)
if (rows.size === 0) {
  console.error(profileName === undefined ? 'no rows found' : `profile ${profileName} contributes no ${PACKAGE_NAME} rows`)
  process.exit(1)
}

const root = await mkdtemp(join(tmpdir(), 'musu-load-'))
const ctx = new Context()
let failures = 0
try {
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    ...STUBS.map(([specifier]) => `- name: '${specifier}'`),
    ...[...rows.keys()].map(name => `- name: '${name}'`),
    '',
  ].join('\n'))

  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const modules = new Map([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-skill', Skills],
    ...STUBS,
    ...[...rows].map(([name, file]) => [name, undefined]),
  ])
  for (const [name, file] of rows) modules.set(name, await import(pathToFileURL(file).href))

  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      const found = modules.get(specifier)
      if (found === undefined) throw new Error(`Unexpected module ${specifier}`)
      return found
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()

  const registered = new Set((ctx.tools.schemas() ?? []).map(schema => schema.name))
  for (const name of rows.keys()) {
    const id = name.slice(PACKAGE_NAME.length + 1)
    const expected = EXPECTED.get(id)
    const entry = [...ctx.loader.entries()].find(row => String(row.options.name) === name)
    const error = entry?.fiber?.error
    const missing = (expected ?? []).filter(tool => !registered.has(tool))
    const state = error !== undefined && error !== null
      ? `ROW ERROR: ${error.message}`
      : missing.length === 0 ? 'ok' : `MISSING TOOLS: ${missing.join(', ')}`
    if (state !== 'ok') failures += 1
    console.log(`${id.padEnd(16)} ${state}`)
  }
  const drama = [...registered].filter(tool => /^(drama_|jubian_|bgm_match)/.test(tool)).sort()
  console.log(`\nrows: ${rows.size}${profileDir === undefined ? '' : ` (from profile ${profileName})`}`)
  console.log(`registered drama tools (${drama.length}): ${drama.join(', ')}`)

  const skills = ctx.get('skills')
  const expected = JSON.parse(await readFile(join(ROOT, 'skills', 'index.json'), 'utf8')).map(entry => entry.name)
  let listed = []
  if (skills !== undefined) {
    const read = typeof skills.list === 'function' ? skills.list : skills.catalog
    if (typeof read === 'function') {
      const result = await read.call(skills, {})
      listed = (Array.isArray(result) ? result : result?.items ?? []).map(entry => entry.name)
    }
  }
  const missingSkills = expected.filter(skill => !listed.includes(skill))
  if (missingSkills.length > 0) failures += 1
  console.log(`registered skills: ${listed.length}/${expected.length}`
    + (missingSkills.length === 0 ? '' : ` — MISSING: ${missingSkills.join(', ')}`))
  console.log(failures === 0 ? '\nVERIFY: all rows applied, tools and skills registered' : `\nVERIFY: ${failures} check(s) failed`)
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
