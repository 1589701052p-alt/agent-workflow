# RFC-008 — 任务分解

> RFC-008 编号：`design/RFC-007-canvas-review-output-drag/` 已被占用，本 RFC 走 RFC-008。

## PR 拆分（建议 3 个 PR）

| 子任务 | 内容 | 关键文件 | 测试 |
|---|---|---|---|
| **RFC-008-T1** | 装基础依赖；建 `Prose.tsx` + `CodeBlock.tsx` + `ProseImage.tsx` + `highlighter.ts` + `prose.css`；接 react-markdown + remark-gfm + rehype-pretty-code + shiki + rehype-slug + rehype-autolink-headings + rehype-external-links。**暂不**接 callouts / math / medium-zoom。 | `packages/frontend/src/components/prose/*`、`packages/frontend/package.json`、`packages/frontend/src/main.tsx` | `prose-gfm.test.tsx`、`prose-code-shiki.test.tsx`、`prose-code-mermaid.test.tsx`、`prose-code-plantuml.test.tsx`、`prose-headings-anchor.test.tsx`、`prose-external-link.test.tsx`、`prose-image-href.test.ts` |
| **RFC-008-T2** | 接 `remark-github-blockquote-alert`、`remark-math` + `rehype-katex` + KaTeX CSS、`medium-zoom`；扩展 `prose.css` 五种 callout 配色 + KaTeX line-height tweak + 防御性 iframe/object/embed 隐藏。 | `Prose.tsx`、`ProseImage.tsx`、`prose.css`、`package.json` | `prose-callouts.test.tsx`、`prose-math.test.tsx`、`prose-image-zoom.test.tsx` |
| **RFC-008-T3** | 把消费者切到 `<Prose>`；删旧 `MarkdownView.tsx` / 极简渲染器 / 旧测试；接入自托管字体（Inter + JetBrains Mono woff2）；端到端 e2e。 | `routes/reviews.detail.tsx`、`MarkdownEditor.tsx`、`MermaidBlock.tsx` / `PlantUmlBlock.tsx`（命令式 API → React 组件改造）、`styles.css`、`src/assets/fonts/*`、`prose.css` 字体段 | `prose-editor-uses-prose.test.tsx`、`prose-reviews-detail.test.tsx`、e2e `review.spec.ts` 全跑 |

每个 PR 必须 `bun run typecheck && bun run test && bun run format:check` 全绿；push 后立即查 GitHub Actions 状态（feedback_post_commit_ci_check）。

## 依赖图

```
T1（基础壳子 + shiki + 锚点 + 外链）
  │
  ├──> T2（callouts + math + zoom）—— 可并行写，但合并顺序在 T1 后
  │
  └──> T3（替换消费者 + 删旧 + 字体 + e2e）—— 必须最后
```

## 验收清单

- [ ] T1 PR 合并：`<Prose>` 能渲 GFM + shiki 代码块 + 标题锚点 + 外链装饰；mermaid / plantuml 走对应组件；7 条测试绿。
- [ ] T2 PR 合并：5 种 callout / KaTeX / medium-zoom 全工作；3 条测试绿。
- [ ] T3 PR 合并：reviews.detail + AgentForm + skills.detail 全部用 `<Prose>` 预览；删 `MarkdownView.tsx` + `MarkdownEditor` 极简渲染器；字体接入；e2e 不退化；2 条新测试 + 旧测试迁移完成。
- [ ] STATE.md：T3 合并时把"进行中 RFC: RFC-008"清掉，加入"已完成 RFC"。
- [ ] design/plan.md RFC 索引状态从 Draft → In Progress → Done。
- [ ] 浏览器人测：review 详情页 + agent 编辑器 + skill 编辑器三处都目测通过。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| shiki wasm 在 happy-dom 跑不动 → 测试卡 | `prose-code-shiki.test.tsx` 用 vitest mock shiki，只断 placeholder 节点；真正的 shiki 高亮放浏览器人测 |
| react-markdown 9 是 ESM-only，vite 配可能不兼容 | vite 6 默认 ESM，不预期问题；T1 实测后若不行，加 `optimizeDeps.include` |
| KaTeX 字体 70KB 拖首屏 | T2 落地后从 entry chunk 验；如果上首屏，改成 dynamic `import('katex/dist/katex.min.css')` |
| medium-zoom 卸载时 ref 未释放 → 测试报内存泄漏 | `useEffect` cleanup 显式 `zoom?.detach()` |
| `MermaidBlock` / `PlantUmlBlock` 从命令式改 React 组件，可能 break 现有 review e2e | T3 阶段先在 review.spec.ts 加一条 mermaid 渲染断言 baseline，改造后保持 |
| 字体子集化需要 fonttools / glyphhanger 工具 | T3 用 Google Fonts 已经子集化好的 woff2 直拷（latin/latin-ext 两份），不在本仓跑子集脚本 |
