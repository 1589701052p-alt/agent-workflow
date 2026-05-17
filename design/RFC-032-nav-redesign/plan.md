# RFC-032 — 任务分解

按 design.md §11 拆 3 个 PR，每个 PR 自带测试 + 可独立回退。

## PR1 — Shell 重构（顶栏 + 子导航 + RuntimeChip）

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T1 | 新建 `packages/frontend/src/lib/nav.ts`：`PRIMARY_NAV` 常量 + `resolveActiveNav` 纯函数 + 类型定义 | — |
| RFC-032-T2 | 新建 `packages/frontend/src/lib/nav.test.ts`：覆盖 §10.1 全部 case（10 条断言） | T1 |
| RFC-032-T3 | i18n：`zh-CN.ts` / `en-US.ts` 加 `nav.group.{agents,workflows,tasks}` / `nav.settingsGear.{label,tooltip}` / `nav.runtime.*` 键 + `Resources` 接口同步 | — |
| RFC-032-T4 | 新组件 `components/shell/TopBar.tsx` + `SubNav.tsx`：消费 `PRIMARY_NAV` + `resolveActiveNav` + `useTranslation`；`onSettings:true` 时 TopNav 全 inactive、`<SubNav>` 返回 null | T1, T3 |
| RFC-032-T5 | 新组件 `components/shell/RuntimeChip.tsx`：发 `/api/runtime/opencode` query，4 态 dot + tooltip + 点击跳 `/settings#runtime` | T3 |
| RFC-032-T5b | 新组件 `components/shell/SettingsGear.tsx`：齿轮 icon-button + `aria-label = t('nav.settingsGear.label')` + `aria-current="page"` 当 onSettings 真 + 点击 `navigate('/settings')` | T3 |
| RFC-032-T6 | `__root.tsx` 重写 `RootComponent`：保留 auth gate + bare shell，登录态换成 `<TopBar/>` + `<SubNav/>` + `<Outlet/>`；AppShell grid 根据 `onSettings` 切 `56/44/1fr` ↔ `56/0/1fr`；**PR1 阶段** 评审 / 反问入口暂以 SubNav 项形式挂在 "工作流" 下作为 placeholder（让 PR1 单独可用） | T4, T5, T5b |
| RFC-032-T7 | `styles.css`：删 `.sidebar*` 全段 + `.app-shell` grid 改成行；加 `.topbar*` / `.subnav*` / `.chip*` / `.icon-btn*` / `.settings-gear--active` 新样式（含 dark 主题） | T6 |
| RFC-032-T8 | Settings 页加 `#runtime` hash 锚点高亮：runtime 卡片在 `location.hash === '#runtime'` 时背景闪 2s（CSS animation + `useEffect` 设 timeout） | — |
| RFC-032-T9 | 新测试 `tests/runtime-chip.test.tsx`：§10.2 三态断言 | T5 |
| RFC-032-T9b | 新测试 `tests/settings-gear.test.tsx`：默认/active/点击三态 | T5b |
| RFC-032-T10 | 新测试 `tests/shell-no-sidebar.test.ts`：§10.3 源代码层兜底（含断言 onSettings 真时 DOM 无 `.subnav`） | T6, T7 |
| RFC-032-T11 | Playwright e2e `tests-e2e/nav-redesign.spec.ts` 第 1 + 4 + 5 条 case（happy path + settings gear + auth gate） | T6 |
| RFC-032-T12 | `bun run typecheck && bun run test && bun run format:check` 全绿 → push → 查 CI | all above |

**PR1 验收**：
- 顶栏 3 个一级 + 子导航在各路由下高亮正确；
- 右上齿轮在 `/settings` 下 active、其他路由 inactive；
- `/settings` 下子导航条整行消失（DOM 不存在 `.subnav`）；
- runtime chip 3 种 daemon 状态都有视觉反馈；
- 旧 sidebar CSS 与 JSX 一处不留；
- 所有现有 e2e（特别是 review / clarify / agent crud）仍 pass。

## PR2 — Inbox 合并

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T13 | i18n：加 `nav.inbox.*` 键 + `Resources` 同步 | PR1 落地 |
| RFC-032-T14 | 新组件 `components/shell/InboxChip.tsx`：合并两 `useQuery` 算总和；count=0 不渲染 badge；count>99 显 `99+` | T13 |
| RFC-032-T15 | 新组件 `components/shell/InboxDrawer.tsx`：portal 渲染到 body；segmented 切换；列表项点击跳详情；ESC / outside-click 关闭；初始焦点到首 segmented | T13 |
| RFC-032-T16 | `TopBar.tsx`：插入 `<InboxChip/>`；维护 drawer open 状态（lift state 到 TopBar 顶层 useState） | T14, T15 |
| RFC-032-T17 | 把 PR1 阶段挂在 "工作流" 子导航下的 `/reviews` `/clarify` placeholder 移除；`PRIMARY_NAV` 改回 design.md §3 的终态（工作流子导航只剩 1 项） | T16 |
| RFC-032-T18 | 单测 `tests/inbox-chip.test.tsx`：§10.2 全部 case | T14 |
| RFC-032-T19 | 单测 `tests/inbox-drawer.test.tsx`：§10.2 全部 case + ESC / outside click | T15 |
| RFC-032-T20 | Playwright e2e 第 2 条 case（inbox flow） | T17 |
| RFC-032-T21 | 改 `resolveActiveNav` 对 `/reviews` / `/clarify` 的归属断言（design §3 已经定义为 `primary:'workflows', secondaryTo:null`），更新 `nav.test.ts` 对应 case | T17 |
| RFC-032-T22 | typecheck / test / format / push / CI 查 | all above |

**PR2 验收**：
- inbox chip 合并 count 准确（手测 + e2e）；
- drawer 三段过滤、ESC、外部点击、列表点击跳转都符合预期；
- reviews / clarify 详情页本身行为零回归。

## PR3 — 抛光

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T23 | Runtime chip 点击跳转后 Settings 页 `#runtime` 锚点 scroll-into-view + 高亮闪动动画完善（PR1 的 T8 走最小可用，PR3 这里调整时长 / easing / 暗色模式色） | PR2 落地 |
| RFC-032-T24 | 键盘 nav：顶栏 tab 用 `←/→` 切；子导航用 `←/→` 切；按 `g i` 打开 inbox（不强制 v1 必须做，标 stretch） | — |
| RFC-032-T25 | 极窄屏（<1100px）：子导航横向滚动（已经在 CSS `overflow-x: auto`，加 fade mask 提示有更多） | — |
| RFC-032-T26 | Playwright e2e 第 3 条 case（runtime chip → settings#runtime） | T23 |
| RFC-032-T27 | typecheck / test / format / push / CI 查 | all above |

**PR3 验收**：
- runtime chip → Settings 闪烁视觉够直观；
- 极窄屏不破布局；
- 全 e2e 绿。

## RFC 完工标准

- 3 PR 全部 merged 到 main；
- CI 在 main 上至少跑过一次绿（含 e2e）；
- `design/plan.md` RFC 索引把 RFC-032 改 `Done`；
- `STATE.md` 已完成 issue 表加 RFC-032 一行（与 P-X-XX 同等级）；
- 旧 sidebar 截图存档不留（这是产品改版，不是回退选项）。

## 不在本 RFC 范围内的（写出来防止 scope creep）

- 移动端响应式 / 折叠菜单（<768px）。
- 用户偏好（"我永远想看见 inbox 展开"）持久化。
- 真合并后端 `/api/inbox/pending-count` 端点。
- `/runtime` 独立路由 / 独立页面。
- 顶栏快捷键完整 cheatsheet 弹窗。

以上若有需要，开 follow-up RFC。
