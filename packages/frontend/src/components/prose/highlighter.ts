// RFC-008 T1 — shiki highlighter singleton.
//
// rehype-pretty-code accepts a `getHighlighter` callback. We return a
// cached Promise<Highlighter> so the wasm + grammar payload only loads
// once per page session. Languages are the curated set that appears in
// agent prompts / review docs; unsupported langs fall through to plain
// <pre><code> in rehype-pretty-code.
import type { Highlighter } from 'shiki'

const SUPPORTED_LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'md',
  'yaml',
  'sql',
  'python',
  'diff',
] as const

const SUPPORTED_THEMES = ['github-light', 'github-dark'] as const

let cached: Promise<Highlighter> | null = null

export function getHighlighter(): Promise<Highlighter> {
  if (cached !== null) return cached
  cached = (async () => {
    const { createHighlighter } = await import('shiki')
    return createHighlighter({
      themes: [...SUPPORTED_THEMES],
      langs: [...SUPPORTED_LANGS],
    })
  })()
  return cached
}

// Test-only escape hatch so unit tests can replace the highlighter with a
// stub that doesn't pull the real wasm engine. Production callers always
// go through getHighlighter().
export function __setHighlighterForTests(p: Promise<Highlighter> | null): void {
  cached = p
}
