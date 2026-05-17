# RFC-032 — 技术设计

## 1. 影响范围

| 改 | 不改 |
| --- | --- |
| `packages/frontend/src/routes/__root.tsx` 重写 shell 部分 | 路由 URL 表（所有现有 routes 保留） |
| `packages/frontend/src/styles.css` `--- Shell ---` 段（删 `.sidebar*`，加 `.topbar*` / `.subnav*` / `.inbox-chip*` / `.runtime-chip*` / `.inbox-drawer*`） | DB schema、所有后端表 |
| `packages/frontend/src/components/LanguageSwitch.tsx`：保留组件，调用方从 sidebar 底部搬到 topbar chip 容器；内部样式无须改 | 后端 routes（不新增、不删除） |
| 新文件 `packages/frontend/src/components/shell/TopBar.tsx`、`SubNav.tsx`、`InboxChip.tsx`、`InboxDrawer.tsx`、`RuntimeChip.tsx`、`SettingsGear.tsx` | shared 包（无需变更） |
| 新文件 `packages/frontend/src/lib/nav.ts`（`resolveActiveNav` 纯函数） | i18n 现有 `nav.{agents,...}` 文本 |
| `packages/frontend/src/i18n/{en-US,zh-CN}.ts` 增量加 `nav.group.*` / `nav.inbox.*` / `nav.runtime.*` | `Resources` 接口里现有 nav 字段保留 |
| 新测试文件（见 §测试策略） | 现有测试（不重命名、不删除） |

**0 backend / 0 shared / 0 DB migration**。这是纯前端外壳重构。

## 2. 组件拆分

```
__root.tsx (RootComponent)
├── AppShell                // 容器，grid 模板 56 / [44|0] / 1fr（onSettings 时第二行塌成 0）
│   ├── TopBar
│   │   ├── Brand           // 复用现有 sidebar__brand svg
│   │   ├── TopNav          // 3 个一级 tab（resolveActiveNav 决定 active；onSettings 时全部 inactive）
│   │   └── TopBarRight
│   │       ├── RuntimeChip       // 用 /api/runtime/opencode（已存在）
│   │       ├── InboxChip         // 合并 reviews + clarify pending-count
│   │       ├── LanguageSwitch    // 复用现有组件
│   │       ├── ThemeToggle       // 复用现有 useApplyTheme
│   │       └── SettingsGear      // ⚙ icon-button，onSettings 时加 active 描边；点 → /settings
│   ├── SubNav              // 当前一级 tab 对应的二级条目；onSettings 时整行不渲染
│   └── <Outlet/>           // main content
└── InboxDrawer             // portal 渲染到 body；ESC / 点空白关闭
```

新组件全部走 **纯 props + tanstack-query 内联**，不引入新 store。

## 3. 一级 / 二级导航数据模型

集中定义在新文件 `lib/nav.ts`：

```ts
export type PrimaryKey = 'agents' | 'workflows' | 'tasks'

export interface SubNavItem {
  to: string                // 路由路径，与现有 route 完全一致
  i18nKey: string           // 复用现有 nav.* 文案
  group?: 'capability' | 'runtime'  // 视觉分隔用（capability 后接 sep 再到 runtime）
}

export interface PrimaryNavEntry {
  key: PrimaryKey
  i18nKey: string           // 一级 label
  subnav: SubNavItem[]
}

export const PRIMARY_NAV: PrimaryNavEntry[] = [
  {
    key: 'agents',
    i18nKey: 'nav.group.agents',
    subnav: [
      { to: '/agents',  i18nKey: 'nav.agents',  group: 'capability' },
      { to: '/skills',  i18nKey: 'nav.skills',  group: 'capability' },
      { to: '/mcps',    i18nKey: 'nav.mcps',    group: 'capability' },
      { to: '/plugins', i18nKey: 'nav.plugins', group: 'capability' },
      { to: '/runtime', i18nKey: 'nav.runtime', group: 'runtime' },
    ],
  },
  {
    key: 'workflows',
    i18nKey: 'nav.group.workflows',
    subnav: [{ to: '/workflows', i18nKey: 'nav.workflows' }],
  },
  {
    key: 'tasks',
    i18nKey: 'nav.group.tasks',
    subnav: [
      { to: '/tasks', i18nKey: 'nav.tasks' },
      { to: '/repos', i18nKey: 'nav.repos' },
    ],
  },
]

/**
 * 把 pathname 映射到 (primaryKey, secondaryTo, onSettings)。
 *
 * - `/settings`：onSettings:true，primary/secondaryTo 均 null —— 右上齿轮按钮 active，
 *   三个一级 tab 全部不高亮，子导航条整行不渲染。
 * - `/reviews` / `/clarify`：只能从 InboxDrawer 打开；落到这两个 URL 时，让一级
 *   仍高亮"工作流"（业务归属），子导航无任何 active。
 */
export function resolveActiveNav(pathname: string): {
  primary: PrimaryKey | null
  secondaryTo: string | null
  onSettings: boolean
} {
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return { primary: null, secondaryTo: null, onSettings: true }
  }
  if (pathname.startsWith('/reviews') || pathname.startsWith('/clarify')) {
    return { primary: 'workflows', secondaryTo: null, onSettings: false }
  }
  for (const entry of PRIMARY_NAV) {
    for (const sub of entry.subnav) {
      if (pathname === sub.to || pathname.startsWith(sub.to + '/')) {
        return { primary: entry.key, secondaryTo: sub.to, onSettings: false }
      }
    }
  }
  return { primary: null, secondaryTo: null, onSettings: false }
}
```

### 3.1 关于 `/runtime` 子路由

verdict：**v1 不新建独立 `/runtime` 路由**，"运行时" 子导航点击直接跳 `/settings#runtime` —— Settings 页对 Runtime 卡片做 hash 锚点高亮（背景闪 2s）。

理由：当前 Settings 已经有 RFC-001 落成的 Runtime 卡片，独立 `/runtime` 路由要么搬走那块要么复制一遍。本 RFC 范围是外壳重构，不动页面内部；用 hash anchor 兜底成本最低，未来真要独立路由可作 follow-up。

`PRIMARY_NAV` 里 `/runtime` 仍作为**伪 URL**列在代理组子导航最后（前置 `·` 分隔），点击时 `<SubNav>` 拦截并实际 navigate 到 `/settings#runtime`。`resolveActiveNav` 在 `/settings` 上返回 `onSettings:true`，**三个一级 tab 全部不高亮**——这是 settings 作为 chip 入口后的明确取舍（齿轮按钮自身的 active 状态承担"我在哪儿"的信号）。

### 3.2 关于 `/settings` 路径下的视觉

落在 `/settings` 时：

- 顶栏 3 个一级 tab：全部 inactive；
- 顶栏右上齿轮按钮 SettingsGear：active（描边色变 accent + 内填色加深）；
- 子导航条整行**不渲染**（`AppShell` grid 模板从 `56px / 44px / 1fr` 切到 `56px / 0 / 1fr`，让出 44px 给 Settings 页内部 tab 用）。

切回任何主流程路由（例如 `/agents`）时齿轮 inactive、子导航行恢复。

## 4. Inbox 行为

### 4.1 Pending count 合并

**沿用现有两端点**，在 `InboxChip.tsx` 里发两个 `useQuery`，前端做加法：

```ts
const reviews  = useQuery<ReviewPendingCount>({ queryKey: ['reviews','pending-count'],  ... })
const clarify  = useQuery<ClarifyPendingCount>({ queryKey: ['clarify','pending-count'], ... })
const total = (reviews.data?.count ?? 0) + (clarify.data?.count ?? 0)
```

- 这俩 `useQuery` 已经在当前 `__root.tsx` 里存在；本 RFC 把它们从 `RootComponent` 抽到 `InboxChip`。
- 两查询 key 与 `refetchInterval: 15000` 保持不变 → reviews / clarify 详情页面内已有的乐观更新和 invalidation 路径**零回归**。
- **不**新增 `/api/inbox/pending-count` 合并端点：避免引入"前后端两个真实数字源"的一致性问题。

### 4.2 Drawer 列表

drawer 里同样发两个 list 查询：`/api/reviews?status=pending&limit=20` 与 `/api/clarify?status=awaiting&limit=20`（**复用现有 list 端点**，确认它们支持这些 query；若不支持就只发 `limit=20` 然后前端筛 → 见 §测试 e2e 锁住）。

显示策略：
- segmented "全部 N"：merge 两个数组按 `updatedAt` desc，截 20 项；
- "评审 N1"：仅 reviews；
- "反问 N2"：仅 clarify；
- 项点击 → `router.navigate({ to: '/reviews/$id' | '/clarify/$id' })`，drawer **不自动关闭**（让用户能对照清单）。

### 4.3 关闭 / 焦点

- `Esc` 关闭（document-level keydown listener）；
- 点 drawer 外部关闭（click-outside via `pointerdown` capture）；
- 关闭按钮（drawer 头部）；
- drawer 打开时**不抢主内容焦点**；初始焦点落到第一个 segmented 按钮（无障碍）。

## 5. Runtime chip 行为

```ts
const probe = useQuery<RuntimeProbe>({
  queryKey: ['runtime', 'opencode'],
  queryFn: ({ signal }) => api.get('/api/runtime/opencode', undefined, signal),
  enabled: token !== null,
  refetchInterval: 60_000,
  staleTime: 30_000,
})
```

颜色映射：

| probe 结果                          | dot 颜色 | tooltip |
| ----------------------------------- | -------- | ------- |
| `compatible === true`               | 绿       | `opencode v{version} · ready` |
| `compatible === false && version`   | 灰       | `opencode v{version} · 需 ≥ v{minVersion}` |
| `binary === null`（未探测到二进制） | 红       | `未找到 opencode 二进制` |
| query error / loading               | 黄       | `检查中…` |

点击 → `navigate({ to: '/settings', hash: 'runtime' })`。

## 6. 路由与认证保留

- `RootComponent` 的 `beforeLoad` auth gate / `useAuthToken` / `app-shell--bare` 分支**字面保留**，仅替换登录后的 shell 主体。
- `/auth` 页继续走 `app-shell--bare`，不渲染顶栏。
- 旧浏览器书签 `/skills`, `/reviews/abc` 等照常工作（路由表完全不动）。

## 7. i18n key 变更

新增（zh-CN / en-US 同步）：

```ts
nav: {
  // 现有字段全保留
  group: {
    agents:    '代理'    / 'Agents',
    workflows: '工作流'  / 'Workflows',
    tasks:     '任务'    / 'Tasks',
  },
  settingsGear: {
    label:   '设置'        / 'Settings',
    tooltip: '打开设置页面' / 'Open settings',
  },
  inbox: {
    label:     '收件箱'  / 'Inbox',
    tabAll:    '全部'    / 'All',
    tabReviews:'评审'    / 'Reviews',
    tabClarify:'反问'    / 'Clarify',
    empty:     '当前没有待处理事项' / 'Nothing waiting for you',
  },
  runtime: {
    statusReady:        'opencode v{{version}} · ready'                / 同英文,
    statusIncompatible: 'opencode v{{version}} · 需 ≥ v{{minVersion}}' / 'opencode v{{version}} · need ≥ v{{minVersion}}',
    statusMissing:      '未找到 opencode 二进制' / 'opencode binary not found',
    statusChecking:     '检查中…' / 'checking…',
  },
}
```

**`Resources` 接口必须同步更新**（编译期类型检查，避免漏翻）。

## 8. 失败模式

| 场景 | 行为 |
| ---- | ---- |
| `/api/runtime/opencode` 401 / 网络挂 | runtime chip 黄色；tooltip `检查中…`；点击仍跳 /settings |
| `/api/reviews/pending-count` 挂 | inbox chip 用 clarify count 作为兜底；drawer 评审 tab 显示 "加载失败 [重试]" |
| 两个 pending-count 都挂 | inbox chip 不显示 badge（保留 chip 本体）；drawer 内显示统一 empty/error 状态 |
| pathname 不在 PRIMARY_NAV 任何条目里（例如 `/auth` 已被 bare shell 接管，不会走到这里） | `resolveActiveNav` 返回 `{primary:null, secondaryTo:null}`，所有 tab 都不高亮（防御性，理论不触发） |
| i18n 切换中 `t('nav.group.agents')` 暂时回退到 key 字符串 | 与现有 LanguageSwitch optimistic update 行为一致；不专门处理 |

## 9. 与已落地 RFC 的兼容性

- **RFC-005（reviews）/ RFC-023（clarify）**：badge 仍由这俩 RFC 的 pending-count 端点驱动，只是 UI 位置从两个独立侧栏条目合并到顶栏 chip + drawer。reviews 详情页 / clarify 详情页内部不变。
- **RFC-025（language switch）**：`LanguageSwitch` 组件**实例**从 `.sidebar__footer` 搬到 `.topbar__right`；组件内部逻辑零改。
- **RFC-001（runtime probe）**：runtime chip 直接调 `/api/runtime/opencode`，与 Settings → Runtime 卡片共用同一 query key？**不共用**——chip 的 query key `['runtime','opencode']` 与 Settings 内卡片的 key 若一致会触发联动 refetch，反而带来 over-fetch。chip 用独立 key `['runtime','opencode','topbar']`，并提高 staleTime 到 30s，刻意保持独立。Settings 卡片**不**改 key。

## 10. 测试策略

按 CLAUDE.md "Test-with-every-change"：每次 commit 必带覆盖该 commit 改动的测试。

### 10.1 纯函数（Vitest，最小成本）

新文件 `packages/frontend/src/lib/nav.test.ts`：

- `resolveActiveNav('/agents')` → `{primary:'agents', secondaryTo:'/agents', onSettings:false}`
- `resolveActiveNav('/agents/abc')` → 同上（前缀匹配）
- `resolveActiveNav('/skills')` / `/mcps` / `/plugins` → `primary='agents'`，secondary 对应，`onSettings:false`
- `resolveActiveNav('/workflows/edit/x')` → `primary='workflows'`, `onSettings:false`
- `resolveActiveNav('/tasks/y')` → `primary='tasks'`, `onSettings:false`
- `resolveActiveNav('/repos')` → `primary='tasks'`, `onSettings:false`
- `resolveActiveNav('/reviews/abc')` → `{primary:'workflows', secondaryTo:null, onSettings:false}`
- `resolveActiveNav('/clarify/xyz')` → `{primary:'workflows', secondaryTo:null, onSettings:false}`
- `resolveActiveNav('/settings')` → `{primary:null, secondaryTo:null, onSettings:true}`
- `resolveActiveNav('/settings/anything')` → 同上（前缀匹配）
- `resolveActiveNav('/random-unknown')` → `{primary:null, secondaryTo:null, onSettings:false}`

### 10.2 组件单测（Vitest + RTL）

`packages/frontend/tests/inbox-chip.test.tsx`：

- 两个 pending-count 都返回 3 → chip badge 显示 `6`
- reviews=0, clarify=0 → chip 不渲染 `.chip__badge`
- pending-count 报错 → chip 仍渲染但无 badge，不抛
- count > 99 → 显示 `99+`（与现有 sidebar badge 文案一致）

`packages/frontend/tests/runtime-chip.test.tsx`：

- `compatible:true, version:'0.13.2'` → 绿点 + ready tooltip
- `compatible:false, version:'0.10.0', minVersion:'0.12.0'` → 灰点 + incompatible tooltip
- `binary:null` → 红点 + missing tooltip

`packages/frontend/tests/settings-gear.test.tsx`：

- 默认渲染齿轮 SVG + aria-label 走 `nav.settingsGear.label` i18n
- `onSettings:true` → 按钮有 `aria-current="page"` + `--active` 类
- 点击触发 router navigate 到 `/settings`

`packages/frontend/tests/inbox-drawer.test.tsx`：

- 默认关闭；点 chip 后渲染 drawer
- ESC 关闭；点外部关闭；点项不关闭
- 三 segmented 切换正确过滤 reviews / clarify

### 10.3 源代码层断言（兜底）

`packages/frontend/tests/shell-no-sidebar.test.ts`：

- 断言 `__root.tsx` 不再含 `'sidebar__link'` 字符串（防止回滚遗留）
- 断言 `styles.css` 不再含 `.sidebar__nav` 类（一次性切换守卫）
- 断言 `__root.tsx` 引用了 `TopBar` / `SubNav`

### 10.4 Playwright e2e

`packages/frontend/tests-e2e/nav-redesign.spec.ts`：

1. happy path：登录后默认进 /agents → 顶栏 "代理" 一级高亮 → 子导航看到 5 个条目 → 点 "技能" → URL 变 `/skills` 且子导航 "技能" 高亮、一级 "代理" 仍高亮。
2. inbox：mock 两端点 count=2/3 → chip 显示 "5" → 点 chip → drawer 显示 5 项 → 点评审 segmented → 列表过滤为 2 项 → 点列表项 → URL 跳 `/reviews/xxx`，drawer 仍开。
3. runtime：mock `/api/runtime/opencode` 返回 incompatible → chip 灰点 → 点击 → URL 跳 `/settings#runtime` 且 Runtime 卡片背景闪一次；此时三个一级 tab 全 inactive、齿轮按钮 active、子导航条不渲染。
4. settings gear：从 `/agents` 点右上齿轮 → URL 跳 `/settings`、齿轮按钮加 active 描边、子导航条整行消失（DOM 不存在 `.subnav`）；点 "代理" 一级 tab 切回 → 齿轮 inactive、子导航条恢复。
5. auth gate：未登录访问 `/agents` → 跳 `/auth`，无顶栏。

### 10.5 回归命名

测试文件 / describe 标题里写明锁的是哪类回归（CLAUDE.md "回归防护命名"），例如：

```ts
describe('RFC-032 resolveActiveNav — locks primary-tab assignment for /reviews and /clarify (RFC-005/RFC-023 badge merge)', ...)
```

### 10.6 运行门槛

`bun run typecheck && bun run test && bun run format:check` 全绿才能 push。GitHub Actions 同跑此三项 + Playwright e2e。按 `feedback_post_commit_ci_check` push 后立刻查 CI。

## 11. 实现顺序与回滚

按 §plan.md 分 3 个 PR（外壳 → 收件箱 → 抛光）。每个 PR 自成可回退单元：

- PR1 落地后即便不接 PR2，应用仍可用（inbox 入口在 PR1 暂时回退到原来的 `/reviews` `/clarify` 两个子导航项作为 placeholder）；
- PR2 把 placeholder 换成 chip + drawer；
- PR3 做主题 / 键盘 / 极窄屏 fallback polish。

如果任一 PR 回归严重，可单独 revert 而不破坏其他 PR 已落地的能力。
