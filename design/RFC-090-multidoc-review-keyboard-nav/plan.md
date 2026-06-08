# RFC-090 任务分解

单 PR（小而内聚）。commit 前缀 `feat(frontend): RFC-090 多文档检视键盘导航`。

| 子任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-090-T1 | 纯函数：新增 `lib/review/multiDocHotkeys.ts`（`multiDocHotkeyAction` + `nextDocIndex`）。 | 无 |
| RFC-090-T2 | i18n：`reviews.multiDoc.acceptHint` / `notAcceptHint` / `shortcutHint`（zh 类型 + zh 值 + en 值，三处同步）。 | 无 |
| RFC-090-T3 | 接线：`MultiDocReviewView.tsx` 加 `paneCapturing` + `onShortcutCaptureChange`、window keydown effect、`listRef` + 滚动 effect、按钮 `title` + 操作区提示 + `data-doc-id`；若需 `.review-multidoc__shortcut-hint { margin-left:auto }` 最小样式。 | T1、T2 |
| RFC-090-T4 | 测试：`tests/multidoc-hotkeys.test.ts`（纯函数 + 源码锚点）+ 扩展 `tests/review-multidoc-view.test.tsx`（行为 + 抑制）。 | T1–T3 |
| RFC-090-T5 | 门禁 + 收尾：`typecheck` / `test` / `format:check` 全绿，commit + push，查 CI；`design/plan.md` RFC 索引置 Done、`STATE.md` 同步。 | T1–T4 |

## PR 拆分建议

单 PR 即可（改动局限于一个组件 + 一个纯函数模块 + i18n + 测试）。

## 验收清单

对齐 `proposal.md` §验收标准 1–6：

- [ ] ↑/↓ 切换选中项（夹紧不循环）+ 滚动进可视区
- [ ] Q→accepted、W→not_accepted，命中 selection 端点
- [ ] popover / 行内编辑 / 输入控件聚焦 / 决策弹窗打开时全部静默
- [ ] ↑/↓ `preventDefault`；修饰键组合不拦截
- [ ] 按钮 `title` + 操作区快捷键提示
- [ ] 纯函数 + 组件行为 + 源码锚点测试齐全，门禁全绿
