# RFC-082 — 任务分解与 PR 拆分

状态：Draft

## PR 拆分（强序）

- **PR-0（过渡，可选）**：把 2026-06-04 已在工作树的"多文档视口适配 + 滚动模型对齐"布局修复单独提交止血（`MultiDocReviewView.tsx` 包 `.review-multidoc__scroll`、`styles.css`、`reviews-multidoc-viewport-fit.test.ts`）。**OQ-4 决策**：建议先合 PR-0（用户已多轮确认布局问题），PR-A/B 再做真正抽取；PR-B 会把这版扁平评论列表替换为 `<ReviewDocPane>`，届时同步调整该测试。若用户希望一步到位，可跳过 PR-0、把布局改动并入 PR-B。
- **PR-A**：抽取 `<ReviewDocPane>` + `useCommentBubbles`，**单文档评审页迁移到 pane（零回归）**。这是高风险大头，必须先落且 CI 全绿。
- **PR-B**：**多文档评审页迁移到 `<ReviewDocPane>`**，删除自写扁平评论列表 + 选区/popover，更新 CSS 与视口适配测试。依赖 PR-A。

## 子任务

### PR-A — 抽取 + 单文档迁移

- **RFC-082-T1**：抽 `useCommentBubbles`（或 `lib/review/bubbleLayout.ts` 纯函数）——输入：各 anchor 的 rect/height、header 高度、容器高；输出：`bubbleTops: Map<id,number>` + `bubblesMinHeight`。把 `reviews.detail.tsx` 的测量 effect 改为调用它。**测试**：排序/防重叠下移/header floor/orphan 锚点四类纯逻辑单测。依赖：无。
- **RFC-082-T2**：新建 `components/review/ReviewDocPane.tsx`，按 design §2 props 封装 `<Prose anchors>` + 锚定气泡侧栏（折叠/拖宽/scroll-spy/J-K/内联编辑/复制/badge）+ 选区 popover（含 crossHeadingHint）+ 评论增删改 mutation（键=`docVersionId`）。沿用 `.review-detail__*` class。依赖：T1。
- **RFC-082-T3**：`reviews.detail.tsx` 非 diff 分支改渲染 `<ReviewDocPane>`；diff/历史/整篇决策/版本列表/取数全部留在路由。删掉已搬进 pane 的内联 state/effect/JSX。**测试**：RFC-005/008/009/013 既有测试不改且全绿；新增源代码层断言「非 diff 分支渲染 `<ReviewDocPane>`」。依赖：T2。

### PR-B — 多文档迁移

- **RFC-082-T4**：`MultiDocReviewView.tsx` 对当前选中文档渲染 `<ReviewDocPane nodeRunId docVersionId={activeDocId} body comments readonly={!awaiting} onInvalidate />`；保留左侧文档导航、每篇采纳/不采纳、轮级三决策 Dialog。**删除**自写的 `.review-multidoc__comments` 扁平列表、`onMouseUp`/`popover` 选区逻辑、`proseAnchors`（移入 pane）。依赖：T2。
- **RFC-082-T5**：CSS 收尾——删除不再被引用的 `.review-multidoc__comments` / `.review-multidoc__comment*` 规则（**逐条确认无其它引用再删**，符合多人协作"绝不误删"原则；存疑则保留）；保留 `.page.review-multidoc` / `.review-multidoc__list` / `.review-multidoc__scroll` 视口骨架，但 `__scroll` 内改由 pane 的 `.review-detail__layout` 承担滚动。更新 `reviews-multidoc-viewport-fit.test.ts`：锁「评论由 ReviewDocPane 渲染、左列表独立滚动、整页不滚」。依赖：T4。
- **RFC-082-T6**：补测——多文档复用源代码层断言（渲染 `<ReviewDocPane>` 且无自写 `review-multidoc__comment` 单条项）；pane readonly 门禁断言（无 popover/编辑/删除）；多文档切换文档时 `docVersionId` 随 `activeDocId` 变更断言。依赖：T4、T5。
- **RFC-082-T7**：STATE.md / design/plan.md 收尾（RFC-082 状态 Draft→Done、已完成清单加行）；push 后查 CI（双 OS lint/typecheck/test + 单二进制 smoke + Playwright e2e）全绿。依赖：T3、T6。

## 依赖图

```
T1 ─▶ T2 ─▶ T3        (PR-A，CI 绿后)
            └─▶ T4 ─▶ T5 ─▶ T6 ─▶ T7   (PR-B)
PR-0（可选，独立，先合止血）
```

## 验收清单

- [ ] `ReviewDocPane.tsx` 落地，封装 markdown + 锚定评论侧栏 + 评论增删改 + 选区评论。
- [ ] 单文档评审页改用 pane，RFC-005/008/009/013 测试零回归，diff/历史/决策/快捷键/持久化不变。
- [ ] 多文档评审页对当前文档用 pane，获得气泡/折叠/拖宽/跳转/内联编辑/复制；切换文档正文+评论同步。
- [ ] 多文档自写扁平评论列表 + 选区/popover 删除；CSS 死规则清理（确认无引用）。
- [ ] 左侧文档导航独立滚动、整页无文档级滚动条（保留 2026-06-04 视口适配契约）。
- [ ] 新增/迁移测试：bubble 纯逻辑单测、单文档零回归锁、多文档复用锁、readonly 门禁。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿；CI 全绿（含单二进制 smoke + Playwright e2e）。
- [ ] STATE.md / design/plan.md 收尾，RFC-082 状态置 Done。

## 备注

- 本 RFC 是**等能力抽取 + 复用**，不新增评审功能；任何"顺手加能力"的冲动应另开 RFC。
- 抽取触及 `reviews.detail.tsx`（1495 行，多处他人历史改动）：动手前若工作树有他人在途改动撞同段，先停下问用户。
