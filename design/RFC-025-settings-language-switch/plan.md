# RFC-025 实施计划

> 配套 `proposal.md` + `design.md`。每条子任务一旦完成立即勾掉，并在 PR / commit message 引用 `RFC-025-Tn`。**单 PR 合**，文件交集小且与 in-flight RFC-023 / RFC-024 零冲突。

## 子任务

### RFC-025-T1 — `useApplyLanguage` hook + 单元

- 新文件 `packages/frontend/src/hooks/useLanguage.ts`：
  - `isSupportedLanguage(x): x is SupportedLanguage` 纯函数
  - `useApplyLanguage(): void` hook（结构镜像 `useTheme.ts useApplyTheme`：useQuery `['config']` + `enabled: token!==null` + `staleTime: 60_000` + effect 比较 `i18n.language` 与 `config.language` + 同步 `document.documentElement.lang`）
- 测试 `tests/use-apply-language.test.ts` 6 case：
  - token=null 不发请求（mock fetch 计数）
  - config.language=zh-CN 且 i18n=zh-CN → no setLanguage 调用
  - config.language=en-US 且 i18n=zh-CN → 触发 setLanguage('en-US') 一次
  - config.language='ja-JP'（非法）→ 不调 setLanguage
  - `document.documentElement.lang` 切到 target
  - target 不变重渲 → useEffect deps short-circuit 不重复调 setLanguage
- 依赖：—
- 大小：S

### RFC-025-T2 — `LanguageSwitch` 组件 + 单元

- 新文件 `packages/frontend/src/components/LanguageSwitch.tsx`：
  - role=group + 两 button role=radio + aria-checked + className `language-switch{,__option,__option--active,__error}`
  - useMutation：onMutate optimistic setLanguage / onSuccess qc.setQueryData / onError 回滚 setLanguage
  - mutation.isPending 期间 disabled
  - mutation.error 渲染 `describeApiError(err)` 在底部 muted 红字
  - 当 lang === current 点击 no-op
- 测试 `tests/language-switch.test.tsx` 8 case（design.md §5.1 列出的 a-h）
- 依赖：T1（共享 isSupportedLanguage 与 SUPPORTED_LANGUAGES 导入）
- 大小：M

### RFC-025-T3 — `AppearanceTab` 加 language 下拉 + 单元

- `packages/frontend/src/routes/settings.tsx:421-444`：
  - `useTabState(config, ['theme'])` → `['theme', 'language']`
  - 新 `<Field><select/></Field>` 块（design.md §3.3 diff）
  - save success → useEffect 调 setLanguage
- 测试 `tests/settings-appearance-language.test.tsx` 5 case（design.md §5.1 列出的 a-e）
- 依赖：T1（导入 SupportedLanguage 类型 + setLanguage）
- 大小：S

### RFC-025-T4 — `__root.tsx` 接入 hook + 组件

- `packages/frontend/src/routes/__root.tsx`：
  - import `useApplyLanguage` + `LanguageSwitch`
  - 在 `RootLayout` 函数顶部调 `useApplyLanguage()`（与 `useTranslation()` 同位置）
  - sidebar 内 `<nav>` 之后追加 `<div className="sidebar__footer"><LanguageSwitch /></div>`
- 测试源代码层兜底（在 `tests/i18n-keys-symmetry.test.ts` 同文件加一段或新建 `tests/root-language-wiring.test.ts`）2 case：
  - `__root.tsx` 文本包含 `useApplyLanguage(` 调用
  - `__root.tsx` 文本包含 `<LanguageSwitch`
- 依赖：T1, T2
- 大小：XS

### RFC-025-T5 — i18n key 补齐 + 对称性测试

- `packages/frontend/src/i18n/zh-CN.ts`：追加 `settings.languageLabel/Hint/ZhCN/EnUS` + `sidebar.languageGroupLabel/lang.{zh,en}` 共 6 key
- `packages/frontend/src/i18n/en-US.ts`：追加同 6 key
- 测试 `tests/i18n-keys-symmetry.test.ts` 3 case：
  - 收集 zh-CN / en-US 全部 key（递归扁平）→ Set 相等
  - `settings.languageLabel` 等 4 key 在两份里都存在
  - `sidebar.lang.zh` / `sidebar.lang.en` 在两份里都存在
- 依赖：—（可与 T1-T4 任一并行）
- 大小：XS

### RFC-025-T6 — styles.css

- `packages/frontend/src/styles.css` 追加：
  - `.sidebar__footer { margin-top: auto; padding: 12px; }`
  - `.language-switch` 容器 flex row gap
  - `.language-switch__option` 中性按钮态
  - `.language-switch__option--active` accent 背景 + 前景色
  - `.language-switch__error` muted 红字 font-size: 12px
- 依赖：T2, T4
- 大小：XS

### RFC-025-T7 — STATE.md / plan.md 索引同步

- `design/plan.md` RFC 索引表追加 RFC-025 行（Status: In Progress / 进入 PR 后改 Done）
- `STATE.md` 顶部"进行中 RFC"加 RFC-025（实施完工后改 Done 并迁入"最近完成 RFC"区段，按既有格式写一行包含 commit hash + CI run + 改动文件数 + 测试增量）
- 依赖：—（与 T1 同 commit 即可）
- 大小：XS

### RFC-025-T8（可选） — e2e

- `e2e/main.spec.ts` 加一条 `RFC-025: language switch from sidebar persists across reload`：
  - 登录 → 点 sidebar EN → 断言 `nav.brand` 文案变化（中文 → 英文）
  - 断言 `localStorage.getItem('aw-language') === 'en-US'`
  - reload → 仍是英文 + sidebar EN 高亮
- 单元已覆盖核心断点，e2e 仅做端到端 smoke；超时风险高时跳过
- 依赖：T1-T6
- 大小：S

## PR 拆分建议

默认**单 PR**（T1-T7 + 可选 T8），命名 `feat(frontend): RFC-025 settings + sidebar language switch with config-as-authority`。

无需拆，因为：

- 改动只在 frontend，且都是新文件 / 既有文件的局部追加，与 in-flight RFC-023（runtime PR-C / PR-D）/ RFC-024（draft 阶段）零交集
- 文件总改动量 ~300 LOC（含测试），review 友好
- 测试增量约 22 case，CI 单跑

## 验收清单

- [ ] frontend/`bun test` 全绿（T1-T5 + 既有），新增 ~22 case
- [ ] `bun run typecheck && bun run format:check && bun run lint` 三连绿
- [ ] e2e Playwright 全绿（如做 T8）
- [ ] CI run（`gh run list -L 1`）通过后再标 Done
- [ ] 浏览器人工抽样：
  - 设置页 Appearance tab 切 en-US + Save → 整个 UI 热切，无刷新
  - 侧边栏点 EN → 整个 UI 热切，DevTools 看到 PUT /api/config 成功
  - 模拟 PUT 失败（DevTools network throttle / mock 4xx）→ 错误条出现 + segmented 回滚
  - reload 后语言保持
  - 清空 localStorage + reload → 短暂闪 zh-CN 后切到 config.language（人眼可见 < 300ms）
- [ ] STATE.md 顶部 "进行中 RFC" 标记移除、"最近完成 RFC" 表新增 RFC-025 行
- [ ] design/plan.md RFC 索引表 RFC-025 行改 Status=Done

## 工时估算回顾（与 proposal §工作量一致）

| 任务 | 估时 |
|---|---|
| T1 hook + 单元 | 60 min |
| T2 LanguageSwitch + 单元 | 90 min |
| T3 AppearanceTab + 单元 | 45 min |
| T4 __root.tsx 接入 | 15 min |
| T5 i18n key + 对称性测试 | 20 min |
| T6 styles.css | 15 min |
| T7 STATE.md / plan.md | 15 min |
| T8 e2e（可选）| 30 min |
| **合计** | **约 4-5 小时**（单 PR） |
