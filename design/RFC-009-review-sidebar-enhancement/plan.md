# RFC-009 — 实施计划

默认单 PR：`feat(review): RFC-009 review sidebar enhancement`。本地按 T1→T6 顺序提交中间 commit；最终 squash 与否由用户决定。如 T1 后端独立性强、用户希望先评 API，可拆 PR-A（T1）+ PR-B（T2-T6）。

## 子任务

### RFC-009-T1：后端 PATCH endpoint

- 修改 `packages/shared/src/schemas/review.ts`：新增 `UpdateReviewCommentBodySchema`、导出 `UpdateReviewCommentBody` 类型。
- 修改 `packages/backend/src/routes/reviews.ts`：在 DELETE 之后插入 `PATCH /api/reviews/:nodeRunId/comments/:commentId` handler；复用现有 `requireAwaitingReview / loadDetail` 工具（看 POST/DELETE 现状再决定具体复用名）；ws 广播 `review.comment.updated`。
- 新增 `packages/backend/tests/reviews-comment-patch.test.ts`：4 case（200 / 400 / 404 / 409 + ws 事件）。
- 验收：`bun test packages/backend` 全绿。

### RFC-009-T2：useResizable hook + 折叠/宽度持久化

- 新建 `packages/frontend/src/hooks/useResizable.ts`（约 60 行）。
- 修改 `packages/frontend/src/routes/reviews.detail.tsx`：
  - 引入 `useResizable({ storageKey: 'agw-review-sidebar-width', initial: 280, min: 240, max: 520 })`。
  - 新增 `collapsed` state（独立 useState + localStorage `'agw-review-sidebar-collapsed'`）。
  - `.review-detail__layout` inline style 受 `collapsed / width` 控制。
  - 渲染 sidebar header（含 collapse toggle）+ resizer + 折叠态 rail。
  - `useLayoutEffect measure()` 在 `collapsed === true` 时 early return。
- 修改 `packages/frontend/src/styles.css`：新增 6 类 class（见 design.md 视觉与样式）。
- 新增 `packages/frontend/tests/review-sidebar-collapse-resize.test.tsx`：折叠、拖宽 clamp、持久化恢复 3 case。
- 验收：`bun run typecheck && bun test packages/frontend` 全绿。

### RFC-009-T3：内联编辑 UI + mutation

- 修改 `packages/frontend/src/routes/reviews.detail.tsx`：
  - 新增 `editingId / editDraft` state。
  - 新增 `updateComment = useMutation(api.patch(...))`，onSuccess invalidate + 退出编辑态。
  - 评论卡条件渲染：editingId === c.id 时正文换 textarea + Save/Cancel；textarea onKeyDown 处理 Cmd+Enter / Esc。
  - J/K 键 effect 加 `editingId === null` 条件。
- 修改 `packages/frontend/src/api/client.ts`：若无 `patch` 助手则补。
- 新增 `packages/frontend/tests/review-sidebar-inline-edit.test.tsx`：4 case（开编辑、保存、取消、!awaiting disabled）。
- 验收：typecheck + test 全绿。

### RFC-009-T4：复制按钮 + 提示

- 修改 `packages/frontend/src/routes/reviews.detail.tsx`：
  - 新增 `copiedId` state，1500ms setTimeout 清空。
  - 评论卡 actions 加 copy 按钮，调 `navigator.clipboard.writeText(c.commentText)`。
  - 失败分支：catch → 显示"复制失败" 文案 1500ms。
- 新增 `packages/frontend/tests/review-sidebar-copy.test.tsx`：2 case（成功 + 失败）。
- 验收：typecheck + test 全绿。

### RFC-009-T5：行号 + 数量 badge + sticky header

- 新建 `packages/frontend/src/lib/review/lineRange.ts`：`computeLineRange` 纯函数。
- 修改 `packages/frontend/src/routes/reviews.detail.tsx`：
  - useMemo 算 `lineRanges: Map<commentId, {start,end}>`，依赖 `[currentBody, sortedComments]`。
  - 评论卡 header 行加 `<span className="comment-bubble__line-ref">` 显示行号。
  - sidebar header 显示 `评论 · {count}`。
- 新增 `packages/frontend/tests/review-sidebar-line-ref.test.ts`：5 case（纯函数测试）。
- 修改 `packages/frontend/tests/review-detail-bubble-redesign.test.ts`：扩源码层断言（见 design.md 测试策略 5）。
- 验收：typecheck + test 全绿。

### RFC-009-T6：i18n + e2e + 视觉打磨 + RFC 收官

- 修改 `packages/frontend/src/i18n/zh.json` + `en.json`：新增 9 条 key（见上层 plan）。
- 修改 `e2e/review.spec.ts`：加 inline-edit / copy / collapse 三个场景。
- 视觉打磨：跑 `bun run dev` 实测，检查响应式（≤720px）下行为；按需微调 padding / 字号。
- `bun run typecheck && bun run test && bun run format:check` 必须全绿。
- 推送后立刻按 [feedback_post_commit_ci_check] 查 GitHub Actions。
- 更新 `STATE.md`：把 RFC-009 从"进行中"挪到完成区。
- 更新 `design/plan.md` RFC 索引：RFC-009 状态改 Done。

## 依赖关系

- T1 独立可先跑。
- T2 独立可先跑（不依赖 T1）。
- T3 依赖 T1（PATCH 接口）+ T2（折叠态影响 measure）。
- T4 独立但建议在 T3 之后做（共用 actions 行 DOM）。
- T5 依赖 T2 的 sticky header 容器。
- T6 依赖 T1–T5 全部完成。

## 不在本 RFC 范围

- 行内代码、math 公式、列表等"评论富文本"输入 → 单独 issue。
- 评论 reply / 线程 → 单独 RFC。
- 评论标记"已解决"状态 → 单独 RFC。
- Prose 渲染时插入 `data-line-start`（md-review 风格的元素级行号锚） → 单独 RFC（要动 schema 和 wrapAnchorsInDom 协议）。
