/**
 * Register the short-drama skills this package ships.
 *
 * `skills/index.json` is written when the package is assembled, so nothing here parses
 * YAML at runtime: the plugin reads the precomputed routing fields and each skill's own
 * body, and registers it against the `skills` service. `resourceBase` points at the
 * skill's directory so the relative `scripts/…` paths in its body stay resolvable.
 *
 * A skill that cannot be read is reported and skipped rather than silently dropped.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, reached from `runtime/skills.js`. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directory holding the shipped skills and their precomputed index. */
const SKILLS = join(ROOT, 'skills')

export const name = 'muse-drama-skills'

export const inject = ['skills']

/**
 * Strip the YAML frontmatter block the loader keeps out of a skill body.
 * @param markdown - Raw `SKILL.md` text.
 * @returns The instruction body alone.
 */
function bodyOf(markdown) {
  const lines = markdown.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return markdown
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end === -1 ? markdown : lines.slice(end + 1).join('\n').replace(/^\n+/u, '')
}

/**
 * Register every skill the package ships.
 * @param ctx - Cordis context carrying the `skills` service.
 */
export function apply(ctx) {
  let index
  try {
    index = JSON.parse(readFileSync(join(SKILLS, 'index.json'), 'utf8'))
  } catch (error) {
    ctx.logger.warn(`muse-drama skills: cannot read skills/index.json: ${error.message}`)
    return
  }
  for (const entry of Array.isArray(index) ? index : []) {
    const directory = join(SKILLS, String(entry.directory))
    let body
    try {
      body = bodyOf(readFileSync(join(directory, 'SKILL.md'), 'utf8'))
    } catch (error) {
      ctx.logger.warn(`muse-drama skill "${entry.name}" ignored: ${error.message}`)
      continue
    }
    ctx.effect(() => ctx.skills.register({
      name: String(entry.name),
      description: String(entry.description),
      ...(entry.whenToUse === undefined ? {} : { whenToUse: String(entry.whenToUse) }),
      content: body,
      source: 'bundled',
      path: join(directory, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: directory },
    }))
  }
}
