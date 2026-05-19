// RFC-043 T2 — locks the shape of the new MemoryDistillJobSchema
// optional fields and the MemoryDistillJobDetailSchema response wire
// format. If this test fails, the admin distill detail page can't
// rely on the contract between backend and frontend.

import { describe, expect, test } from 'bun:test'
import {
  MemoryDistillCandidateSnapshotSchema,
  MemoryDistillDedupSnapshotEntrySchema,
  MemoryDistillEventSchema,
  MemoryDistillJobDetailSchema,
  MemoryDistillJobSchema,
  MemoryDistillSessionViewSchema,
  MemoryDistillSourceEventEntrySchema,
} from '../src/schemas/memory'

const VALID_BASE_JOB = {
  id: 'job-1',
  debounceKey: 'task-x:clarify',
  sourceKind: 'clarify' as const,
  sourceEventId: 'src-1',
  taskId: null,
  scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
  status: 'pending' as const,
  attempts: 0,
  nextRunAt: 1,
  lastError: null,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
}

describe('RFC-043 shared schema', () => {
  test('MemoryDistillJobSchema accepts and round-trips the 4 new optional fields', () => {
    const parsed = MemoryDistillJobSchema.parse({
      ...VALID_BASE_JOB,
      opencodeSessionId: 'sess-abc',
      userPromptMd: 'prompt',
      exitCode: 0,
      stderrExcerpt: 'stderr',
    })
    expect(parsed.opencodeSessionId).toBe('sess-abc')
    expect(parsed.userPromptMd).toBe('prompt')
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stderrExcerpt).toBe('stderr')
  })

  test('MemoryDistillJobSchema parses legacy job rows without the new fields', () => {
    const parsed = MemoryDistillJobSchema.parse(VALID_BASE_JOB)
    // All 4 are optional + nullable → undefined when omitted.
    expect(parsed.opencodeSessionId).toBeUndefined()
    expect(parsed.userPromptMd).toBeUndefined()
    expect(parsed.exitCode).toBeUndefined()
    expect(parsed.stderrExcerpt).toBeUndefined()
  })

  test('MemoryDistillSessionViewSchema accepts empty attempts and capture-failed entries', () => {
    expect(MemoryDistillSessionViewSchema.parse({ attempts: [] }).attempts).toHaveLength(0)
    const withFailedCapture = MemoryDistillSessionViewSchema.parse({
      attempts: [
        {
          attemptIndex: 0,
          rootSessionId: null,
          startedAt: null,
          finishedAt: null,
          captureFailed: true,
          tree: null,
        },
      ],
    })
    expect(withFailedCapture.attempts[0]?.captureFailed).toBe(true)
    expect(withFailedCapture.attempts[0]?.tree).toBeNull()
  })

  test('MemoryDistillJobDetailSchema parses a complete admin detail response', () => {
    const detail = MemoryDistillJobDetailSchema.parse({
      job: VALID_BASE_JOB,
      siblings: [VALID_BASE_JOB],
      sourceEvents: [
        MemoryDistillSourceEventEntrySchema.parse({
          kind: 'feedback',
          id: 'tf-1',
          summary: 'feedback note',
          deepLink: '/tasks/task-x#feedback-tf-1',
          deletedOrMissing: false,
          taskId: 'task-x',
        }),
      ],
      dedupSnapshot: [
        MemoryDistillDedupSnapshotEntrySchema.parse({
          memoryId: 'mem-1',
          scopeType: 'agent',
          scopeId: 'agent-x',
          title: 'always run typecheck before push',
        }),
      ],
      candidates: [
        MemoryDistillCandidateSnapshotSchema.parse({
          memoryId: 'cand-1',
          title: 'new candidate',
          bodyMd: 'body',
          scopeType: 'global',
          scopeId: null,
          distillAction: 'new',
          currentStatus: 'candidate',
          referenceMemoryId: null,
          createdAt: 1,
        }),
      ],
    })
    expect(detail.siblings).toHaveLength(1)
    expect(detail.sourceEvents[0]?.deletedOrMissing).toBe(false)
    expect(detail.dedupSnapshot[0]?.scopeType).toBe('agent')
    expect(detail.candidates[0]?.distillAction).toBe('new')
  })

  test('MemoryDistillEventSchema rejects negative attemptIndex but accepts unknown kinds', () => {
    expect(() =>
      MemoryDistillEventSchema.parse({
        id: 1,
        attemptIndex: -1,
        sessionId: 's',
        parentSessionId: null,
        ts: 1,
        kind: 'text',
        payload: '{}',
      }),
    ).toThrow()
    // kind is z.string() (not enum) so future opencode kinds + the
    // RFC-043 capture-failure marker both pass.
    const ok = MemoryDistillEventSchema.parse({
      id: 2,
      attemptIndex: 0,
      sessionId: 's',
      parentSessionId: null,
      ts: 1,
      kind: 'rfc043/distill-capture-failed',
      payload: '{"reason":"opencode-db-not-found"}',
    })
    expect(ok.kind).toBe('rfc043/distill-capture-failed')
  })
})
