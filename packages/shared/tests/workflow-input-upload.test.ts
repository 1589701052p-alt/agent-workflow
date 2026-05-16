// RFC-020: UploadInputSchema locks the strict-on-write shape for
// `kind: 'upload'` launcher inputs. targetDir must be repo-relative with no
// `..` or absolute prefixes; accept/maxFileSize/min/maxCount are optional.

import { describe, expect, test } from 'bun:test'
import { UploadInputSchema, WORKFLOW_INPUT_KIND } from '../src/schemas/workflow'

describe('WORKFLOW_INPUT_KIND', () => {
  test("includes 'upload'", () => {
    expect(WORKFLOW_INPUT_KIND).toContain('upload')
  })
})

describe('UploadInputSchema', () => {
  test('happy path: minimal upload input', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Reference materials',
      targetDir: 'inputs/refs',
    })
    expect(r.success).toBe(true)
  })

  test('happy path: full set of optional fields', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Reference materials',
      targetDir: 'uploads',
      accept: ['.pdf', 'image/*'],
      maxFileSize: 1024,
      minCount: 1,
      maxCount: 5,
      required: true,
      description: 'PDFs only',
    })
    expect(r.success).toBe(true)
  })

  test('rejects targetDir containing ".."', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: '../escape',
    })
    expect(r.success).toBe(false)
  })

  test('rejects targetDir starting with "/"', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: '/abs/path',
    })
    expect(r.success).toBe(false)
  })

  test('rejects empty targetDir', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: '',
    })
    expect(r.success).toBe(false)
  })

  test('rejects Windows drive-prefix targetDir', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: 'C:\\Users\\foo',
    })
    expect(r.success).toBe(false)
  })

  test('rejects non-upload kind', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'files',
      key: 'refs',
      label: 'Refs',
      targetDir: 'inputs',
    })
    expect(r.success).toBe(false)
  })

  test('rejects maxFileSize <= 0', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: 'inputs',
      maxFileSize: 0,
    })
    expect(r.success).toBe(false)
  })

  test('rejects negative minCount', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: 'inputs',
      minCount: -1,
    })
    expect(r.success).toBe(false)
  })

  test('rejects zero maxCount', () => {
    const r = UploadInputSchema.safeParse({
      kind: 'upload',
      key: 'refs',
      label: 'Refs',
      targetDir: 'inputs',
      maxCount: 0,
    })
    expect(r.success).toBe(false)
  })
})
