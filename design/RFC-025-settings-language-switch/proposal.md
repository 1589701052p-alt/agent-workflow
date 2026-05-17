# RFC-025 框架语言切换：设置页配置 + 侧边栏快速切换

> 状态：Draft
> 关联：`packages/shared/src/schemas/config.ts:74`（`language` 字段已存在）；`packages/frontend/src/i18n/index.ts`（i18next + LanguageDetector bootstrap）；`packages/frontend/src/routes/settings.tsx:421`（AppearanceTab）；`packages/frontend/src/hooks/useTheme.ts`（theme 同款模式，本 RFC 平行复制）；`packages/frontend/src/routes/__root.tsx:64-84`（左侧 sidebar）。

## 背景

当前前端 i18n 基础设施已经搭好：

- shared `ConfigSchema.language: LanguageSchema`（`zh-CN` | `en-US`），默认 `zh-CN`；`PUT /api/config` 已能持久化。
- 前端 `i18n/index.ts` 用 i18next + `i18next-browser-languagedetector`：优先 `localStorage.aw-language` → 浏览器 `navigator.language` → fallback `zh-CN`；导出了 `setLanguage()`。

但没有任何 UI 入口调用 `setLanguage()` 或读 `config.language`：

- 设置页 AppearanceTab 只有 theme 下拉，没有 language 字段。
- 顶栏 / 侧边栏没有快速切换按钮。
- i18n 启动时**只看 localStorage / navigator**，从不读后端 `config.language`——意味着：用户在设备 A 设过的语言，在同一台机器同浏览器内可记住，但**跨设备 / 跨浏览器换上来后该用户的偏好就丢了**；同时后端 DB 里那一栏成了死配置，永远不生效。

用户需求明确两点：

1. 设置里能配置当前框架的语言。
2. 侧边栏一个快速切换按钮，不进设置页就能切。

另外，**优先级用户已拍板**：后端 `config.language` 为权威，localStorage 仅作首屏热启动缓存以避免闪烁。

## 目标

- **设置页**：`AppearanceTab` 在 theme 下拉旁加一栏 `Language` 下拉（zh-CN / en-US），保存逻辑沿用既有 `useTabState({theme, language})` + `PUT /api/config`；保存成功后立即调 `setLanguage(lang)` 让界面热切，不需要刷新页面。
- **侧边栏快速切换**：`__root.tsx` 左侧 sidebar 底部新增 `LanguageSwitch` 组件（小型 segmented control 或 icon 触发的 popover，二选一在 design.md 拍板，**默认 segmented**），点击同时做两件事：① `PUT /api/config { language }` ② 立刻 `setLanguage()` 让 React 树热切。失败回滚到原值并显示一行红字（沿用 `describeApiError`）。
- **i18n bootstrap 改造**：新 `useApplyLanguage()` hook（与 `useApplyTheme` 平行结构）在 `App` 顶层挂载；订阅 `useQuery(['config'])`，当 `config.language` 与 `i18next.language` 不一致时调 `setLanguage`。localStorage 保留——作为冷启动**首屏热缓存**，避免"config 还没回来"的一闪 zh-CN 默认值；config 一回来即覆盖（即"后端权威"）。同时 `setLanguage` 内部继续靠 i18next 的 `caches: ['localStorage']` 把最终值写回，下次冷启动首屏就能命中正确语言。
- **未登录路由**（`/auth`）：没有 token，无法拉 `/api/config`，沿用 localStorage / navigator detector 即可，不会触发后端同步。

## 非目标

- **不新增第三种语言**：v1 仅 zh-CN / en-US 切换，`LanguageSchema` 不动；后续若加日语 / 韩语，单独再开 RFC 走全量翻译流程。
- **不做"按用户"多账户偏好**：本框架是单用户单机，`Config` 表一行就是这台机器的偏好。
- **不做翻译质量审计**：现存中英两份 `i18n/{zh-CN,en-US}.ts` 在前几个 RFC 中已经一路双写，本 RFC 完全不动现有 key 文本；只新增 4 条新 key（settings 标签 + 标签提示 + 两个选项名）。
- **不做侧边栏样式大重构**：仅在 sidebar 末尾追加一个组件区，不动 `.sidebar__brand` / `.sidebar__nav` / `.sidebar__link*` 等既有 class。
- **不暴露浏览器 detector 优先级开关**：detector 仍只在"未登录 / cold-start config 未到"两个窗口期起作用，不给用户可配置。
- **不做后端 cookie / header 协商**：所有 API response body 仍是英文 / 机器码，i18n 完全在前端。

## 用户故事

1. 用户首次打开 app（浏览器中文 / `localStorage.aw-language` 为空）→ i18next detector 选 `zh-CN`（也是 fallback），界面 zh-CN；登录后 `useApplyLanguage` 拉到 `config.language='zh-CN'`，与当前一致 → no-op。
2. 用户在设置页 → Appearance tab → Language 下拉切到 `en-US` → 点 Save → `PUT /api/config { theme, language: 'en-US' }` 成功 → AppearanceTab 的 onSave 回调里 `setLanguage('en-US')` → 整个 React 树 i18next 实时切英文，无刷新。
3. 用户在工作流编辑器顶部（实际是左侧边栏底部）看到 `[中] [EN]` segmented，点 EN → 同上但不需要进设置页；segmented 灰底高亮项立刻变 EN，整个 UI 热切；同时后端被 PUT 持久化。失败：segmented 回滚到原值，按钮下方出现一行红字 `t('errors.fallback') + ': ' + err.message`。
4. 用户在设备 A 切到 en-US 后，去设备 B（同账户 / 同 SQLite 数据库一台机器多浏览器）打开 → 首屏可能短暂闪 zh-CN（localStorage 未命中），随后 `useApplyLanguage` 拿到 `config.language='en-US'` 立刻 setLanguage('en-US')；闪烁 < 300ms（与 theme 的 light/dark 闪烁同量级，可接受）。
5. 用户冷启动场景：上次正常使用过，`localStorage.aw-language='en-US'`，首屏 detector 直接拿 en-US 不闪；config 回来确认一致 → 无变化。
6. 用户未登录 `/auth` 页：`useApplyLanguage` 跳过（`enabled: token !== null`），detector 决定首屏，登陆后再同步。

## 验收标准

- `AppearanceTab` 渲染时包含一个 `<select>` for language，options 为 `zh-CN`、`en-US`；label / hint 走 i18n（`settings.languageLabel` / `settings.languageHint`）；save 成功后立即 `setLanguage(state.language)`，500ms 内 `document.documentElement.lang` attribute 与 `i18next.language` 同步到新值。
- `Sidebar` 末尾出现 `LanguageSwitch` 组件（默认 segmented 二选一），role=`group`、option role=`radio` aria-checked=current，键盘 ←/→ 切焦 + Enter / Space 选中；点击触发 PUT + `setLanguage` 双动作；PUT 失败回滚 segmented 显示态并显示 `describeApiError(err)` 在组件下方 muted 红字。
- `useApplyLanguage` hook：`token === null` 时禁用（不发请求）；`config.language` 与 `i18next.language` 不等时调 `setLanguage`；同一值不触发重复调用（ref equality 短路或 deps 比较）。
- i18n bootstrap：localStorage detector 保留作为冷启动首屏来源；i18next.changeLanguage 仍走 `caches: ['localStorage']` 写回；不删除既有 `SUPPORTED_LANGUAGES` / `LANG_STORAGE_KEY` 常量。
- 失败模式：
  - PUT 4xx / 5xx → segmented + AppearanceTab 都不切（save state revert），错误条出现，i18next 不动。
  - `config.language` 是合法但 `i18next.languages[0]` 不在 `SUPPORTED_LANGUAGES`（外部脏数据）→ fallback 到 zh-CN，不抛异常。
- `document.documentElement.lang` 与 i18next 当前语言同步（accessibility / 搜索引擎）：在 `useApplyLanguage` 副作用里 `document.documentElement.lang = current`。
- 中英 i18n 各 +6 key（4 条新 settings 标签 + 2 条 sidebar segmented label "中" / "EN"）；其余 key 文本零改动；`en-US.ts` 与 `zh-CN.ts` key 集合完全对称（既有源代码层兜底测试一并 lock）。
- 既有 settings page / settings AppearanceTab 单测全绿；新加 5+ case 单测覆盖 LanguageSwitch / useApplyLanguage / AppearanceTab 含 language 三块。

## 与现有模块的关系

- **shared**：零改动，`LanguageSchema` / `Config.language` / `DEFAULT_CONFIG.language` 已就绪。
- **backend**：零改动，`PUT /api/config` 既有路径接受 `ConfigPatchSchema.language`。
- **i18n/index.ts**：保留所有现状（detector / changeLanguage / describeApiError），仅 export 增加（无既有 API 破坏）。本文件**不调** `/api/config`，避免循环依赖（i18n bootstrap 早于 React tree）。
- **routes/settings.tsx `AppearanceTab`**：`useTabState(config, ['theme'])` → `['theme', 'language']`；form 加一栏 Field；onSave 回调成功路径调 `setLanguage(state.language)`。
- **routes/\_\_root.tsx**：sidebar 末尾追加 `<LanguageSwitch />`（不进 `NAV` 数组、不复用 `Link`，单独组件）；不影响登录路由分支（`pathname === '/auth'` 仍走 bare layout 不渲 sidebar）。
- **hooks/useTheme.ts**：作为 `useApplyLanguage` 实现模板拷贝（同款 `useQuery(['config'])` + `enabled: token !== null` + 副作用 effect），共享同一个 query key 自动 dedupe，不重复 fetch。
- **api/client.ts**：零改动，沿用 `api.put<Config>('/api/config', { language })` 形态。

## 失败模式回顾

| 场景 | 处理 |
|------|------|
| 首屏 localStorage 命中 zh-CN，config 回来是 en-US | useApplyLanguage 切到 en-US，约 100-300ms 闪烁，detector 在下次冷启动会因 `caches: ['localStorage']` 已被 setLanguage 写回而首屏直接 en-US |
| 首屏 localStorage 是非法值（用户手改）| i18next supportedLngs 自动 fallback zh-CN，config 回来再正 |
| PUT /api/config 失败 | segmented / Save 按钮恢复原值，错误条出现，不调 setLanguage，i18next 不变 |
| `useApplyLanguage` 在 config invalidate / refetch 期间 stale 数据 | TanStack Query staleTime 60s（与 useTheme 同），不会高频抖动 |
| 同时打开两个标签页改语言 | TanStack Query 不跨标签页同步，A 标签改完只 PUT 后端持久化，B 标签需要刷新或下一次 query refetch 才看到；可接受，不阻塞 v1 |
| 一种语言下出现 missing key | i18next `fallbackLng: 'zh-CN'` 兜底；新加 key 双语必须同时落，CI lint key 对称兜底 |
| `document.documentElement.lang` 在 SSR / 测试 jsdom 无 document | useApplyLanguage 副作用先 `typeof document === 'undefined'` 短路 |

## 多人协作

- 不与 RFC-023（Clarify runtime PR-B 已落）/ RFC-024（Launch from Git URL，Draft）共享文件：本 RFC 触碰的 `settings.tsx` / `__root.tsx` / `useTheme.ts` 旁边新建 `useLanguage.ts` / `LanguageSwitch.tsx`，与上述 in-flight 改动零交集。
- i18n 文件 `zh-CN.ts` / `en-US.ts` 是高频共享文件（每个新 UI RFC 都加 key），并发改动只追加 key 块，commit 时按行精确 `git add`，遵循 CLAUDE.md "Multi-person collaboration" 原则——只加自己 6 条新 key，不动他人正在加的 key 行。
- 不动 `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` / DB schema / migration，避开主要并发热区。
