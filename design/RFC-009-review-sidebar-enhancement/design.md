# RFC-009 — 技术设计

## 总体架构

不引入新组件，**继续在 `packages/frontend/src/routes/reviews.detail.tsx` 单文件内扩展**——它已经持有 `markdownRef / bubblesRef / activeCommentId / bubbleTops / sortedComments` 全套 state，分拆反而引入跨文件 prop drilling。新增 hook `useResizable` 拆到 `packages/frontend/src/hooks/useResizable.ts`（约 60 行，纯 React、无新依赖）。

## 接口契约

### 后端：`PATCH /api/reviews/:nodeRunId/comments/:commentId`

**请求**

```json
{ "commentText": "string, min length 1" }
```

zod schema（放在 `packages/shared/src/schemas/review.ts`）：

```ts
export const UpdateReviewCommentBodySchema = z.object({
  commentText: z.string().min(1),
})
export type UpdateReviewCommentBody = z.infer<typeof UpdateReviewCommentBodySchema>
```

**响应**：200 + `ReviewComment`（更新后的对象）。

**错误码**

- `404 review_comment_not_found` — commentId 不存在或 nodeRunId 不匹配。
- `409 review_not_awaiting` — `awaitingReview === false`（已批 / 已拒 / 已迭代）。**和现有 DELETE 同款 409**。
- `400 invalid_body` — zod 校验失败。

**实现**：和现有 POST / DELETE 平级，复用同一张 `review_comments` 表的 update。`updatedAt` 字段——schema 里**没有**这字段（看现状只有 `createdAt`），本 RFC **不**新增，避免动数据库迁移；时间戳重排靠多 tab websocket 同步而非客户端排序。

**广播**：成功后通过现有 task ws hub 推 `{ type: 'review.comment.updated', nodeRunId, commentId }`，前端 `useTaskSync` 已经对 `review.*` 模糊匹配 invalidate，不需要前端额外订阅。

### 前端：`api.patch`

`packages/frontend/src/api/client.ts` 若无 `patch` 助手则加一个（先 grep 看；POST/DELETE/GET 都有的话 PATCH 应同款补齐）。

## 关键算法

### 行号计算 `computeLineRange`

放到 `packages/frontend/src/lib/review/lineRange.ts`：

```ts
export function computeLineRange(
  body: string,
  offsetStart: number,
  offsetEnd: number,
): { start: number; end: number } {
  // 1-based line numbers; \n 和 \r\n 都按一行算
  let line = 1
  let start = 1
  let end = 1
  for (let i = 0; i < body.length && i < offsetEnd; i++) {
    if (i === offsetStart) start = line
    if (body[i] === '\n') line++
  }
  end = line
  if (offsetStart >= body.length) start = line
  if (offsetEnd >= body.length) end = line
  return { start, end }
}
```

O(N) 一次扫整文；评论卡 N 张时整体 O(N·docLen)，对 docLen 10K + 评论 50 条仍 < 1ms，无需优化。`useMemo` 依赖 `[currentBody, sortedComments]` 缓存所有 range。

### `useResizable` hook

```ts
export function useResizable(opts: {
  storageKey: string
  initial: number
  min: number
  max: number
}): {
  width: number
  setWidth: (n: number) => void
  onResizerPointerDown: (e: React.PointerEvent) => void
}
```

实现要点：
- `useState` + `useEffect` 双向同步 `localStorage`。
- `onResizerPointerDown` 注册 `window pointermove / pointerup`，按 `e.clientX` 差值更新宽度；clamp 到 `[min, max]`；pointerup 移除监听 + 持久化。
- 拖拽期间设 `document.body.style.cursor = 'col-resize'` + `userSelect = 'none'`，结束清除。
- SSR 兼容性：`typeof window === 'undefined'` 时返回 `initial`（项目是 Vite SPA，理论上不需要，留个安全门）。

### 折叠态

独立的 `useLocalStorage<boolean>('agw-review-sidebar-collapsed', false)`（项目里若已无 useLocalStorage 工具，直接在组件里用 `useState + useEffect` 两行）。折叠态时：

- CSS `.review-detail__layout` 通过 inline `style={{ gridTemplateColumns: collapsed ? 'minmax(0,1fr) 32px' : `minmax(0,1fr) ${width}px` }}` 控制；
- 气泡列条件渲染 `comment-bubble` 或 `comments-collapsed-rail`；
- 折叠态下不跑 `measure()`（避免对 0 高度容器做 getBoundingClientRect）—— `useLayoutEffect` 内 early return。
- 折叠态下 J/K 仍生效（不影响主文档阅读），但视觉上 highlight 走主文档 `<mark>` data-active，气泡列不可见无所谓。

## 与既有 state 的耦合点

| 现有 state / effect | 本 RFC 影响 |
|---|---|
| `bubbleTops` measure（useLayoutEffect） | 折叠时 early return；展开后 ResizeObserver 已观察 `bubblesRef`，宽度变会自动重测 |
| `activeCommentId` IntersectionObserver | 不变 |
| 键盘 J/K | 新增条件 `editingId === null`；编辑态下不响应（避免 j/k 写入 textarea 时跳） |
| `popover` 新建评论 | 不变 |
| `submitComment / deleteComment` | 同款再加一个 `updateComment` |
| `useTaskSync` | 已模糊匹配 `review.*`，后端发 `review.comment.updated` 自动 invalidate |

## 失败模式

- **编辑冲突**：A tab 编辑时 B tab 删除同一评论 → PATCH 返回 404 → 前端 mutation onError 显示 toast / inline error "评论已被删除"，自动退出编辑态并 invalidate 查询。
- **网络中断**：PATCH 失败 → 编辑态保留，textarea 不清空，按钮显示错误；用户可重试或 Esc 放弃。
- **剪贴板权限**：`navigator.clipboard.writeText` reject（HTTP 上下文 / 用户拒绝）→ 按钮短暂显示"复制失败"（用 `copiedId` 同款 state，多一个 `copyFailedId`）。
- **awaitingReview 状态切换中**：若 A tab 编辑同时 B tab 触发 approve/reject/iterate，ws 推过来后前端 invalidate → useQuery 重新拉 → `isAwaiting=false` → 编辑按钮 disabled，但已在编辑态的 textarea 保留（不强制收起，让用户决定丢弃或保存——PATCH 服务端会 409 拒）。

## 视觉与样式

不引入新颜色 token。沿用 `var(--panel) / --border / --accent / --muted / --text)`。

新增 CSS 类（全部放 `packages/frontend/src/styles.css`，紧跟现有 `.comment-bubble` 段）：

```css
.review-detail__sidebar-header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--muted);
}
.review-detail__sidebar-count { font-variant-numeric: tabular-nums; }
.review-detail__sidebar-toggle {
  background: transparent; border: 0; cursor: pointer;
  color: var(--muted); font-size: 14px; padding: 2px 6px; border-radius: 4px;
}
.review-detail__sidebar-toggle:hover { background: var(--border); color: var(--text); }

.review-detail__sidebar-resizer {
  position: absolute; left: -2px; top: 0; bottom: 0; width: 4px;
  cursor: col-resize; z-index: 3;
  background: transparent;
}
.review-detail__sidebar-resizer:hover,
.review-detail__sidebar-resizer[data-dragging='true'] {
  background: var(--accent);
}

.comment-bubble__actions {
  display: flex; gap: 4px;
  position: absolute; top: 6px; right: 6px;
  opacity: 0; transition: opacity 0.1s ease;
}
.comment-bubble:hover .comment-bubble__actions,
.comment-bubble--active .comment-bubble__actions { opacity: 1; }
.comment-bubble__action {
  background: transparent; border: 0; cursor: pointer;
  color: var(--muted); font-size: 12px; padding: 2px 6px; border-radius: 4px;
  line-height: 1;
}
.comment-bubble__action:hover:not(:disabled) { background: var(--border); color: var(--text); }
.comment-bubble__action:disabled { opacity: 0.4; cursor: not-allowed; }

.comment-bubble__line-ref {
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
  margin-left: 8px;
}

.comment-bubble__edit-form { display: flex; flex-direction: column; gap: 6px; }
.comment-bubble__edit-form textarea { width: 100%; min-height: 60px; resize: vertical; }
.comment-bubble__edit-form-actions { display: flex; gap: 6px; justify-content: flex-end; }

.comments-collapsed-rail {
  width: 32px; display: flex; flex-direction: column; align-items: center;
  padding: 8px 0; gap: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
}
.comments-collapsed-rail__count {
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
}
```

旧 `.comment-bubble__delete` **保留**——只把它视觉合并到 `.comment-bubble__actions` 行（把 `×` 按钮当成 `.comment-bubble__action` 的一个 variant），不删 class 名，避免回归测试断言失效。

## 测试策略

后端：单元 + 集成（drizzle in-memory sqlite），覆盖 4 个 case（200/400/404/409 + ws 广播）。

前端：
1. **纯函数**：`computeLineRange` 5 case（单行 / 跨行 / 文末 / 含 `\r\n` / offsetEnd 越界）。
2. **inline edit**（@testing-library/react）：点编辑 → textarea 出 → Cmd+Enter 触发 mutation → mock api.patch 被调一次入参正确；Esc 不调；空文本 Save disabled。
3. **copy**：mock `navigator.clipboard.writeText` → 调一次入参 = commentText → 1.5s 显示 Copied。
4. **collapse / resize**：mock localStorage → 点折叠改 gridTemplateColumns → 拖 resizer 改宽度且 clamp → unmount + remount 后状态恢复。
5. **source-text regression**（扩 `review-detail-bubble-redesign.test.ts`）：reviews.detail.tsx 中必须出现 `comment-bubble__actions / comment-bubble__line-ref / useResizable / review-detail__sidebar-header`；不得出现旧的 `comment-list__` 类名。

e2e：扩 `e2e/review.spec.ts`：
- 走完一遍 inline edit（输入 → 保存 → 看到新文本）
- 复制（点 copy 按钮 → 用 evaluate 读 clipboard）
- 折叠 + 刷新后保持

## 与 RFC-008 的兼容

`<Prose>` 在 RFC-008 重写后输出的 DOM 结构（`<article class="prose">` + 标准 markdown 元素）和 `wrapAnchorsInDom` 已经协同工作（commit d9072c6 之前就跑通），本 RFC 不动 `<Prose>` 内部。
