// RFC-041 — locks TaskFeedbackSchema / TaskFeedbackCreateSchema boundaries.

import { describe, expect, test } from 'bun:test'
import { TaskFeedbackCreateSchema, TaskFeedbackSchema } from '../src/schemas/taskFeedback'

describe('TaskFeedbackSchema', () => {
  test('accepts minimal row', () => {
    const r = TaskFeedbackSchema.parse({
      id: 'f_001',
      taskId: 't_001',
      authorUserId: null,
      bodyMd: 'remember this',
      createdAt: 1,
      distilled: false,
      distillJobId: null,
    })
    expect(r.distilled).toBe(false)
    expect(r.authorUserId).toBeNull()
  })
  test('rejects empty body', () => {
    expect(() =>
      TaskFeedbackSchema.parse({
        id: 'f_001',
        taskId: 't_001',
        authorUserId: null,
        bodyMd: '',
        createdAt: 1,
        distilled: false,
        distillJobId: null,
      }),
    ).toThrow()
  })
})

describe('TaskFeedbackCreateSchema', () => {
  test('trim then enforce 1..4000', () => {
    expect(TaskFeedbackCreateSchema.parse({ bodyMd: '  hi  ' }).bodyMd).toBe('hi')
    expect(() => TaskFeedbackCreateSchema.parse({ bodyMd: '   ' })).toThrow()
    expect(() => TaskFeedbackCreateSchema.parse({ bodyMd: 'x'.repeat(4001) })).toThrow()
    expect(TaskFeedbackCreateSchema.parse({ bodyMd: 'x'.repeat(4000) }).bodyMd.length).toBe(4000)
  })
})
