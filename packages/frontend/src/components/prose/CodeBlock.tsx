// RFC-008 T1 — fenced-code overrides for react-markdown.
//
// react-markdown 10 calls our overrides synchronously and the underlying
// processor is `processSync` — so async rehype plugins (rehype-pretty-code
// with shiki's Promise<Highlighter>) can't slot in. Instead we render the
// fence as a React component that lazy-loads shiki on mount and replaces
// its own innerHTML with the highlighted output once ready. Mermaid /
// PlantUML reuse the existing static helpers via thin React wrappers.
//
// Wiring:
//   - `components.pre` collapses to a fragment so the inner CodeBlock owns
//     the <pre> wrapper. Without this we'd get a stray browser <pre> around
//     each shiki <pre class="shiki ...">.
//   - `components.code` dispatches on `className=language-X`:
//       lang === ''        → inline <code>
//       lang === mermaid   → MermaidDiagram React shell
//       lang === plantuml  → PlantUmlDiagram React shell
//       supported lang     → ShikiPre (lazy shiki)
//       unsupported lang   → plain <pre><code> fallback
import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { MermaidBlock } from '../review/MermaidBlock'
import { PlantUmlBlock } from '../review/PlantUmlBlock'
import { getHighlighter } from './highlighter'
import { useResolvedTheme } from '@/hooks/useTheme'

export function PassThroughPre({ children }: { children?: ReactNode }) {
  // Strip react-markdown's wrapping <pre> — fenced-code overrides own their
  // <pre> output. Inline code never lands here (no <pre> parent), so this
  // is safe.
  return <Fragment>{children}</Fragment>
}

// RFC-105 WP-B — PlantUML now renders via the backend proxy, so no endpoint /
// auth header is threaded through Prose any more (the server holds them).
export function makeCode() {
  return function Code({
    className,
    children,
    ...rest
  }: {
    className?: string
    children?: ReactNode
  } & Record<string, unknown>) {
    const lang = extractLang(className)
    if (lang === '') {
      // Inline `code` or fenced block with no language — render as plain
      // <code>. For the language-less fence case PassThroughPre stripped
      // the outer <pre>, so we need to put it back here.
      // Heuristic: if children contains a newline, it's a block.
      const text = childrenToString(children)
      if (text.includes('\n')) {
        return (
          <pre className="prose__code-fallback" data-prose-code-fallback="plain">
            <code>{text}</code>
          </pre>
        )
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    }
    const source = childrenToString(children).replace(/\n$/, '')
    if (lang === 'mermaid') return <MermaidDiagram source={source} />
    if (lang === 'plantuml') return <PlantUmlDiagram source={source} />
    return <ShikiPre source={source} lang={lang} />
  }
}

function extractLang(className: string | undefined): string {
  if (className === undefined) return ''
  const m = /(?:^|\s)language-([^\s]+)/.exec(className)
  return m === null ? '' : (m[1] ?? '').toLowerCase()
}

function childrenToString(c: ReactNode): string {
  if (typeof c === 'string') return c
  if (typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(childrenToString).join('')
  if (c !== null && typeof c === 'object' && 'props' in c) {
    const props = (c as { props: { children?: ReactNode } }).props
    return childrenToString(props.children)
  }
  return ''
}

// ---- mermaid / plantuml React shells around the imperative static helpers ----

function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()
  useEffect(() => {
    if (ref.current === null) return
    const mount = ref.current
    void MermaidBlock.render(mount, source, theme)
    return () => {
      mount.innerHTML = ''
    }
  }, [source, theme])
  return (
    <div
      ref={ref}
      className="prose__diagram prose__diagram--mermaid"
      data-prose-diagram="mermaid"
      data-prose-diagram-theme={theme}
    />
  )
}

function PlantUmlDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current === null) return
    const mount = ref.current
    PlantUmlBlock.renderViaProxy(mount, source)
    return () => {
      mount.innerHTML = ''
    }
  }, [source])
  return (
    <div
      ref={ref}
      className="prose__diagram prose__diagram--plantuml"
      data-prose-diagram="plantuml"
    />
  )
}

// ---- shiki block: lazy-load + post-mount innerHTML swap ----

interface ShikiPreProps {
  source: string
  lang: string
}

const SUPPORTED_LANGS = new Set([
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
])

function normalizeLang(lang: string): string {
  if (lang === 'typescript') return 'ts'
  if (lang === 'javascript') return 'js'
  if (lang === 'shell' || lang === 'zsh') return 'bash'
  if (lang === 'markdown') return 'md'
  if (lang === 'yml') return 'yaml'
  if (lang === 'py') return 'python'
  return lang
}

function ShikiPre({ source, lang }: ShikiPreProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const normalized = normalizeLang(lang)
  const supported = normalized.length > 0 && SUPPORTED_LANGS.has(normalized)

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      try {
        const hl = await getHighlighter()
        if (cancelled) return
        const html = hl.codeToHtml(source, {
          lang: normalized,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        })
        if (!cancelled) setHighlighted(html)
      } catch {
        // Stay in fallback (plain <pre><code>) — better than blank.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, normalized, supported])

  if (supported && highlighted !== null) {
    return (
      <div
        className="prose__code"
        data-prose-code={normalized}
        // shiki output is a self-contained <pre class="shiki ..."><code>...</code></pre>
        // — already escapes user content; safe to inject as HTML.
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    )
  }
  return (
    <pre
      className="prose__code-fallback"
      data-prose-code-fallback={supported ? normalized : normalized || 'plain'}
    >
      <code className={normalized.length > 0 ? `language-${normalized}` : undefined}>{source}</code>
    </pre>
  )
}
