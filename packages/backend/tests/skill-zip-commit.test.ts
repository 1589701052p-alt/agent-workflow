// RFC-019: backend commit logic — decision matrix + per-skill failure
// isolation + filesystem layout invariants.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { zipSync, type Zippable } from 'fflate'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  commitSkillZipBuffer,
  parseSkillZipBuffer,
  type SkillZipFsOptions,
} from '../src/services/skill-zip'
import { getSkill, importExternalSkill, createManagedSkill } from '../src/services/skill'
import type { SkillZipDecisionMap } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  fsOpts: SkillZipFsOptions
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-zip-commit-'))
  return {
    db: createInMemoryDb(MIGRATIONS),
    fsOpts: { appHome },
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

function buildZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const z: Zippable = {}
  for (const [k, v] of Object.entries(files)) {
    z[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v
  }
  return zipSync(z)
}

const skillMd = (name: string, desc = 'd') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\nbody for ${name}\n`

describe('commitSkillZipBuffer', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  test('all candidates with import decision are created', async () => {
    const buf = buildZip({
      'skill-a/SKILL.md': skillMd('skill-a', 'a desc'),
      'skill-a/extra.md': '# extra',
      'skill-b/SKILL.md': skillMd('skill-b', 'b desc'),
    })
    const decisions: SkillZipDecisionMap = {
      'skill-a': { action: 'import' },
      'skill-b': { action: 'import' },
    }
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, decisions)
    expect(r.created.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b'])
    expect(r.updated).toEqual([])
    expect(r.failed).toEqual([])
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'skill-a', 'files', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'skill-a', 'files', 'extra.md'))).toBe(true)
  })

  test('skip decision leaves DB + FS untouched for that candidate', async () => {
    const buf = buildZip({ 'skill-x/SKILL.md': skillMd('skill-x') })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-x': { action: 'skip' },
    })
    expect(r.created).toEqual([])
    expect(r.skipped.map((s) => s.name)).toEqual(['skill-x'])
    expect(await getSkill(h.db, 'skill-x')).toBeNull()
  })

  test('overwrite replaces managed skill content and keeps DB id stable', async () => {
    const before = await createManagedSkill(h.db, h.fsOpts, {
      name: 'skill-o',
      description: 'old desc',
      bodyMd: 'old body',
      frontmatterExtra: {},
    })
    // Drop a sentinel file to verify it gets removed by the overwrite step.
    const sentinelPath = join(h.fsOpts.appHome, 'skills', 'skill-o', 'files', 'sentinel.txt')
    writeFileSync(sentinelPath, 'remove-me')

    const buf = buildZip({
      'skill-o/SKILL.md': skillMd('skill-o', 'new desc'),
      'skill-o/fresh.md': '# fresh',
    })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-o': { action: 'overwrite' },
    })
    expect(r.updated.map((s) => s.id)).toEqual([before.id])
    expect(r.updated[0]!.description).toBe('new desc')

    const skillRoot = join(h.fsOpts.appHome, 'skills', 'skill-o', 'files')
    expect(existsSync(join(skillRoot, 'sentinel.txt'))).toBe(false)
    expect(existsSync(join(skillRoot, 'fresh.md'))).toBe(true)
    const md = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8')
    expect(md).toContain('description: new desc')
    expect(md).toContain('name: skill-o')
  })

  test('overwrite refused when DB record is external', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'aw-ext-skill-'))
    try {
      // Need a SKILL.md so importExternalSkill succeeds.
      writeFileSync(join(externalDir, 'SKILL.md'), '---\n---\n')
      await importExternalSkill(h.db, {
        name: 'skill-ext',
        externalPath: externalDir,
        description: '',
      })

      const buf = buildZip({ 'skill-ext/SKILL.md': skillMd('skill-ext') })
      const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
        'skill-ext': { action: 'overwrite' },
      })
      expect(r.created).toEqual([])
      expect(r.updated).toEqual([])
      expect(r.failed.map((f) => f.code)).toEqual(['skill-external-cannot-overwrite'])
      // External skill files must remain untouched.
      expect(existsSync(join(externalDir, 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('rename re-targets to new name; original skill name stays free', async () => {
    const buf = buildZip({ 'skill-orig/SKILL.md': skillMd('skill-orig', 'desc') })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-orig': { action: 'rename', newName: 'skill-new' },
    })
    expect(r.created.map((s) => s.name)).toEqual(['skill-new'])
    expect(await getSkill(h.db, 'skill-orig')).toBeNull()
    expect(existsSync(join(h.fsOpts.appHome, 'skills', 'skill-new', 'files', 'SKILL.md'))).toBe(
      true,
    )
  })

  test('rename to a name already in DB fails with skill-rename-conflict', async () => {
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'taken',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    const buf = buildZip({ 'skill-from-zip/SKILL.md': skillMd('skill-from-zip') })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-from-zip': { action: 'rename', newName: 'taken' },
    })
    expect(r.failed[0]!.code).toBe('skill-rename-conflict')
  })

  test('two renames to the same target inside one batch — second fails', async () => {
    const buf = buildZip({
      'a/SKILL.md': skillMd('a'),
      'b/SKILL.md': skillMd('b'),
    })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      a: { action: 'rename', newName: 'merged' },
      b: { action: 'rename', newName: 'merged' },
    })
    expect(r.created.map((s) => s.name)).toEqual(['merged'])
    expect(r.failed.map((f) => f.code)).toEqual(['skill-rename-conflict'])
  })

  test('rename newName fails kebab-case → skill-name-invalid', async () => {
    const buf = buildZip({ 'skill-r/SKILL.md': skillMd('skill-r') })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-r': { action: 'rename', newName: 'Bad Name' as never },
    })
    expect(r.failed[0]!.code).toBe('skill-name-invalid')
    expect(r.created).toEqual([])
  })

  test('candidate without a decision is reported as skipped', async () => {
    const buf = buildZip({
      'a/SKILL.md': skillMd('a'),
      'b/SKILL.md': skillMd('b'),
    })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      a: { action: 'import' },
    })
    expect(r.created.map((s) => s.name)).toEqual(['a'])
    expect(r.skipped.find((s) => s.name === 'b')).toBeDefined()
  })

  test('decision targeting a non-existent candidate is reported as skipped', async () => {
    const buf = buildZip({ 'only/SKILL.md': skillMd('only') })
    const r = await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      only: { action: 'import' },
      ghost: { action: 'import' },
    })
    expect(r.skipped.find((s) => s.name === 'ghost')).toBeDefined()
  })

  test('parseSkillZipBuffer flags DB conflict on candidate view', async () => {
    await createManagedSkill(h.db, h.fsOpts, {
      name: 'dup',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    const buf = buildZip({
      'dup/SKILL.md': skillMd('dup'),
      'fresh/SKILL.md': skillMd('fresh'),
    })
    const { response } = await parseSkillZipBuffer(h.db, buf)
    const dup = response.skills.find((s) => s.name === 'dup')!
    expect(dup.conflict).toBe('managed')
    const fresh = response.skills.find((s) => s.name === 'fresh')!
    expect(fresh.conflict).toBeUndefined()
  })

  test('frontmatterExtra round-trips into rewritten SKILL.md', async () => {
    const buf = buildZip({
      'skill-fm/SKILL.md':
        '---\nname: skill-fm\ndescription: d\nauthor: alice\nversion: 1\n---\nbody\n',
    })
    await commitSkillZipBuffer(h.db, h.fsOpts, buf, {
      'skill-fm': { action: 'import' },
    })
    const md = readFileSync(
      join(h.fsOpts.appHome, 'skills', 'skill-fm', 'files', 'SKILL.md'),
      'utf-8',
    )
    expect(md).toContain('author: alice')
    expect(md).toContain('version: 1')
    expect(md).toContain('name: skill-fm')
  })
})
