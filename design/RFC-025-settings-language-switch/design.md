# RFC-025 技术设计

## 1. 全局数据流

```
                   ┌────────────────────────────────────────────────┐
                   │ User input                                     │
                   │  (a) AppearanceTab Save                        │
                   │  (b) Sidebar LanguageSwitch click              │
                   └───────────────┬────────────────────────────────┘
                                   │  ① PUT /api/config { language }
                                   │  ② setLanguage(lang)              (i18next.changeLanguage)
                                   ▼
            ┌─────────────────────────────────────────────────────┐
            │ i18next runtime                                     │
            │   - changeLanguage triggers React re-render         │
            │   - caches:['localStorage']                         │
            │     → writes aw-language=lang for next cold start   │
            └─────────────────────────────────────────────────────┘
                                   │
                                   │ TanStack Query invalidates ['config']
                                   ▼
            ┌─────────────────────────────────────────────────────┐
            │ useApplyLanguage()  (mounted in App / __root)       │
            │   - subscribes useQuery(['config'])                 │
            │   - if config.language !== i18next.language         │
            │       → setLanguage(config.language)                │
            │   - sets <html lang=…> attribute                    │
            └─────────────────────────────────────────────────────┘
```

冷启动顺序：

1. `index.html` 加载 → `main.tsx` → import `./i18n` 自启动 i18next（**同步**）→ detector 看 localStorage / navigator → 选首屏语言 → React tree mount。
2. `__root.tsx` 渲染 `useApplyTheme()` 与新加的 `useApplyLanguage()` → 触发 `useQuery(['config'])`（与 settings page / useTheme 共享，命中即去重）。
3. config 回来后，hook 比较 `config.language` 与 `i18next.language`，不等就 `setLanguage`。

## 2. 文件改动 / 新增清单

| 文件 | 改动 | LOC 估 |
|---|---|---|
| `packages/frontend/src/hooks/useLanguage.ts` | **新增** — `useApplyLanguage()` hook，结构镜像 `useTheme.ts` | ~50 |
| `packages/frontend/src/components/LanguageSwitch.tsx` | **新增** — 侧边栏 segmented，PUT + setLanguage 双动作 + 错误显示 | ~80 |
| `packages/frontend/src/routes/__root.tsx` | + `useApplyLanguage()` 调用；sidebar 末尾加 `<LanguageSwitch />` | +6 |
| `packages/frontend/src/routes/settings.tsx` | `AppearanceTab`：useTabState 加 `'language'` key；新增一个 `<Field><select/></Field>`；save 成功调 `setLanguage(state.language)` | +20 |
| `packages/frontend/src/i18n/index.ts` | 零改动（保留 setLanguage / detector / cache 配置） | 0 |
| `packages/frontend/src/i18n/zh-CN.ts` | + 6 keys（4 settings + 2 sidebar） | +6 |
| `packages/frontend/src/i18n/en-US.ts` | + 6 keys 同上 | +6 |
| `packages/frontend/src/styles.css` | + `.language-switch` 一套（容器 / option / option--active / 错误条） | ~40 |
| `packages/frontend/tests/use-apply-language.test.ts` | **新增** | ~80 |
| `packages/frontend/tests/language-switch.test.tsx` | **新增** | ~120 |
| `packages/frontend/tests/settings-appearance-language.test.tsx` | **新增** | ~80 |
| `packages/frontend/tests/i18n-keys-symmetry.test.ts` | **新增**（兜底 zh/en key set 完全相等 + 新 6 key 存在） | ~40 |

无 shared / backend / scheduler / runner / runtime / DB / migration 改动。

## 3. 接口契约

### 3.1 `useLanguage.ts`

```ts
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import i18n from '@/i18n'
import { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { api } from '@/api/client'
import type { Config } from '@agent-workflow/shared'
import { getToken, subscribeAuth } from '@/stores/auth'
import { useSyncExternalStore } from 'react'

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

export function isSupportedLanguage(x: unknown): x is SupportedLanguage {
  return typeof x === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(x)
}

/** Apply config.language to i18next + <html lang> as a side effect. */
export function useApplyLanguage(): void {
  const token = useAuthToken()
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    enabled: token !== null,
    staleTime: 60_000,
  })

  const target: SupportedLanguage | null = isSupportedLanguage(config.data?.language)
    ? (config.data!.language as SupportedLanguage)
    : null

  useEffect(() => {
    if (target === null) return
    if (i18n.language !== target) setLanguage(target)
    if (typeof document !== 'undefined') document.documentElement.lang = target
  }, [target])
}
```

测试可断面：

- `isSupportedLanguage` 纯函数，5 case（zh-CN / en-US / null / undefined / 'ja-JP'）。
- hook 行为通过 jsdom `renderHook` + mock `useQuery` + 断言 `i18n.language` 变化 + `document.documentElement.lang` 变化。

### 3.2 `LanguageSwitch.tsx`

```ts
type Props = { className?: string }
export function LanguageSwitch({ className }: Props): JSX.Element {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const config = useQuery<Config>({ queryKey: ['config'], queryFn: …, enabled: token !== null, staleTime: 60_000 })
  const current: SupportedLanguage = isSupportedLanguage(config.data?.language)
    ? (config.data!.language as SupportedLanguage)
    : (isSupportedLanguage(i18n.language) ? i18n.language : 'zh-CN')

  const mutation = useMutation({
    mutationFn: (lang: SupportedLanguage) =>
      api.put<Config>('/api/config', { ...config.data, language: lang }),
    onMutate: (lang) => setLanguage(lang),               // optimistic UI flip
    onSuccess: (next) => qc.setQueryData(['config'], next),
    onError: (_e, _lang, _ctx) => setLanguage(current),  // rollback
  })

  return (
    <div role="group" className={`language-switch ${className ?? ''}`} aria-label={t('sidebar.languageGroupLabel')}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          role="radio"
          aria-checked={lang === current}
          className={`language-switch__option ${lang === current ? 'language-switch__option--active' : ''}`}
          disabled={mutation.isPending}
          onClick={() => { if (lang !== current) mutation.mutate(lang) }}
        >
          {t(`sidebar.lang.${lang === 'zh-CN' ? 'zh' : 'en'}`)}
        </button>
      ))}
      {mutation.error && (
        <div className="language-switch__error">{describeApiError(mutation.error)}</div>
      )}
    </div>
  )
}
```

关键点：

- **乐观更新**：onMutate 立即 setLanguage 让 UI 即刻切；失败 onError 回滚。这样视觉响应不依赖网络往返。
- 当 config 还没回来（`config.data === undefined`），`current` 从 i18n.language 取作 fallback，避免 segmented 出现"空选中"状态。
- `PUT` body 用 `{ ...config.data, language: lang }` 保留其他字段（ConfigPatchSchema 是 partial，但传全量更安全且与 settings 页保存一致）。
- 不复用 `Link` / `NAV` 数组，组件独立。

### 3.3 `AppearanceTab` 改动

`settings.tsx:421-444` 区域：

```diff
-  const { state, setState, save } = useTabState(config, ['theme'])
+  const { state, setState, save } = useTabState(config, ['theme', 'language'])
+
+  // After successful save, sync i18next.
+  React.useEffect(() => {
+    if (save.isSuccess && state.language) setLanguage(state.language as SupportedLanguage)
+  }, [save.isSuccess, state.language])

   return (
     <SectionForm onSave={save.mutate} …>
       <Field label={t('settings.themeLabel')} hint={t('settings.themeHint')}>
         <select … />
       </Field>
+      <Field label={t('settings.languageLabel')} hint={t('settings.languageHint')}>
+        <select
+          className="form-input"
+          value={state.language ?? 'zh-CN'}
+          onChange={(e) => setState({ ...state, language: e.target.value as SupportedLanguage })}
+        >
+          <option value="zh-CN">{t('settings.languageZhCN')}</option>
+          <option value="en-US">{t('settings.languageEnUS')}</option>
+        </select>
+      </Field>
     </SectionForm>
   )
```

可替代方案：把 `setLanguage` 调用塞进 `save.mutate` 的 `onSuccess` 回调（如果 `useTabState` 暴露 mutation hooks）。useEffect 路径更稳，与既有 hook 形态不冲突。

### 3.4 `__root.tsx` 改动

```diff
+import { useApplyLanguage } from '@/hooks/useLanguage'
+import { LanguageSwitch } from '@/components/LanguageSwitch'
   …
   function RootLayout() {
     const { t } = useTranslation()
+    useApplyLanguage()
     …
     return (
       <div className="app-shell">
         <aside className="sidebar">
           <div className="sidebar__brand">{t('nav.brand')}</div>
           <nav className="sidebar__nav">…</nav>
+          <div className="sidebar__footer">
+            <LanguageSwitch />
+          </div>
         </aside>
         <main className="content"><Outlet /></main>
       </div>
     )
   }
```

`sidebar__footer` 是新 class（`margin-top: auto; padding: 12px;`），让 `LanguageSwitch` 钉在 sidebar 底部不挤压 nav。

### 3.5 i18n key 增量

```ts
// zh-CN.ts
settings: {
  …
  languageLabel: '界面语言',
  languageHint: '切换中文 / 英文，保存即生效，无需刷新',
  languageZhCN: '简体中文',
  languageEnUS: 'English',
},
sidebar: {
  languageGroupLabel: '切换界面语言',
  lang: { zh: '中', en: 'EN' },
},
```

```ts
// en-US.ts
settings: {
  …
  languageLabel: 'UI language',
  languageHint: 'Switch between Chinese and English. Saved value applies instantly, no refresh required.',
  languageZhCN: '简体中文',
  languageEnUS: 'English',
},
sidebar: {
  languageGroupLabel: 'Switch UI language',
  lang: { zh: '中', en: 'EN' },
},
```

两份选项名（`languageZhCN` / `languageEnUS`）有意保持**双语对称**（中文文件里 `English` 不译成"英文"），方便用户认得"目标语言长这样"。

## 4. 优先级 / 数据一致性

**用户已拍板**：后端 `config.language` 为权威，localStorage 仅作冷启动首屏缓存。具体表现：

1. **冷启动首屏**（React tree mount 之前）：i18next 同步初始化用 LanguageDetector → localStorage → navigator → fallback。整套发生在 `main.tsx` import `./i18n` 时，零异步等待，避免首屏闪烁。
2. **登录后**（token 出现，useQuery 启用）：`useApplyLanguage` 拿到 config.language → 与 i18next.language 不等就 setLanguage → setLanguage 内部 `i18next.changeLanguage` 同时把新值 cache 回 localStorage（i18next `caches: ['localStorage']` 已开），下次冷启动首屏直接命中正确语言。
3. **用户主动切换**（UI 触发）：optimistic setLanguage 立即生效 → PUT 持久化 → 失败回滚。
4. **跨设备同步**：通过后端 config 的下一次同步实现，不主动推送（v1 只在 query refetch / mount 时拉）。

冲突场景与处理：

| 场景 | localStorage | config.language | i18next 现态 | 处理 |
|---|---|---|---|---|
| 全新设备首启 | 空 | zh-CN（DB 默认）| zh-CN（fallback） | 一致，no-op |
| 同设备老用户 | zh-CN | zh-CN | zh-CN | 一致，no-op |
| 跨设备登录（B 设备）| 空或 zh-CN | en-US（A 设备改的） | zh-CN（首屏）| useApplyLanguage 切到 en-US，闪烁 < 300ms |
| 用户手改 localStorage 为非法值 | 'ja' | zh-CN | zh-CN（i18next supportedLngs 自动 fallback）| no-op |
| 用户手改 config.language 为非法（绕过 API）| 任意 | 任意非法 | i18next 现态 | isSupportedLanguage 检查不通过 → 不调 setLanguage，保持现态 |

## 5. 测试策略

### 5.1 单元

| 测试文件 | case 数 | 关键断言 |
|---|---|---|
| `tests/use-apply-language.test.ts` | 6 | (a) token=null 不发请求；(b) config.language=zh-CN 且 i18n=zh-CN no-op；(c) config.language=en-US 且 i18n=zh-CN 触发 setLanguage；(d) config.language 非法不调 setLanguage；(e) document.documentElement.lang 同步；(f) 同值不重复调用 setLanguage（useEffect deps short-circuit） |
| `tests/language-switch.test.tsx` | 8 | (a) 渲染两个 option role=radio；(b) aria-checked 跟随 config.language；(c) 点击触发 mutation + optimistic setLanguage；(d) 成功 → qc.setQueryData 写入；(e) 失败 → setLanguage 回滚 + 错误条出现；(f) disabled 期间 second click no-op；(g) keyboard ←/→ 切焦 + Enter 选中（可选，若 v1 不实现 keyboard，本 case 跳过并 TODO）；(h) 当前 == clicked 时不触发 mutation |
| `tests/settings-appearance-language.test.tsx` | 5 | (a) `<select>` 渲染 + 当前值；(b) onChange 更新 state；(c) save 成功 → setLanguage 被调；(d) save 失败 → 不调 setLanguage；(e) 两个 i18n key 引用兜底（label / hint） |
| `tests/i18n-keys-symmetry.test.ts` | 3 | (a) 收集 zh-CN / en-US 全部 key（深层）→ Set 相等；(b) `settings.languageLabel` 等 4 key 存在于两份；(c) `sidebar.lang.zh` / `sidebar.lang.en` 存在 |

### 5.2 集成 / 源代码层兜底

- `tests/i18n-keys-symmetry.test.ts` 同时兜底"未来加 key 单边遗漏"。
- 源代码层 grep 一条：`__root.tsx` 必须 import `useApplyLanguage` 且调用一次；`LanguageSwitch.tsx` 必须 import `setLanguage`（防御未来重构把热切动作弄丢）。

### 5.3 e2e（可选 / 视工作量）

如果时间允许：`e2e/main.spec.ts` 加一条：登录后 → 点 sidebar EN → 断言 `nav.brand` 文案变化 + `localStorage.getItem('aw-language') === 'en-US'`。**Plan.md 把它列为可选，超时则跳过**，因为单元测试已覆盖核心断点。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| useApplyLanguage 与 useApplyTheme 同时挂载抖动 | 同 query key `['config']`，TanStack Query 自动去重；staleTime 60s 防重复 |
| i18next.changeLanguage 异步性 | `changeLanguage` 返回 Promise 但 i18next 已经在内部同步切了语言（resources 已加载），React 通过 i18next emitter 重渲；不需要 await |
| optimistic setLanguage 后 PUT 失败回滚出现两次重渲 | 视觉上是"切到 EN → 0.2s 后切回 ZH"，可接受；错误条同步出现解释；可选改成"先 PUT 后 setLanguage"以避免，但会损失即点即变手感——RFC 选乐观，按用户偏好热切快是首要 |
| localStorage 与后端长期不一致（用户 A 设备本地改后从未登录拉取过 config）| 不可能：useApplyLanguage 任何登录态都拉一次 config，命中即同步；非登录路由用户不在意 |
| i18n bootstrap 在 SSR / 测试无 window | `LanguageDetector` 已经处理；jsdom 也有 localStorage / matchMedia polyfill 在 setup 文件里 |
| 用户禁用 localStorage（cookie 模式）| i18next falls back to memory cache，每次 cold start 必走 navigator detector；登录后 useApplyLanguage 仍正确同步；可接受 |

## 7. 实现顺序建议

按 plan.md T1-T6 推：

1. T1 hook + 单元（不依赖 UI 改动）
2. T2 LanguageSwitch 组件 + 单元
3. T3 AppearanceTab 改动 + 单元
4. T4 __root.tsx 接入（hook + 组件）
5. T5 i18n key + 对称性测试
6. T6 styles.css + 视觉手测 + e2e（可选）

所有任务可在单 PR 落地，文件交集小，CI 一遍过。

## 8. 不做的事情（明确划界）

- 不引入 `i18next-http-backend`（key 仍打包进 bundle，按现状）。
- 不对接 React Suspense / lazy load 语言包。
- 不加"自动跟随浏览器语言"开关（detector 在 cold start 已经做这件事，进 settings 后即由 config 接管，无需暴露给用户）。
- 不做语言切换的 audit log / event 表行（与 theme 切换同等，纯偏好不进事件流）。
