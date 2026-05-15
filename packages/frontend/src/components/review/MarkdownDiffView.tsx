// RFC-010 — 渲染态内联 diff 视图。
//
// 输入两份 markdown，先用 buildMergedMarkdown 拼成"含 PUA marker 的 merged
// markdown"，再用 react-markdown + remarkDiffMarkers 渲染成"prose 形态 +
// 内联高亮 <span class=\"diff-ins\"|\"diff-del\">"。
//
// 与 Prose.tsx 的关系：复用 react-markdown + remark-gfm + remark-alert +
// remark-math + 同套 rehype 链；不引 PlantUML / 图片 zoom（review diff
// 不需要）。如未来发现需要完全等价，再抽公共 plugin 配置。
//
// fallback：若构建或渲染抛错，回到 <pre>{merged}</pre>，至少不崩页。

import { useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { remarkAlert } from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import { buildMergedMarkdown, type DiffGranularity } from '@/lib/review/markdownDiff'
import { remarkDiffMarkers } from '@/lib/review/remarkDiffMarkers'

export interface MarkdownDiffViewProps {
  left: string
  right: string
  /** word（默认）/ line / block。不同 granularity 仅改变 jsdiff 路径，
   *  渲染管线（remark + rehype 链 + 高亮 CSS）共用。 */
  granularity?: DiffGranularity
  className?: string
}

export function MarkdownDiffView({
  left,
  right,
  granularity = 'word',
  className,
}: MarkdownDiffViewProps): ReactNode {
  const merged = useMemo(() => {
    try {
      return buildMergedMarkdown(left, right, granularity)
    } catch {
      return null
    }
  }, [left, right, granularity])

  const rehypePlugins = useMemo(
    () =>
      [
        [rehypeKatex, { strict: false, output: 'html' }],
        rehypeSlug,
        [
          rehypeAutolinkHeadings,
          {
            behavior: 'append',
            properties: {
              className: ['prose__anchor'],
              ariaHidden: 'true',
              tabIndex: -1,
            },
            content: { type: 'text', value: '#' },
          },
        ],
        [
          rehypeExternalLinks,
          {
            target: '_blank',
            rel: ['noopener', 'noreferrer'],
          },
        ],
      ] as unknown as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'],
    [],
  )

  const wrapperClass = 'markdown-diff-view prose' + (className !== undefined ? ' ' + className : '')

  if (merged === null) {
    return (
      <div className={wrapperClass} data-fallback="true" data-granularity={granularity}>
        <pre>{left + '\n---\n' + right}</pre>
      </div>
    )
  }

  return (
    <div className={wrapperClass} data-testid="markdown-diff-view" data-granularity={granularity}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlert, remarkMath, remarkDiffMarkers]}
        rehypePlugins={rehypePlugins}
      >
        {merged}
      </ReactMarkdown>
    </div>
  )
}
