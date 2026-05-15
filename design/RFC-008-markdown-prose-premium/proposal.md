# RFC-008 — Premium Markdown 渲染（review + 编辑器预览）

## 背景

agent-workflow 当前有两套 markdown 渲染管线：

- `MarkdownView`（review 详情页）：`marked` + DOMPurify，输出 HTML 注入 `.markdown-view` 容器。`styles.css` 里没有 `.markdown-view` 规则，所以浏览器默认样式接管，标题字体丑、段落无间距、列表无内缩、表格 / blockquote / hr 全部裸奔。
- `MarkdownEditor`（AgentForm / skills.detail 用的预览面板）：自家几十行的极简渲染器，不支持 GFM 表格 / 引用 / 链接 / 任务列表。

用户反馈"markdown 渲染的太丑了"，期望视觉对标 GitHub README + Stripe Docs 的阅读体验，且暗 / 亮主题切换跟随 P-5-04 主题系统。

## 目标

- review 详情页和 agent / skill 编辑器预览面板共用同一个 React 组件 `<Prose>`，样式自然同步。
- 支持的内容能力（按"premium"目标全开）：
  - GFM：表格、删除线、任务列表、脚注、autolink。
  - Callouts：`> [!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` 五色块。
  - Math：`$x^2$` 行内、`$$...$$` 块级，由 KaTeX 渲染。
  - 代码块：shiki dual theme（github-light / github-dark）+ 行高亮 `ts {1,3-5}` + `// [!code highlight/diff/focus]` 标记 + 文件名 caption。
  - 行内代码高亮：`` `x`{:ts} `` 语法。
  - 标题锚点：每个 heading 自动 slug；hover 出 `#` 链接。
  - 外链：自动 `target=_blank rel=noopener noreferrer` + 小图标。
  - 图片：相对路径走 worktree-files proxy；点击 medium-zoom 放大。
  - mermaid / plantuml：保留现有渲染，不退化。
- 字体：自托管 Inter（正文）+ JetBrains Mono（代码），子集化优先 ASCII + Latin Extended，中文跟随 system-ui。
- 暗色主题对齐 `data-theme` + `prefers-color-scheme` 双通道。

## 非目标

- 不做代码块"复制 / 行号 toggle / 折叠"装饰（超出"美观"范畴，单开 issue）。
- 不接 Excalidraw / Tikz / vega 等高阶图表。
- 不引入 MDX（用户内容不是作者内容）。
- 不做 RTL / 阿拉伯语 prose 适配。
- 不改 mermaid / plantuml 渲染逻辑，只把它们包到 React 组件里。

## 用户故事

- **设计师 / 文档作者**：写 review doc 里贴一段 TypeScript 代码、一张架构图、一份对比表格、一段 KaTeX 公式，能像 GitHub README 一样直接呈现，不需要前端工程师再配样式。
- **评审者**：在 review 详情页阅读 doc 时，标题层级清晰、代码块语法高亮、Callout 提醒醒目；切换暗色模式不灼眼。
- **agent 作者**：在 AgentForm 编辑 prompt body 时，右侧预览面板能立刻呈现表格、链接、代码高亮，避免"渲染只在 review 页才像样"的错位预期。

## 验收标准

1. review 详情页用 `<Prose>` 渲染 doc body，下述 capability 目测全部生效：
   - 标题层级（h1-h6）+ hover 锚点
   - 表格（含斑马纹）+ 任务列表 + 删除线
   - 五种 GitHub-style callout
   - KaTeX 行内 / 块级公式
   - shiki 代码块 + 暗 / 亮主题切换
   - mermaid / plantuml 不退化
   - 外链装饰 + 图片 medium-zoom
2. AgentForm / skills.detail 的 markdown 预览面板用同一 `<Prose>`，上述 capability 全部生效；输入响应不卡顿（`useDeferredValue` 防抖）。
3. 切换 P-5-04 主题（light/dark/system），代码块、callout、表格背景跟随。
4. `bun run typecheck && bun run test && bun run format:check` 三件套全绿；`e2e/review.spec.ts` 不退化（reject → iterate → approve 状态机锁仍生效）。
5. 首屏 chunk 不包含 shiki wasm / KaTeX 字体 / mermaid（按需 lazy）；进入 review 详情才加载。
6. **测试覆盖**（详见 design.md §测试策略）：12 条 prose-* 测试 case，按 capability 分文件锁。

## 与现有 RFC 的关系

- 依赖 RFC-005 的 review 状态机和 anchor / bubble 排版逻辑——本 RFC **不**改这些，只换 markdown 渲染层。`wrapAnchorsInDom.ts` / 锚点查找仍能在 `<Prose>` 出的 DOM 上工作（h1/p/table 等结构语义不变）。
- 与 RFC-007（canvas review/output drag）无交集。
