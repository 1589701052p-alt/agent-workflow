# RFC-008 — 技术设计

## 设计原则

1. **统一渲染器**：删 `MarkdownEditor` 的极简渲染器，编辑器预览复用 review 用的同一个 React 组件 `<Prose>`。
2. **React-first**：放弃"HTML 字符串 → DOMPurify → DOM walk → useEffect 替换"占位符 dance，转用 `react-markdown` 的 `components` overrides，让 mermaid / plantuml / 代码块 / 图片 / 标题锚点 / 外链 / 表格全部以 React 节点 mount，结构清晰、可测。
3. **安全不退化**：**不**开 `rehype-raw` —— 业务 markdown 不需要内联 HTML，全 escape，无 XSS 面。原 `MarkdownView` 的 DOMPurify pass 不再需要；保留一行防御性 CSS `.prose iframe, .prose object, .prose embed { display: none }`。
4. **暗色主题对齐**：shiki dual theme，CSS 走 `var(--*)` token，不硬编码颜色。
5. **可降级**：shiki / KaTeX / mermaid 加载失败时退化为 plain `<pre>` / 源码，不让整页崩。

## 技术 stack

| 层 | 包 | 用途 |
|---|---|---|
| Renderer | `react-markdown@9` | AST → React |
| GFM | `remark-gfm@4` | 表格、删除线、任务列表、脚注、autolink |
| Callouts | `remark-github-blockquote-alert` | GitHub `> [!NOTE]` 五色块 |
| Math | `remark-math@6` + `rehype-katex@7` + `katex/dist/katex.min.css` | `$x^2$` 行内、`$$...$$` 块级 |
| Code blocks | `rehype-pretty-code@0.x` + `shiki@1.x` + `@shikijs/transformers` | shiki 高亮、行高亮、`// [!code]` 标记、diff、focus |
| Inline code 高亮 | `rehype-pretty-code` inline mode `` `x`{:ts} `` | |
| 标题锚点 | `rehype-slug@6` + `rehype-autolink-headings@7` | hover 出 `#` 链接 |
| 外链装饰 | `rehype-external-links@3` | `target=_blank` + 小图标 |
| 图片放大 | `medium-zoom@1` | 点击放大 |
| 字体 | 自托管 Inter (400/500/600/700) + JetBrains Mono (400/500) | woff2 子集化 |
| Prose CSS | 手写，对齐 `--bg/--panel/--border/--text/--muted/--accent` token | |

依赖增量（gz 估算）：~300KB（shiki wasm + KaTeX 字体 + 字体 woff2 占大头，全部按需 lazy）。

## 文件结构

### 新增

- `packages/frontend/src/components/prose/Prose.tsx` —— 统一渲染入口；props: `body / taskId? / plantumlEndpoint? / plantumlAuthHeader? / className?`。
- `packages/frontend/src/components/prose/CodeBlock.tsx` —— `components.code` 实现：`language-mermaid` / `language-plantuml` → `MermaidBlock` / `PlantUmlBlock`；其它走 `rehype-pretty-code` 已处理过的 shiki 输出。
- `packages/frontend/src/components/prose/ProseImage.tsx` —— `components.img`：相对路径走 `resolveImageHref(taskId)` proxy；mount 后 medium-zoom 接管。
- `packages/frontend/src/components/prose/highlighter.ts` —— shiki 单例（`createHighlighter` lazy，主题 github-light/dark，按需 `loadLanguage`）。
- `packages/frontend/src/components/prose/prose.css` —— 完整 typography + callout + shiki dual-theme + heading anchor + 表格 + KaTeX tweak。`main.tsx` 里 import。
- `packages/frontend/src/assets/fonts/` —— Inter + JetBrains Mono woff2（子集化 ASCII + Latin Extended）。
- `packages/frontend/tests/prose-*.test.tsx` —— 12 条 capability 测试。

### 修改

- `packages/frontend/src/components/review/MarkdownView.tsx` —— **删除**（reviews.detail 直接 import `Prose`）。
- `packages/frontend/src/components/review/MermaidBlock.tsx` —— 改造为接收 `source` prop 的纯 React 组件（包一层 React 容器；现状是 `.render(mount, ...)` 命令式 API）。
- `packages/frontend/src/components/review/PlantUmlBlock.tsx` —— 同上。
- `packages/frontend/src/components/MarkdownEditor.tsx` —— 删极简渲染器；预览用 `<Prose body={useDeferredValue(value)} className="md-editor__preview" />`。
- `packages/frontend/src/routes/reviews.detail.tsx` —— `import { Prose }`；JSX 替换；锚点 / bubble 逻辑不动。
- `packages/frontend/src/styles.css` —— 移除 `.md-editor__preview` 的 h1-h3 + pre 单独规则；保留容器规则（border / min-height / overflow）。
- `packages/frontend/src/main.tsx` —— `import './components/prose/prose.css'`。
- `packages/frontend/package.json` —— 加全部新依赖。
- `packages/frontend/vite.config.ts` —— shiki wasm `optimizeDeps.exclude` 若需要；KaTeX woff2 静态资源指纹化。

### 删除

- `packages/frontend/tests/markdown.test.ts` —— 极简渲染器测试。
- `packages/frontend/tests/markdown-view.test.tsx` —— 由 `prose-reviews-detail.test.tsx` 取代。

## 关键实现细节

### `Prose.tsx` 主管线

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkAlert } from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeExternalLinks from 'rehype-external-links'
import {
  transformerNotationHighlight,
  transformerNotationDiff,
  transformerNotationFocus,
} from '@shikijs/transformers'

export function Prose({ body, taskId, plantumlEndpoint, plantumlAuthHeader, className }: Props) {
  const codeBlock = useMemo(
    () => makeCodeBlock({ plantumlEndpoint, plantumlAuthHeader }),
    [plantumlEndpoint, plantumlAuthHeader],
  )
  const proseImage = useMemo(() => makeProseImage({ taskId }), [taskId])
  return (
    <div className={'prose' + (className ? ' ' + className : '')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlert, remarkMath]}
        rehypePlugins={[
          [rehypePrettyCode, {
            keepBackground: false,
            theme: { light: 'github-light', dark: 'github-dark' },
            transformers: [
              transformerNotationHighlight(),
              transformerNotationDiff(),
              transformerNotationFocus(),
            ],
            getHighlighter,
          }],
          rehypeSlug,
          [rehypeAutolinkHeadings, {
            behavior: 'append',
            properties: { className: ['prose__anchor'], ariaHidden: 'true', tabIndex: -1 },
            content: { type: 'text', value: '#' },
          }],
          [rehypeKatex, { strict: false }],
          [rehypeExternalLinks, {
            target: '_blank',
            rel: ['noopener', 'noreferrer'],
            content: { type: 'element', tagName: 'span', properties: { className: ['prose__external-icon'] }, children: [] },
          }],
        ]}
        components={{ code: codeBlock, img: proseImage }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}
```

不开 `rehype-raw` —— 源里 `<script>` 会被 escape，不可能执行。

### `CodeBlock`

```tsx
function makeCodeBlock({ plantumlEndpoint, plantumlAuthHeader }) {
  return function CodeBlock({ inline, className, children, ...props }) {
    const lang = (className ?? '').replace(/^language-/, '').split(/\s+/)[0] ?? ''
    if (!inline && lang === 'mermaid') {
      return <MermaidBlock source={String(children).trimEnd()} />
    }
    if (!inline && lang === 'plantuml') {
      return <PlantUmlBlock source={String(children).trimEnd()} endpoint={plantumlEndpoint} authHeader={plantumlAuthHeader} />
    }
    return <code className={className} {...props}>{children}</code>
  }
}
```

`MermaidBlock` / `PlantUmlBlock` 改造为：

```tsx
export function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    let cancelled = false
    void (async () => {
      try {
        const m = await getMermaid()
        const { svg } = await m.render(uniqueId(), source)
        if (!cancelled && ref.current) ref.current.innerHTML = svg
      } catch (err) {
        if (!cancelled && ref.current) {
          ref.current.innerHTML = `<pre class="prose__diagram-error">${escapeHtml((err as Error).message)}</pre>`
        }
      }
    })()
    return () => { cancelled = true }
  }, [source])
  return <div ref={ref} className="prose__diagram prose__diagram--mermaid" />
}
```

PlantUmlBlock 类似——把当前 `.render(mount, source, endpoint, authHeader)` 命令式 API 包成 React 组件。

### `ProseImage`

```tsx
function makeProseImage({ taskId }) {
  return function ProseImage({ src, alt, title }) {
    const ref = useRef<HTMLImageElement>(null)
    const resolved = resolveImageHref(src ?? '', taskId)
    useEffect(() => {
      if (!ref.current) return
      let zoom: { detach: () => void } | undefined
      void import('medium-zoom').then(({ default: mediumZoom }) => {
        if (ref.current) zoom = mediumZoom(ref.current, { background: 'rgba(0,0,0,0.85)' })
      })
      return () => { zoom?.detach() }
    }, [resolved])
    return <img ref={ref} src={resolved} alt={alt ?? ''} title={title} loading="lazy" />
  }
}
```

`resolveImageHref` 从 `MarkdownView.tsx:91` 抽到 `prose/imageHref.ts`（保留单元测试）。

### `highlighter.ts`（shiki 单例）

```ts
import type { Highlighter } from 'shiki'

let p: Promise<Highlighter> | null = null
const langs = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'sh', 'md', 'yaml', 'sql', 'python', 'diff'] as const

export function getHighlighter(): Promise<Highlighter> {
  if (p) return p
  p = (async () => {
    const { createHighlighter } = await import('shiki')
    return createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [...langs],
    })
  })()
  return p
}
```

### 字体策略

- 不引外网 CDN。Inter / JetBrains Mono woff2 静态拷贝进 `src/assets/fonts/`。
- 子集化：ASCII + Latin Extended（U+0000-024F），woff2 单 weight 约 30KB。中文跟随 system-ui。
- `prose.css` 顶部 5 个 `@font-face`，`font-display: swap` 避免 FOIT。
- 新增 CSS 变量：`--font-prose: 'Inter', system-ui, ...`；`--font-mono: 'JetBrains Mono', ui-monospace, ...`。

### Callout / Alert 渲染

`remark-github-blockquote-alert` 把 `> [!NOTE]` 转成 `<div class="markdown-alert markdown-alert-note">`。`prose.css` 给 5 种各一种边框 + 背景色（`color-mix(in srgb, var(--accent|--danger|...) 12%, transparent)`）+ 左色条 + 图标。

### Math

`remark-math` 解析 `$..$` / `$$..$$`，`rehype-katex` 渲成 KaTeX HTML。`prose.css` import `katex/dist/katex.min.css`（必需）；对 `.katex` 做轻 line-height tweak 对齐周围段落。

### 主题切换

`rehype-pretty-code` dual theme 输出 `style="--shiki-light:#x;--shiki-dark:#y;--shiki-light-bg:#a;--shiki-dark-bg:#b"`。`prose.css`：

```css
.prose [data-rehype-pretty-code-figure] code span {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}
:root[data-theme='dark'] .prose [data-rehype-pretty-code-figure] code span {
  color: var(--shiki-dark);
  background-color: var(--shiki-dark-bg);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .prose [data-rehype-pretty-code-figure] code span {
    color: var(--shiki-dark);
    background-color: var(--shiki-dark-bg);
  }
}
```

### 编辑器性能

`MarkdownEditor`：

```tsx
const deferred = useDeferredValue(value)
<Prose body={deferred} className="md-editor__preview" />
```

shiki 单例第一次 lazy import 后常驻；react-markdown 树由 React 自身 diff，连续击键只 patch 文本节点。

## 安全 / 兼容

- 不开 `rehype-raw`：raw HTML 全 escape。
- KaTeX `strict: false`：语法错误时降级显示原文不抛。
- shiki 不识别的语言 → plain `<pre><code>`，不报错。
- `.prose iframe, .prose object, .prose embed { display: none }`：防御性 CSS 兜底。
- mermaid / plantuml render 失败时显示 escape 过的源码。

## 测试策略

按 CLAUDE.md "Test-with-every-change"，逐 capability 一条；优先纯函数（imageHref 抽出来单测），其它走 React testing library。

| 测试文件 | 覆盖 capability | 备注 |
|---|---|---|
| `prose-gfm.test.tsx` | 表格 + 任务列表 + 删除线 + 脚注 | DOM 结构断言 |
| `prose-callouts.test.tsx` | 5 种 alert（note/tip/warning/important/caution） | `.markdown-alert-{kind}` |
| `prose-math.test.tsx` | `$x^2$` + `$$x$$` | 出现 `.katex` |
| `prose-code-mermaid.test.tsx` | ` ```mermaid ` → `<MermaidBlock>` | mock mermaid loader |
| `prose-code-plantuml.test.tsx` | ` ```plantuml ` → `<PlantUmlBlock>` | mock endpoint |
| `prose-code-shiki.test.tsx` | ` ```ts ` 出现 `--shiki-light` / `--shiki-dark` | jsdom 跑得动；happy-dom 实测后定 |
| `prose-headings-anchor.test.tsx` | `## H` → `<h2 id="h">` + `.prose__anchor` | |
| `prose-external-link.test.tsx` | `[x](https://...)` → `target=_blank rel="noopener noreferrer"` | |
| `prose-image-href.test.ts` | `resolveImageHref` 纯函数（absolute / relative / no-taskId / `.` prefix） | 从 `MarkdownView.tsx` 既有测试迁移 |
| `prose-image-zoom.test.tsx` | `<img>` 触发 medium-zoom mock 一次 | |
| `prose-editor-uses-prose.test.tsx` | `<MarkdownEditor>` 预览出 `<table>`；**源码层兜底**：`MarkdownEditor.tsx` 不含 `renderMarkdown` / `formatBoldItalic` 字符串 | 锁住"极简渲染器已删" |
| `prose-reviews-detail.test.tsx` | `<Prose>` 输出的 DOM 仍能被 `wrapAnchorsInDom` / 锚点查找命中 | 取代 `markdown-view.test.tsx` 主测试 |

`bun run typecheck && bun run test && bun run format:check` 三件套绿；`bun run e2e -- review.spec.ts` 跑一遍。

## 与 CLAUDE.md 约定的对齐

- **RFC workflow**：本 RFC 三件套先于实现落档，登记 plan.md / STATE.md，等用户批准后才动代码。
- **Test-with-every-change**：12 条测试随 PR 走，按 capability 拆分文件名（`prose-*.test.tsx`）。
- **CI**：每个 PR push 后立即按 `feedback_post_commit_ci_check` 查 GitHub Actions。
