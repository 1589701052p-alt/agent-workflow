# RFC-010 — 任务分解

## 子任务表

| ID         | 描述                                                                                                                                                                                                                                                                                                                                  | 产物           | 依赖  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- |
| RFC-010-T1 | `lib/review/markdownDiff.ts`：`buildMergedMarkdown(left, right, granularity): string` + `MARKERS` 常量 + 行首 markdown 结构字符前缀保留 + 三种 granularity（`word` / `line` / `block`）的 jsdiff 路径分发 + CJK `splitForWordDiff`（仅 word 路径用） + 单测 `markdown-diff-build.test.ts`（每种 granularity 各组 fixture）            | 1 src + 1 test | —     |
| RFC-010-T2 | `lib/review/remarkDiffMarkers.ts`：unified Plugin + `splitMarkers` 状态机 + 自定义 `diffMark` 节点（`data.hName`/`data.hProperties`）+ 容错未配对 marker + 单测 `markdown-diff-plugin.test.ts`                                                                                                                                        | 1 src + 1 test | T1    |
| RFC-010-T3 | `components/review/MarkdownDiffView.tsx`：接收 `left` / `right` / `granularity` props → `buildMergedMarkdown` → ReactMarkdown 用 remark-gfm + remark-alert + remark-math + remarkDiffMarkers + 同套 rehype 链；try/catch fallback；测试 `markdown-diff-view.test.tsx` 三 granularity 各覆盖                                           | 1 src + 1 test | T2    |
| RFC-010-T4 | `components/review/DiffView.tsx`：**整体改写**为薄壳——所有 granularity 都 delegate 到 `MarkdownDiffView`；删除旧的 `useEffect` 滚动同步、`useRef` pane、`renderPane` / `changesToSegments` / `headingSlug` / `slugify` / `_internal` 等死代码；保持公开接口（`DiffViewProps`、`DiffGranularity`）不变以便 `reviews.detail.tsx` 零改动 | 重写           | T3    |
| RFC-010-T5 | `tests/diff-view.test.ts` 重写：删除 `_internal` helper 测试；保留 / 新增源码层断言锁定三 granularity 都 delegate 到 `MarkdownDiffView`；锁"DiffView 不再含 useEffect / useRef"                                                                                                                                                       | 重写           | T4    |
| RFC-010-T6 | `styles.css`：`.markdown-diff-view .diff-ins` + `.diff-del` + 暗色 media query                                                                                                                                                                                                                                                        | CSS append     | —     |
| RFC-010-T7 | 文档同步：`design/plan.md` RFC 索引；`STATE.md` 顶部"进行中 RFC"；完工后改 Done                                                                                                                                                                                                                                                       | 2 修改         | T1–T6 |
| RFC-010-T8 | line 模式 trailing-newline bug fix（用户回归）：`computeChanges` 在 line 路径调 `diffLines` 前对 left/right 做 `ensureTrailingNewline`；新增 4 build + 2 view 测试锁裸 heading / 列表 / blockquote / 多行单行替换都能正确分行渲染（无 `\n` 时也是）                                                                                   | 修复 + 6 测试  | T1–T6 |

## PR 拆分

**单 PR**：覆盖 T1–T7。原因：T1–T6 互相耦合（数据流串联），单 PR 才能保证回归测试一次跑齐；T7 是文档同步，不另立。

commit message：

```
feat(review): RFC-010 Markdown-rendered inline diff (word + line + block)

- DiffView 三种 granularity 全部改为渲染态 prose 内联高亮（参考 markdown-diff，绕开 rehype-raw）
- 新增 buildMergedMarkdown(left, right, granularity) + remarkDiffMarkers 插件 + MarkdownDiffView 组件
- DiffView 整体改写为薄壳；删除旧的 side-by-side pane / scroll-sync / _internal helper 死代码
- 新增样式 .diff-ins / .diff-del（含暗色）
- 测试：构建函数三 granularity 各组 fixture / remark 插件 / 组件渲染三 granularity / DiffView 源码层断言
```

Co-Authored-By 行按现仓约定。

## 验收清单（PR 自检）

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（前端 + 后端 + shared）
- [ ] `bun run format:check` 全绿
- [ ] 手测：在 review 详情页切到 word 模式，看到渲染态内联高亮（`bun run dev` 启动 + 任意有两份 doc_version 的 review）
- [ ] CI Actions（push 后立即查）3 项全绿（典型 ~3 min）
- [ ] `design/plan.md` RFC 索引含 RFC-010
- [ ] `STATE.md` 顶部进行中 RFC 行 + 完工后已完成 RFC 行同步

## 不做的事（本 RFC 范围外，记录以防将来歧义）

- side-by-side 渲染态视图
- fenced code block 内部 word-level diff
- 跨 doc_version 链的"累计 diff"（多版本之间一次看完）
- 自定义颜色 / 主题切换 UI（用 prefers-color-scheme 自动跟随）
