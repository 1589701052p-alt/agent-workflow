// Parses a SKILL.md (YAML frontmatter + markdown body) into a typed shape
// suitable for ZIP-batch import. Pure function — no IO, no exceptions; YAML
// failures surface via `warnings`.
//
// Distinct from `agent-md.ts` because the SKILL.md schema is narrower (only
// `name` + `description` get first-class treatment; everything else lands in
// `frontmatterExtra`).

import { parse as parseYaml } from 'yaml'

export interface SkillMarkdownParseResult {
  name: string | undefined
  description: string
  bodyMd: string
  frontmatterExtra: Record<string, unknown>
  warnings: string[]
  hadFrontmatter: boolean
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function trimBody(body: string): string {
  return body.replace(/^[\s\r\n]+/, '').replace(/[\s\r\n]+$/, '')
}

export function parseSkillMarkdown(raw: string): SkillMarkdownParseResult {
  const warnings: string[] = []
  const match = raw.match(FRONTMATTER_RE)
  const hadFrontmatter = match !== null

  let data: Record<string, unknown> = {}
  let body: string

  if (!match) {
    body = raw
  } else {
    body = match[2] ?? ''
    const yamlSrc = match[1] ?? ''
    let parsed: unknown
    try {
      parsed = parseYaml(yamlSrc)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`yaml-parse-failed: ${message}`)
      parsed = null
    }
    if (parsed === null || parsed === undefined) {
      data = {}
    } else if (!isPlainObject(parsed)) {
      warnings.push('frontmatter-not-object: top-level YAML must be a mapping; ignored')
      data = {}
    } else {
      data = parsed
    }
  }

  let name: string | undefined
  if (data.name !== undefined) {
    if (isNonEmptyString(data.name)) {
      name = data.name
    } else {
      warnings.push('name must be non-empty string; ignored')
    }
  }

  let description = ''
  if (data.description !== undefined) {
    if (typeof data.description === 'string') {
      description = data.description
    } else {
      warnings.push('description must be string; ignored')
    }
  }

  const frontmatterExtra: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (key === 'name' || key === 'description') continue
    frontmatterExtra[key] = data[key]
  }

  return {
    name,
    description,
    bodyMd: trimBody(body),
    frontmatterExtra,
    warnings,
    hadFrontmatter,
  }
}
