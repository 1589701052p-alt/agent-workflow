// RFC-008 T1 — shiki fenced-code path.
//
// shiki is loaded async via dynamic import + a Highlighter singleton (see
// `prose/highlighter.ts`). We don't want to pull the real wasm engine in
// happy-dom tests, so we replace the singleton with a stub that returns
// a deterministic <pre class="shiki ...">.
//
// What's locked:
//   - the pre override hands its source + lang to ShikiPre
//   - ShikiPre eventually swaps its fallback <pre> for shiki's HTML
//   - language aliases (typescript → ts) normalize before dispatch
//   - unsupported languages stay in the fallback (no innerHTML swap)
//
// What's NOT covered here: real shiki tokenization quality. That's a
// browser-only visual check per CLAUDE.md "UI 改动必须真在浏览器里看一遍".

import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { __setHighlighterForTests } from '@/components/prose/highlighter'

const codeToHtml = vi.fn(
  (source: string, opts: { lang: string }) =>
    `<pre class="shiki shiki-themes github-light github-dark" data-stub-lang="${opts.lang}"><code><span style="--shiki-light:#000;--shiki-dark:#fff">${source}</span></code></pre>`,
)

beforeEach(() => {
  codeToHtml.mockClear()
  __setHighlighterForTests(
    Promise.resolve({
      codeToHtml,
      // unused by ShikiPre but the type wants them
    } as never),
  )
})

afterEach(() => {
  __setHighlighterForTests(null)
})

import { Prose } from '@/components/prose/Prose'

describe('Prose — shiki fenced code', () => {
  test('supported language eventually swaps to shiki output', async () => {
    const md = '```ts\nconst x: number = 1\n```'
    const { container } = render(<Prose body={md} />)
    await waitFor(() => {
      const shikiPre = container.querySelector('[data-prose-code="ts"] pre.shiki')
      expect(shikiPre).not.toBeNull()
    })
    expect(codeToHtml).toHaveBeenCalledTimes(1)
    expect(codeToHtml.mock.calls[0]?.[0]).toContain('const x: number = 1')
    expect(codeToHtml.mock.calls[0]?.[1]).toMatchObject({ lang: 'ts' })
  })

  test('language alias normalizes (typescript → ts)', async () => {
    const md = '```typescript\nlet a = 1\n```'
    const { container } = render(<Prose body={md} />)
    await waitFor(() => {
      expect(container.querySelector('[data-prose-code="ts"]')).not.toBeNull()
    })
  })

  test('unsupported language stays in fallback <pre> (no shiki call)', () => {
    const md = '```fooz\nblah\n```'
    const { container } = render(<Prose body={md} />)
    const fallback = container.querySelector('pre.prose__code-fallback')
    expect(fallback).not.toBeNull()
    expect(codeToHtml).not.toHaveBeenCalled()
  })

  test('no-language fence (```text) stays in fallback', () => {
    const md = '```\nplain text\n```'
    const { container } = render(<Prose body={md} />)
    expect(container.querySelector('pre.prose__code-fallback')).not.toBeNull()
    expect(codeToHtml).not.toHaveBeenCalled()
  })
})
