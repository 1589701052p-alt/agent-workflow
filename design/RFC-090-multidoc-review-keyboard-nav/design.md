# RFC-090 技术设计

## 接口契约（纯函数预言）

新文件 `packages/frontend/src/lib/review/multiDocHotkeys.ts`：

- `multiDocHotkeyAction(e: { key; ctrlKey; metaKey; altKey; shiftKey }): 'prev' | 'next' | 'accept' | 'not_accept' | null`
  - 任一修饰键（ctrl / meta / alt / shift）为真 → `null`（不遮蔽系统 / 浏览器快捷键与 Shift+方向键文本选择）。
  - `ArrowUp→prev`、`ArrowDown→next`、`q`/`Q`→`accept`、`w`/`W`→`not_accept`，其余 → `null`。
- `nextDocIndex(currentIdx, len, dir): number`
  - 夹紧不循环：`next → min(idx+1, len-1)`、`prev → max(idx-1, 0)`；`len<=0` 原样返回；`idx=-1`（找不到当前）两个方向均落到 0。

两者纯、无副作用、可直接单测——本 RFC 的首选可断言面。

## 组件接线（`components/review/MultiDocReviewView.tsx`）

- 新增 `const [paneCapturing, setPaneCapturing] = useState(false)`，把 `onShortcutCaptureChange={setPaneCapturing}` 传给 `<ReviewDocPane>`（此前多文档页面**未**传，单文档页面已传）。这复用 RFC-082 既有契约：pane 在 popover 打开 / 行内编辑评论时报告 `true`——即"正在填写检视意见"的权威信号。
- 单个 `window` keydown `useEffect`（与单文档页面同构）：
  1. `if (paneCapturing) return`（填写评论）
  2. `if (dialog !== null) return`（决策弹窗打开）
  3. `if (activeElement ∈ {INPUT, TEXTAREA, SELECT}) return`（任意输入控件聚焦——含退回理由文本域、pane 内文本域，双保险）
  4. `action = multiDocHotkeyAction(e)`；`null` → 返回
  5. `prev`/`next`：`documents` 为空则返回；`preventDefault()`；按 `nextDocIndex` 算目标并 `setSelectedDocId`
  6. `accept`/`not_accept`：仅当 `awaiting && 当前文档存在 && !selectionMut.isPending`；`preventDefault()`；`selectionMut.mutate({ docVersionId: activeDocId, selection })`
  - deps：`[paneCapturing, dialog, documents, activeDocId, awaiting, selectionMut]`
- 导航可视区：`listRef` 指向文档 `<ul>`，每个文档按钮加 `data-doc-id={d.docVersionId}`；监听 `activeDocId` 的 effect 里 `listRef.current?.querySelector([data-doc-id]).scrollIntoView({ block: 'nearest' })`（`block:'nearest'` 已可见即空操作，点击 / 挂载不会乱跳；jsdom 下 guard `typeof el.scrollIntoView === 'function'`）。

## 与现有模块耦合

- 复用 `selectionMut`（既有 `PATCH /api/reviews/:nodeRunId/documents/:docVersionId/selection`）、`setSelectedDocId`、`documents`、`awaiting`、`dialog`——零新增数据流 / 零后端改动。
- 复用 RFC-082 `onShortcutCaptureChange`——`ReviewDocPane` 无需改动。
- 与 `ReviewDocPane` 的 J/K（跨评论跳转，同样挂 `window`）不冲突：键位不同（J/K vs ↑/↓/Q/W），两个监听器各自按 capturing / 输入控件门控独立静默。

## 失败模式

- 修饰键组合 → 纯函数返回 `null`，不拦截（验收 4）。
- `activeDocId` 不在 `documents`（理论上不会，默认 = 首篇）→ `findIndex` 返回 -1，`nextDocIndex(-1, …)` 落到首篇，安全。
- selection PATCH 期间重复按键 → `isPending` 门控；即便落空，重复发同一 selection 幂等无害。
- readonly（非 `awaiting`）→ Q/W 静默（按钮本就只在 `awaiting` 显示）；↑/↓ 仍可浏览。

## i18n（zh 类型 + zh 值 + en 值，三处同步）

- `reviews.multiDoc.acceptHint` / `reviews.multiDoc.notAcceptHint`：按钮 `title`（标注 Q / W）。
- `reviews.multiDoc.shortcutHint`：操作区一行说明（"↑/↓ 切换文件 · Q 采纳 · W 不采纳"）。

## UI 一致性

- 不新增原生控件 / modal chrome；提示文案走既有 `.muted`；如需把提示推到操作区右侧，仅加一条最小 `.review-multidoc__shortcut-hint { margin-left: auto }`。按钮沿用既有 `.btn .btn--sm`、复用既有 `data-testid`（`multidoc-accept` / `multidoc-not-accept`）。

## 测试策略（必写）

- `tests/multidoc-hotkeys.test.ts`（纯函数 + 源码锚点）：
  - `multiDocHotkeyAction`：四键映射 + 大小写 `q`/`Q`·`w`/`W` + 其它键 `null` + 四种修饰键各自 `null`。
  - `nextDocIndex`：首端夹紧、尾端夹紧、正常增减、`len=0`、`idx=-1` 两方向落 0。
  - 源码锚点：断 `MultiDocReviewView.tsx` 传了 `onShortcutCaptureChange={setPaneCapturing}`、handler 含 `if (paneCapturing) return` / `if (dialog !== null) return` / 输入控件守卫、方向键 `preventDefault`、import 了两个纯函数。
- 扩展 `tests/review-multidoc-view.test.tsx`（JSDOM 行为）：
  - ArrowDown 使选中项从 Case A 移到 Case B（断 `aria-current`）。
  - `q` → selection 端点 `{ selection: 'accepted' }`；`w` → `{ selection: 'not_accepted' }`。
  - 抑制：打开退回弹窗后按 `q`，断言 selection 端点未被调用（`dialog!==null` 分支）；`body.appendChild` 一个聚焦 `textarea` 后按 `q`，断言未调用（输入控件分支）。
- 门槛：`bun run typecheck && bun run test && bun run format:check` 全绿；frontend vitest 全绿；推后查 CI（GitHub Actions）。
