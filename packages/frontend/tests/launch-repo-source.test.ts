// RFC-024 T6 — pure-function tests for the launcher's two-mode Repo source
// helpers. Locks `buildLaunchBody` body shape, `validateRepoUrl` outcomes,
// and the source-level wiring in workflows.launch.tsx + RepoSourceTabs.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildLaunchBody,
  buildLaunchFormDataV2,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('buildLaunchBody (RFC-024)', () => {
  test('path mode emits workflowId/repoPath/baseBranch/inputs', () => {
    const src: RepoSource = { kind: 'path', repoPath: '/tmp/repo', baseBranch: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', inputs: { topic: 'orders' } })
    expect(body).toEqual({
      workflowId: 'wf-1',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    })
    expect('repoUrl' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('url mode emits workflowId/repoUrl/inputs (no baseBranch)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@github.com:foo/bar.git', ref: '' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', inputs: {} })
    expect(body).toEqual({
      workflowId: 'wf-1',
      repoUrl: 'git@github.com:foo/bar.git',
      inputs: {},
    })
    expect('baseBranch' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('url mode keeps non-empty ref (trimmed)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '  feature/x  ' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', inputs: {} })
    expect(body.ref).toBe('feature/x')
  })
})

describe('validateRepoUrl (RFC-024)', () => {
  test('empty → empty', () => {
    expect(validateRepoUrl('')).toBe('empty')
    expect(validateRepoUrl('   ')).toBe('empty')
  })

  test('plausible SSH / HTTPS → null', () => {
    expect(validateRepoUrl('git@github.com:foo/bar.git')).toBeNull()
    expect(validateRepoUrl('https://github.com/foo/bar.git')).toBeNull()
    expect(validateRepoUrl('ssh://git@host/x/y')).toBeNull()
  })

  test('malformed → invalid', () => {
    expect(validateRepoUrl('/some/path')).toBe('invalid')
    expect(validateRepoUrl('not a url')).toBe('invalid')
  })
})

describe('buildLaunchFormDataV2 (RFC-024)', () => {
  test('embeds JSON payload for URL mode + files for each upload key', async () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '' }
    const f1 = new File(['hello'], 'a.txt', { type: 'text/plain' })
    const f2 = new File(['world'], 'b.txt', { type: 'text/plain' })
    const fd = buildLaunchFormDataV2(
      src,
      { workflowId: 'wf-1', inputs: { topic: 'orders' } },
      { docs: [f1, f2] },
    )
    // payload field is a Blob with the JSON body.
    const payloadBlob = fd.get('payload') as Blob
    expect(payloadBlob).toBeInstanceOf(Blob)
    const txt = await payloadBlob.text()
    const parsed = JSON.parse(txt)
    expect(parsed.repoUrl).toBe('git@h:o/r.git')
    expect('repoPath' in parsed).toBe(false)
    // Files appear under files[<key>][].
    const files = fd.getAll('files[docs][]')
    expect(files.length).toBe(2)
  })
})

describe('workflows.launch.tsx wiring (RFC-024 source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
    'utf-8',
  )

  test('imports RepoSourceTabs', () => {
    expect(SRC).toContain('RepoSourceTabs')
  })

  test('uses buildLaunchBody (not the old inline payload)', () => {
    expect(SRC).toContain('buildLaunchBody')
    // The legacy inline `payload = { workflowId: id, repoPath, baseBranch, inputs }` block is gone.
    expect(SRC).not.toMatch(/payload = \{ workflowId: id, repoPath, baseBranch, inputs \}/)
  })

  test('canSubmit gate considers both source modes via validateRepoUrl', () => {
    expect(SRC).toContain('validateRepoUrl')
  })

  test('renders the cloning hint while POST is pending in URL mode', () => {
    expect(SRC).toContain('launch.repoSource.cloningHint')
  })
})
