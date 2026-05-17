// RFC-033-T1: redact guard for the snapshot path.
//
// Tests that consumers building a snapshot row from a credential-bearing URL
// can always rely on `redactGitUrl` to strip the user:pass segment. If a
// future change accidentally returns the raw URL via `inputUrlRedacted` this
// regression test goes red.

import { describe, expect, test } from 'bun:test'
import { redactGitUrl } from '../src/git-url'
import { BatchImportRowSchema } from '../src/schemas/repoBatchImport'

describe('batch-import row redact path', () => {
  test('inputUrlRedacted strips user:pass for https URLs', () => {
    const raw = 'https://x-token-auth:s3cr3t@github.com/foo/bar.git'
    const redacted = redactGitUrl(raw)
    expect(redacted).not.toContain('s3cr3t')
    expect(redacted).not.toContain('x-token-auth')
    const row = BatchImportRowSchema.parse({
      rowId: 'r1',
      inputUrl: redacted,
      inputUrlRedacted: redacted,
      status: 'queued',
      cold: null,
      fetchOk: null,
      cachedRepoId: null,
      errorCode: null,
      message: null,
      queuedAt: '2026-05-17T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    })
    expect(row.inputUrlRedacted).not.toContain('s3cr3t')
    expect(row.inputUrl).not.toContain('s3cr3t')
  })
})
