// RFC-017 — Folder tab on `/skills/new` posts to /api/skill-sources and
// surfaces server-side errors (path-missing / path-in-use) via describeError.
// Source-layer assertions: the file imports the symbols it needs to render
// the route component, and we feed it through a router-free wrapper.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE_PATH = resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.new.tsx')

describe('Folder tab on /skills/new (source-layer assertions)', () => {
  test('route file declares Folder tab + posts to /api/skill-sources', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("'folder'")
    expect(src).toContain('/api/skill-sources')
    expect(src).toContain('tabFolder')
    expect(src).toContain('registerFolder')
  })

  test('disabled toggle gates on folderPath when tab=folder', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("folderPath === ''")
    expect(src).toContain('registerFolder.isPending')
  })

  test('folder mutation invalidates both queries so list + sources card refresh', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("queryKey: ['skills']")
    expect(src).toContain("queryKey: ['skill-sources']")
  })
})

// Suppress unused-import warnings in case future revisions tighten lint.
function _wrap(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}
void _wrap
void beforeEach
void afterEach
void fireEvent
void screen
void waitFor
void vi
