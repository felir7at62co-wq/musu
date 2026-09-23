/**
 * Load this package the way a DSH profile does, and report what each row registered.
 *
 * Boots a real Cordis Loader (`cordis-plugin-loader`) over a `cordis.yml` whose rows
 * name this package's subpaths, then reads the Tool registry — the same evidence a
 * profile shows, without touching any profile on the machine.
 *
 * @example
 * node scripts/verify-load.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Package subpath -> the tool names the row must register (`null` = guard/settings row). */
const ROWS = [
  ['jubian', ['jubian_catalog', 'jubian_asset', 'jubian_video', 'jubian_storyboard', 'jubian_media', 'jubian_organize', 'jubian_model', 'jubian_watch']],
  ['drama-gate', null],
  ['drama-assets', ['drama_assets']],
  ['drama-shot', ['drama_shot']],
  ['drama-bgm', ['drama_bgm']],
  ['drama-render', ['drama_render', 'drama_video']],
  ['drama-settings', null],
  ['bgm-match', ['bgm_match']],
]

const root = await mkdtemp(join(tmpdir(), 'musu-load-'))
const ctx = new Context()
let failures = 0

/** Host services this package injects but the verification composition does not mount. */
const STUBS = [
  ['musu-verify/credentials', { name: 'verify-credentials', apply(ctx) { ctx.provide('credentials', { resolve: async () => undefined }) } }],
  ['musu-verify/subprocess', { name: 'verify-subprocess', apply(ctx) { ctx.provide('subprocess', {}) } }],
]

try {
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    ...STUBS.map(([specifier]) => `- name: '${specifier}'`),
    ...ROWS.map(([id]) => `- name: 'dsh-muse-drama/${id}'`),
    '',
  ].join('\n'))

  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const modules = new Map([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ...STUBS,
  ])
  for (const [id] of ROWS) {
    modules.set(`dsh-muse-drama/${id}`, await import(pathToFileURL(join(ROOT, 'lib', id, 'index.js')).href))
  }
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
  for (const [id, expected] of ROWS) {
    const entry = [...ctx.loader.entries()].find(row => String(row.options.name).endsWith(`/${id}`))
    const error = entry?.fiber?.error
    const missing = (expected ?? []).filter(name => !registered.has(name))
    const state = error !== undefined && error !== null ? `ROW ERROR: ${error.message}` : missing.length === 0 ? 'ok' : `MISSING TOOLS: ${missing.join(', ')}`
    if (state !== 'ok') failures += 1
    console.log(`${id.padEnd(16)} ${state}`)
  }
  const drama = [...registered].filter(name => /^(drama_|jubian_|bgm_match)/.test(name)).sort()
  console.log(`\nregistered drama tools (${drama.length}): ${drama.join(', ')}`)
  console.log(failures === 0 ? '\nVERIFY: all rows applied and registered their tools' : `\nVERIFY: ${failures} row(s) failed`)
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
