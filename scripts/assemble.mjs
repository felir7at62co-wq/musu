/**
 * Re-vendor this package from a DSH checkout.
 *
 * `lib/` is compiled output, not source: point HARNESS at the checkout to refresh it
 * after a DSH upgrade. Only the generated trees are replaced — package.json,
 * cordis.patch.yml and README.md are hand-written and stay.
 *
 * @example
 * HARNESS=D:/dsh node scripts/assemble.mjs
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HARNESS = process.env.HARNESS ?? 'E:/deepseek-harness'
const OUT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Plugin package directory -> the subpath it takes inside this package. */
const PLUGINS = [
  ['packages/guard/drama-gate', 'drama-gate'],
  ['packages/drama/tool-drama-assets', 'drama-assets'],
  ['packages/drama/tool-shot-script', 'drama-shot'],
  ['packages/drama/tool-bgm-compose', 'drama-bgm'],
  ['packages/drama/tool-episode-render', 'drama-render'],
  ['packages/drama/drama-settings', 'drama-settings'],
  ['packages/jubian/tool-jubian', 'jubian'],
  ['packages/perception/perception-bgm', 'bgm-match'],
]

/** Skill directory names never copied: the ASR model alone is 461 MB. */
const SKIP_DIRS = new Set(['models', '__pycache__', 'node_modules', '.venv', '.git'])

/** Brand images shipped with the package, plus where they live in the checkout. */
const ASSETS = [
  ['apps/web/public/muse-med-logo.png', 'muse-med-logo.png'],
  ['apps/web/public/muse-med-logo-black.webp', 'muse-med-logo-black.webp'],
  ['apps/web/public/muse-med-logo-white.webp', 'muse-med-logo-white.webp'],
]

async function copyDir(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.tsbuildinfo'))) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else await cp(source, target)
  }
}

await rm(join(OUT, 'lib'), { recursive: true, force: true })
await rm(join(OUT, 'skills'), { recursive: true, force: true })
await rm(join(OUT, 'presets'), { recursive: true, force: true })
await rm(join(OUT, 'assets'), { recursive: true, force: true })
await mkdir(join(OUT, 'lib'), { recursive: true })

for (const [dir, id] of PLUGINS) {
  const lib = join(HARNESS, dir, 'lib')
  if (!existsSync(lib)) throw new Error(`missing build output: ${lib} (run the DSH build first)`)
  await mkdir(join(OUT, 'lib', id), { recursive: true })
  for (const entry of await readdir(lib, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    await cp(join(lib, entry.name), join(OUT, 'lib', id, entry.name))
  }
  console.log(`plugin ${id}: ${(await readdir(join(OUT, 'lib', id))).join(', ')}`)
}

const skillsRoot = join(HARNESS, 'packages/drama/skills/skills')
const skills = (await readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
for (const skill of skills) await copyDir(join(skillsRoot, skill.name), join(OUT, 'skills', skill.name))
console.log(`skills copied: ${skills.length}`)

/**
 * Read `name`, `description` and `whenToUse` out of one skill's frontmatter.
 *
 * The runtime plugin reads `skills/index.json` instead of parsing YAML, so this is the
 * only place that has to understand the frontmatter — and it says so out loud when a
 * skill cannot be described, rather than shipping a silently missing skill.
 *
 * @param file - Absolute path to a `SKILL.md`.
 * @returns The three routing fields, or undefined when the frontmatter carries no name.
 */
function readSkillHeader(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return undefined
  const fields = {}
  let key = null
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = /^([A-Za-z][\w-]*):\s?(.*)$/u.exec(line)
    if (match !== null) {
      key = match[1]
      const value = match[2].trim()
      fields[key] = value === '>' || value === '|' || value === '>-' || value === '|-' ? '' : value
      continue
    }
    if (key !== null && /^\s+\S/u.test(line)) fields[key] = `${fields[key] ?? ''} ${line.trim()}`.trim()
    else key = null
  }
  const unquote = value => value === undefined ? undefined
    : value.replace(/^["'](.*)["']$/su, '$1').trim() || undefined
  const name = unquote(fields.name)
  return name === undefined ? undefined : {
    name,
    description: unquote(fields.description) ?? name,
    ...unquote(fields.whenToUse) === undefined ? {} : { whenToUse: unquote(fields.whenToUse) },
  }
}

const index = []
for (const skill of skills) {
  const header = readSkillHeader(join(OUT, 'skills', skill.name, 'SKILL.md'))
  if (header === undefined) {
    console.log(`skill WITHOUT readable frontmatter (not registered): ${skill.name}`)
    continue
  }
  if (header.name !== skill.name) console.log(`skill name differs from its directory: ${skill.name} -> ${header.name}`)
  index.push({ ...header, directory: skill.name })
}
await writeFile(join(OUT, 'skills', 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`skills indexed: ${index.length}`)

const preset = process.env.PRESET ?? 'C:/Users/EDY/.dsh/.agent-presets/short-drama-local'
await mkdir(join(OUT, 'presets/short-drama'), { recursive: true })
for (const name of await readdir(preset)) {
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
  await cp(join(preset, name), join(OUT, 'presets/short-drama', name))
  console.log(`preset file: ${name}`)
}

await mkdir(join(OUT, 'assets'), { recursive: true })
for (const [from, name] of ASSETS) {
  const source = join(HARNESS, from)
  if (!existsSync(source)) { console.log(`asset missing: ${from}`); continue }
  await cp(source, join(OUT, 'assets', name))
  const info = await stat(join(OUT, 'assets', name))
  console.log(`asset ${name}: ${Math.round(info.size / 1024)} KB`)
}
