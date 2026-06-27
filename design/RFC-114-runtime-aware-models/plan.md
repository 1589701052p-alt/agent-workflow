# RFC-114 任务分解 — 运行时感知的模型列表

依赖前置：RFC-112（运行时注册表 + `resolveRuntimeByName`）、RFC-113（运行时即 profile，RuntimeFormDialog 已有 model 编辑）均 Done。

## PR-A — 数据层缓存 Map 化 + 路由按运行时名解析二进制

| ID | 任务 | 依赖 |
|----|------|------|
| **T1** | `util/opencode-models.ts`：`cache` 单槽 → `Map<binary, OpencodeModel[]>`（D4）；命中 `cache.get(binary)`，`refresh`/未命中则真跑并 `cache.set`；`clearOpencodeModelsCache()` → `cache.clear()`。**进程收口（Codex P2-3）**：spawn 加 timeout（超时 → 进程组 kill）+ stdout/stderr 字节上限。 | — |
| **T2** | `routes/runtime.ts` GET `/api/runtime/models`：**先 `resolveRuntimeByName`、`claude`/`claude-code` 别名仅在注册表无此名时兜底（Codex P1-1）**；opencode 分支 `binary = resolved?.binaryPath ?? cfg.opencodePath ?? 'opencode'`（D1）；claude 分支静态列表 + `binary` 回填（D3）；无 `?runtime=`/未知名 → 默认（向后兼容、**无 `?runtime=` fetch 逐字不变**，Codex P2-5）。 | T1 |
| **T3** | D5 错误：`listOpencodeModels` 抛错 → 502 `{ok:false, code:'opencode-models-failed', message: redactSensitiveString(...), runtime: rtParam ?? null}`（加 `runtime` 字段 + **`util/redact.ts` 脱敏**，Codex P2-4）。 | T2 |
| **T4** | 缓存失效（Codex P3-6）：`deleteRuntime` / `updateRuntime(binaryPath 变更)` 后清对应 binary 槽（注册表既有失效点接线）。 | T1 |
| **T5** | 测试：路由传给 listOpencodeModels 的 binary（custom→binaryPath / 内置→cfg.opencodePath / 无 param→默认）；**名为 `claude` 的运行时不被别名劫持**；claude 走静态 + binary 字段；错误 502 含 runtime + 脱敏；**进程超时/输出超限被收口**；缓存多二进制隔离（单槽会红）+ refresh 覆盖 + 删/改运行时清槽；**默认 ModelSelect 无 `?runtime=` 行为逐字不变（保留既有测试）**。 | T1–T4 |

## PR-B — 前端 RuntimeFormDialog 按运行时取模型 + 错误态

| ID | 任务 | 依赖 |
|----|------|------|
| **T6** | `RuntimeFormDialog` 的 model `<ModelSelect>`：**编辑**已有运行时 → `runtime=props.existing.name`（按运行时取，D6）；**新建自定义二进制态 → 不发默认 `?runtime=` 取数、走自由文本 + 「先保存再编辑选模型」提示（O1(a)，Codex P1-2）**；claude 协议 → 显「静态未探测」提示（D3/O2）。 | T2 |
| **T7** | ModelSelect 错误态：取模型失败（502）显**净化后的真实原因**（初次加载亦然）、不退化默认列表（D5 前端侧，Codex P2-4）；复用 ErrorBanner/inline 错误样式。 | T6 |
| **T8** | i18n（新建提示 / claude 静态提示 / 错误文案，中英对称）+ 前端测试（编辑态 fetch `?runtime=<name>`；新建自定义态不发默认 fetch；claude 显静态提示；错误态显净化原因不显默认列表；**默认 ModelSelect 逐字不变回归**）。 | T6,T7 |

## 全局验收清单

- [ ] PR-A：缓存 Map 多二进制隔离 + 失效 + 进程收口 + 路由运行时名优先 + opencode 按二进制 + claude 静态 + 向后兼容 + 错误含 runtime 且脱敏。
- [ ] PR-B：编辑态按运行时取模型 + 新建态自由文本（不显默认列表）+ claude 静态提示 + 错误态显净化原因不退化 + i18n。
- [ ] 向后兼容：无 `?runtime=` 旧调用零行为变化（黄金：默认 opencode 二进制、同缓存语义、settings ModelSelect 不变）。
- [ ] 门禁全绿：typecheck×3 + backend bun test + 前端 vitest + format + lint + binary smoke + e2e a11y。
- [ ] Codex 设计 gate〔done，7 findings fold〕 + 实现 gate fold。STATE.md/plan.md 索引 Done。

## 开放问题（设计 gate 已落定）

- **O1〔定 (a)〕** 新建自定义二进制态走自由文本 + 先存后选，不显默认列表、不引入 `?binaryPath=` 旁路（read 端点执行任意二进制面过大）；存前探测如需另立 admin-only POST。
- **O2〔定 加提示〕** claude fork 静态列表 + UI「未按该二进制探测」提示。
- **O2** claude fork 静态列表是否加 UI 提示「未按该 fork 探测」。
