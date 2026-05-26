// RFC-065 T6 — WorktreeFilesPanel UI contract.
//
// Locks:
//   1. Initial render only fetches the root (no lazy children pulled).
//   2. Default selection is null → right pane shows the empty state.
//   3. Clicking a directory triggers a fetch for that subdir; clicking the
//      same dir again collapses without refetching (react-query cache hit).
//   4. Clicking a file triggers worktree-file fetch + renders <pre>.
//   5. oversized:true response renders the oversized hint, NOT <pre>.
//   6. truncated:true renders the trailing truncated row.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorktreeFilesPanel, formatBytes, joinRel } from '../src/components/WorktreeFilesPanel'
import '../src/i18n'

interface FetchCall {
  url: string
}

function installFetch(handlers: Map<string, () => unknown>) {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url })
      // Match by pathname + query string.
      for (const [pattern, fn] of handlers) {
        if (url.includes(pattern)) {
          return new Response(JSON.stringify(fn()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ ok: false, code: 'unknown' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return calls
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorktreeFilesPanel taskId="task_X" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('pure helpers', () => {
  test('formatBytes — boundaries', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MiB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB')
  })

  test('joinRel — root vs nested', () => {
    expect(joinRel('', 'src')).toBe('src')
    expect(joinRel('src', 'foo.ts')).toBe('src/foo.ts')
    expect(joinRel('a/b', 'c.txt')).toBe('a/b/c.txt')
  })
})

describe('WorktreeFilesPanel', () => {
  test('initial render fetches root only and shows empty preview', async () => {
    const calls = installFetch(
      new Map<string, () => unknown>([
        [
          // empty `path` query is omitted by api.client's URL builder
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [
              { name: 'src', kind: 'directory', size: null },
              { name: 'README.md', kind: 'file', size: 8 },
            ],
          }),
        ],
      ]),
    )
    wrap()
    await screen.findByTestId('worktree-tree-dir-src')
    expect(screen.getByTestId('worktree-files-preview-empty')).toBeTruthy()
    // Only the root fetch should have happened.
    const treeFetches = calls.filter((c) => c.url.includes('worktree-tree'))
    expect(treeFetches.length).toBe(1)
  })

  test('expand directory triggers subdir fetch; collapse + re-expand uses cache', async () => {
    const calls = installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree?path=src',
          () => ({
            path: 'src',
            truncated: false,
            entries: [{ name: 'hello.ts', kind: 'file', size: 12 }],
          }),
        ],
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [{ name: 'src', kind: 'directory', size: null }],
          }),
        ],
      ]),
    )
    wrap()
    const dirBtn = await screen.findByTestId('worktree-tree-dir-src')
    fireEvent.click(dirBtn)
    await screen.findByTestId('worktree-tree-file-src/hello.ts')
    const subFetchesAfterExpand = calls.filter((c) =>
      c.url.includes('worktree-tree?path=src'),
    ).length
    expect(subFetchesAfterExpand).toBe(1)
    // collapse
    fireEvent.click(dirBtn)
    await waitFor(() => {
      expect(screen.queryByTestId('worktree-tree-file-src/hello.ts')).toBeNull()
    })
    // re-expand — no extra fetch
    fireEvent.click(dirBtn)
    await screen.findByTestId('worktree-tree-file-src/hello.ts')
    const subFetchesAfterReExpand = calls.filter((c) =>
      c.url.includes('worktree-tree?path=src'),
    ).length
    expect(subFetchesAfterReExpand).toBe(1)
  })

  test('click file fetches and renders content inside <pre>', async () => {
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [{ name: 'README.md', kind: 'file', size: 8 }],
          }),
        ],
        [
          'worktree-file?path=README.md',
          () => ({
            path: 'README.md',
            size: 8,
            oversized: false,
            content: '# title\n',
          }),
        ],
      ]),
    )
    wrap()
    const fileBtn = await screen.findByTestId('worktree-tree-file-README.md')
    fireEvent.click(fileBtn)
    const body = await screen.findByTestId('worktree-files-preview-body')
    expect(body.textContent).toContain('# title')
    // <pre> exists with monospace content
    expect(body.querySelector('pre')).not.toBeNull()
  })

  test('oversized response renders the oversized hint, no <pre>', async () => {
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [{ name: 'big.bin', kind: 'file', size: 5 * 1024 * 1024 }],
          }),
        ],
        [
          'worktree-file?path=big.bin',
          () => ({
            path: 'big.bin',
            size: 5 * 1024 * 1024,
            oversized: true,
            content: '',
          }),
        ],
      ]),
    )
    wrap()
    fireEvent.click(await screen.findByTestId('worktree-tree-file-big.bin'))
    const oversized = await screen.findByTestId('worktree-files-preview-oversized')
    expect(oversized.querySelector('pre')).toBeNull()
    expect(oversized.textContent).toMatch(/2\.0 MiB/)
  })

  test('truncated:true response renders the trailing truncated row', async () => {
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: true,
            entries: [{ name: 'a.txt', kind: 'file', size: 1 }],
          }),
        ],
      ]),
    )
    wrap()
    await screen.findByTestId('worktree-tree-file-a.txt')
    const truncated = document.querySelector('.worktree-files-tree__row--truncated')
    expect(truncated).not.toBeNull()
    expect(truncated?.textContent).toMatch(/5000/)
  })

  test('expand state survives across folder collapse/re-expand round-trip', async () => {
    // Same scenario as the cache test but verifies the file becomes
    // visible again after re-expand without needing a re-fetch from the
    // server (cache hit assertion already done above; this assertion is
    // about DOM state visibility).
    installFetch(
      new Map<string, () => unknown>([
        // specific patterns first so the URL-includes match wins over the
        // generic `worktree-tree` root pattern.
        [
          'worktree-tree?path=src',
          () => ({
            path: 'src',
            truncated: false,
            entries: [{ name: 'hello.ts', kind: 'file', size: 12 }],
          }),
        ],
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [{ name: 'src', kind: 'directory', size: null }],
          }),
        ],
      ]),
    )
    wrap()
    const dir = await screen.findByTestId('worktree-tree-dir-src')
    fireEvent.click(dir)
    await screen.findByTestId('worktree-tree-file-src/hello.ts')
    fireEvent.click(dir)
    await waitFor(() => {
      expect(screen.queryByTestId('worktree-tree-file-src/hello.ts')).toBeNull()
    })
    fireEvent.click(dir)
    await screen.findByTestId('worktree-tree-file-src/hello.ts')
  })

  test('refresh button re-fetches expanded tree levels even with staleTime: Infinity', async () => {
    // Regression: on 2026-05-26 a user opened the worktree-files tab at task
    // start when the worker hadn't written any files yet. The query
    // (staleTime/gcTime Infinity) cached `entries: []` forever and never
    // refetched, so the tree stayed empty even after files appeared. The
    // refresh button must invalidate the cached tree levels (and any open
    // file preview) for the task and trigger a re-fetch.
    let rootCallNo = 0
    let subCallNo = 0
    let fileCallNo = 0
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree?path=src',
          () => {
            subCallNo++
            return {
              path: 'src',
              truncated: false,
              entries: subCallNo === 1 ? [] : [{ name: 'hello.ts', kind: 'file', size: 12 }],
            }
          },
        ],
        [
          'worktree-tree',
          () => {
            rootCallNo++
            return {
              path: '',
              truncated: false,
              entries: rootCallNo === 1 ? [] : [{ name: 'src', kind: 'directory', size: null }],
            }
          },
        ],
        [
          'worktree-file?path=README.md',
          () => {
            fileCallNo++
            return {
              path: 'README.md',
              size: 3,
              oversized: false,
              content: fileCallNo === 1 ? 'OLD' : 'NEW',
            }
          },
        ],
      ]),
    )
    wrap()
    // Wait for the first root fetch to settle — tree is empty.
    await waitFor(() => {
      expect(rootCallNo).toBe(1)
    })
    expect(screen.queryByTestId('worktree-tree-dir-src')).toBeNull()
    // Click refresh — root must re-fetch and now reveal `src/`.
    fireEvent.click(screen.getByTestId('worktree-files-refresh'))
    const dirBtn = await screen.findByTestId('worktree-tree-dir-src')
    expect(rootCallNo).toBe(2)
    // Expand the subdir — first call still returns []
    fireEvent.click(dirBtn)
    await waitFor(() => {
      expect(subCallNo).toBe(1)
    })
    expect(screen.queryByTestId('worktree-tree-file-src/hello.ts')).toBeNull()
    // Refresh again — every cached tree level for the task is invalidated,
    // including the open subdir, so hello.ts shows up.
    fireEvent.click(screen.getByTestId('worktree-files-refresh'))
    await screen.findByTestId('worktree-tree-file-src/hello.ts')
    expect(subCallNo).toBe(2)
  })

  test('refresh button re-fetches the currently previewed file', async () => {
    let fileCallNo = 0
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [{ name: 'README.md', kind: 'file', size: 3 }],
          }),
        ],
        [
          'worktree-file?path=README.md',
          () => {
            fileCallNo++
            return {
              path: 'README.md',
              size: 3,
              oversized: false,
              content: fileCallNo === 1 ? 'OLD' : 'NEW',
            }
          },
        ],
      ]),
    )
    wrap()
    fireEvent.click(await screen.findByTestId('worktree-tree-file-README.md'))
    await waitFor(() => {
      expect(screen.getByTestId('worktree-files-preview-body').textContent ?? '').toContain('OLD')
    })
    fireEvent.click(screen.getByTestId('worktree-files-refresh'))
    await waitFor(() => {
      expect(screen.getByTestId('worktree-files-preview-body').textContent ?? '').toContain('NEW')
    })
  })

  test('selecting one file then another swaps the right pane content', async () => {
    installFetch(
      new Map<string, () => unknown>([
        [
          'worktree-tree',
          () => ({
            path: '',
            truncated: false,
            entries: [
              { name: 'a.txt', kind: 'file', size: 1 },
              { name: 'b.txt', kind: 'file', size: 1 },
            ],
          }),
        ],
        [
          'worktree-file?path=a.txt',
          () => ({ path: 'a.txt', size: 1, oversized: false, content: 'AAA' }),
        ],
        [
          'worktree-file?path=b.txt',
          () => ({ path: 'b.txt', size: 1, oversized: false, content: 'BBB' }),
        ],
      ]),
    )
    wrap()
    fireEvent.click(await screen.findByTestId('worktree-tree-file-a.txt'))
    await waitFor(() => {
      expect(screen.getByTestId('worktree-files-preview-body').textContent ?? '').toContain('AAA')
    })
    fireEvent.click(screen.getByTestId('worktree-tree-file-b.txt'))
    await waitFor(() => {
      expect(screen.getByTestId('worktree-files-preview-body').textContent ?? '').toContain('BBB')
    })
  })
})
