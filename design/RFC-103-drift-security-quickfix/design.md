# RFC-103 漂移急修批 + 安全急修 — 技术设计

> 每条任务给：**证据（回源核实的 file:line）→ 修法（接口契约/数据流）→ 失败模式 → 必写测试**。
> 所有行号基于 2026-06-23 工作树；实现时以 grep 复核为准（多人并发树可能漂移）。

---

## A. 漂移急修

### T1 — 恢复回滚基线错（P1，`services/task.ts`）

**证据**：`resumeTask` 计算「每节点最新 run」用于回滚：
```
task.ts:1045  const latestPerNode = new Map<string, (typeof runs)[number]>()
task.ts:1047    const prev = latestPerNode.get(r.nodeId)
task.ts:1048    if (prev === undefined || r.id > prev.id) latestPerNode.set(r.nodeId, r)
task.ts:1050  const toRollback = [...latestPerNode.values()].filter(...)
```
按 `nodeId` 取 ULID 最大行，**未排除 `parentNodeRunId !== null` 的子行**。fanout/loop 的 per-shard / per-iteration 子行也带同 `nodeId`，其 ULID 可能晚于父级「节点行」，于是被当成该节点最新行，回滚用其 `pre_snapshot`（子行快照基线 ≠ 节点级基线）。对照 `pickFreshestRun`（freshness 权威）已做该过滤——这是 dedup「freshest-run fork」的又一实例。

**修法**：`latestPerNode` 聚合前过滤 `r.parentNodeRunId === null`（只考虑节点级行），与 `freshness.ts` 的 authority 对齐。**契约**：恢复回滚的基线集 = 每个节点的「父级（parentNodeRunId 为 null）最新 run」，子行不参与。
**耦合点**：`freshness.ts`（同一「freshest 节点行」语义，最好复用其 helper 而非再过滤一次——若 helper 可复用则直接调，否则注释指向它）。
**失败模式**：过滤后某节点只有子行无父行（理论上不应发生）→ 该节点不入回滚集（安全：不会用错基线）；加断言/日志。

**必写测试**（红先行）：构造「fanout 节点：1 父 wrapper 行 + N 子 shard 行，子行 ULID > 父行」，调 `resumeTask` 路径，断言**只回滚 top-level 父行**的 `pre_snapshot`、任一子行都不进 rollback 集；补一例「子行状态 failed/interrupted」也不进集（Codex 要求）。文件 `tests/rfc103-resume-rollback-baseline.test.ts`，顶部注释链接本 RFC + 01-LIFE-05。

### T2 — REST 入口漏传配置（P1，`routes/tasks.ts` + `services/task.ts`）

**证据**：
- `maxConcurrentNodes`：`rg maxConcurrentNodes packages/backend/src/routes` **零命中**；`scheduler.ts:155-157` 默认 4。即只有测试直调 `runTask({maxConcurrentNodes})` 生效，HTTP start/resume/retry 全走默认。
- `commitPush`：`routes/tasks.ts:251 resolveCommitPushConfig(deps.configPath)` + `:257 ...(commitPush ? {commitPush} : {})` **只在 start 分支**；resume/repair/retry 分支无此调用（grep 仅一处命中）。

**修法（Codex 复审已扩面——不是纯 route 补齐，含 service plumbing）**：
1. **service 层补字段**：`StartTaskDeps`（`task.ts:100-118`）只有 `commitPush?`、**无 `maxConcurrentNodes`** → 给 `StartTaskDeps` 及 resume/retry 的 deps/options 加 `maxConcurrentNodes?: number`，并 thread 到 `runTask`（scheduler 默认仍在 `scheduler.ts:397`）。
2. **补 retryNode 透传**：`retryNode` 内部调 `runTask`（`task.ts:1362-1373`）**未透传 commitPush** → 补齐（resume 路径 `task.ts:1108` 已支持 commitPush，retry 漏）。
3. **抽单一解析点** `resolveLaunchRuntimeConfig(deps.configPath)` 返回 `{ commitPush?, maxConcurrentNodes? }`（读 `resolveCommitPushConfig` + settings `maxConcurrentNodes`），在**全部 5 个入口**注入：JSON start（`routes/tasks.ts:251`）、**multipart start**（`routes/tasks.ts:772-801` 的两处 `startTask(...)` 调用，当前都没传 commitPush）、resume（`:376-383`）、repair-resume、retry（`:445-456`）。
**契约**：5 个入口对运行期配置透传一致（单一解析点，消除逐入口手抄）。
**耦合点**：与综合报告 rank 4「runTask kick 块收敛」同向，但本 RFC 只做「补齐透传 + 加缺失字段」不做 kick 块抽取（留后续）；不得改 `trySetTaskStatus`/`setTaskStatus` 的 CAS 路径（RFC-097 不变量，Codex 标注）。
**失败模式**：settings 无 `maxConcurrentNodes` → 维持默认 4；configPath 无 commitPush → 不传（现状）。

**必写测试**（Codex 要求覆盖 service options，非仅 route spy）：① service 层断言——`retryNode` 的 `runTask` options 带 `commitPush`、start/resume/retry 三入口 options 带 `maxConcurrentNodes`；② multipart start 路径也注入 commitPush（断言传参）；③ 源码层文本断言「`routes/tasks.ts` 5 个入口都调用 `resolveLaunchRuntimeConfig`」防再漂。文件 `tests/rfc103-launch-config-passthrough.test.ts`，注释链接 01-LIFE-06 / 02-SCHED「maxConcurrentNodes 未接线」。

### T3 — opencode token 计量缺 ~15×（P1，`services/runner.ts`）

**证据**：`accumulateTokens`（`runner.ts:1789-1795`）：
```
const cacheCreate = numOrZero(tokens.cache_creation ?? tokens.cacheCreation)
const cacheRead   = numOrZero(tokens.cache_read ?? tokens.cacheRead)
acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead
```
真实 opencode 录制 fixture（`packages/backend/tests/fixtures/opencode-recordings/1.15.5-with-envelope.ndjson`）token 形状是**嵌套**：`"tokens":{"total":7523,"input":465,"output":18,"reasoning":0,"cache":{"write":0,"read":7040}}`。代码读扁平键 → `cacheCreate=cacheRead=0`，算出 `total=465+18+0+0=483`，真实应是 7523（~15.6×）。`max_total_tokens` 限额据此判断 → 失效。

**修法**：`accumulateTokens` 兼容三种形状（保持向后兼容）：嵌套 `tokens.cache.read/write`、扁平 `cache_read/cache_creation`、camelCase。`reasoning` 同样纳入 total（fixture 有该字段）。**优先以「framework 自算 total 必须等于事件自报 `tokens.total`」为预言**（若 opencode 给了 `total` 字段，直接校验/采信）。
**耦合点**：`memoryDistiller.ts` 另有一套 token 解析（06-OCI-04/05）——本 RFC **只修 runner**，但在 distiller 处加 TODO 注释指向本 RFC（收敛留给 rank 6 OpencodeProcess 适配层）。
**失败模式**：旧扁平形状仍存在的 opencode 版本 → 兼容分支覆盖；都缺 → 0（现状）。

**必写测试**（parser-guard oracle，这条若早存在当场红）：用真实 fixture 跑 `accumulateTokens`，硬断言 `cacheRead === 7040`、`framework total === fixture tokens.total (7523)`；**并保留一例旧扁平 `cache_read` / camelCase 形状**（Codex 要求，防修嵌套时回退旧兼容）。文件 `tests/rfc103-token-accumulate.test.ts`，注释链接 06-OCI-06；这是「录制回放挡漂移」的最小落地。

### T4 — fanout 按 `\n` 误裂 `list<markdown>`（P1，`services/scheduler.ts`）

**证据**：fanout 分片源 item 派生（`scheduler.ts:3128-3132`）：
```
const items = rawContent
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
```
裸 `.split('\n')` 绕过单一事实源 `shared/listWire.ts:17 splitListItems` / `:55 splitMarkdownDocs`（`list<markdown>` 的 wire 边界是 `MARKDOWN_DOC_BOUNDARY`，不是换行）。含多行的 markdown 文档 item 被裂成逐行分片，`keyOf`/aggregation 全错，任务仍 green。

**修法**：按 fanout 声明的 `shardSource` itemKind 选择 splitter：`list<markdown>`/`list<path<md>>` → `splitMarkdownDocs`；普通 `list<string>` → `splitListItems`。**契约**：fanout 分片必须经 `listWire` 单一 codec，不得自写 split（与 05-PORT-07 一致）。封装 `splitShardItems(rawContent, itemKind)` 供调用。
**耦合点**：`shared/shardingRegistry.ts`（itemKind→keyOf 已在此），把 split 也归并到同一处 codec，避免「split 在 scheduler、keyOf 在 registry」两处。
**失败模式**：itemKind 未知 → fallback `splitListItems`（现状等价，不退化）；空源 → 维持现有 empty 短路（`scheduler.ts:3133`）。

**必写测试**：① `list<markdown>` 分片源含 2 个各带换行的文档，断言切出 **2** 个 shard（非按行 N 个）、每 shard 内容完整；② **`list<path<md>>` 仍按行切**（路径 item，不能误用 markdown doc boundary，Codex 要求）；③ `list<string>` 走 `splitListItems`。文件 `tests/rfc103-fanout-kind-aware-split.test.ts`，注释链接 05-PORT-06/07。

### T5 — 校验器 builtin 变量集漂移（P1，`services/workflow.validator.ts`）

**证据**：两份手抄 Set：
```
workflow.validator.ts:46  const BUILTIN_PROMPT_VARS = new Set(['__repo_path__', ...])   // 缺 __repos__/__repo_count__
shared/prompt.ts:238      const BUILTIN_VARS = new Set(['__repo_path__', ..., '__repos__'(:274), '__repo_count__', ...])
```
替换引擎（prompt.ts）认 `__repos__`，校验器不认 → RFC-066 多仓 `{{__repos__}}` 被 `prompt-template-unresolved` 误报，阻止合法工作流 launch（运行时本可替换）。

**修法**：`prompt.ts` 把 `BUILTIN_VARS` 导出为单一事实源；`workflow.validator.ts` 删本地 Set，改 `import { BUILTIN_VARS } from '@/...prompt'`（或经 `shared`）。**契约**：「哪些是内置 prompt 变量」全仓唯一定义在 `prompt.ts`。
**耦合点**：注意 import 方向/不引入 init cycle（`shared/prompt.ts` 已是 shared，validator import 它安全；若有循环用 `listWire` 同款「薄 re-export」手法）。参考 [reference_binary_build_module_cycle]，改后跑 `build:binary` smoke。
**失败模式**：prompt.ts 未来加新内置变量 → 校验器自动跟随（这正是目的）。

**必写测试**：① 一个多仓工作流 def 用 `{{__repos__}}`/`{{__repo_count__}}`/`{{__repo_names__}}`，断言 `validateWorkflowDef` **不**报 `prompt-template-unresolved`；② 一致性断言**验证 validator 引用的就是 `prompt.ts` 导出的同一个 `BUILTIN_VARS` Set 实例/同源**（Codex：不要再写第三份期望数组，否则又是一处 fork）。文件 `tests/rfc103-validator-builtin-vars.test.ts`，注释链接 04-WFM-06/07。

### T6 — 信封端口内容嵌套 `</port>` 截断（P1，`services/envelope.ts`）

**证据**：`envelope.ts:143 PORT_RE = /<port\s+name=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/port>/g`，内容用非贪婪 `[\s\S]*?` 到**首个** `</port>`。当端口内容自身含字面 `</port>`（如审计输出里讨论协议的代码块、或被审计代码恰含该串）→ 截断、丢后续内容，且无告警。`<workflow-output>` 取「最后一个」是对的，但端口内部边界判定脆弱。

**修法**：端口边界改为「按下一个 `<port name=` 起点（或 `</workflow-output>` 块尾）切分」而非非贪婪 `</port>` 匹配——先在 envelope 块内 `matchAll` 所有 `<port\s+name=...>` 起点，每个端口内容 = 本起点 `>` 之后到下一起点（或块尾）之间、剥掉尾随的 `</port>`（容差：有/无闭合标签都接受）。**契约**：端口内容对内含字面 `</port>` 鲁棒。
**残留限制（Codex 复审，诚实标注）**：容器化只解决最常见的 `</port>`；若端口内容**自身**含字面 `<port name=`（开标签）或 `</workflow-output>`，仍会误切——`ENVELOPE_RE`（`envelope.ts:139`）同为非贪婪。本 RFC **不引入 CDATA/转义**（那是更大改面）；改为：(a) 在 `protocol.ts` 协议块**显式声明**「端口内容不得含字面 `<port name=` / `</workflow-output>`」；(b) 用**负向测试**锁定这条协议边界（含字面 `<port name=` 时按协议判为「未定义/截断」而非假装支持）。`</port>` 这条最常见的真 bug 修掉，其余作为已声明协议约束。
**保留不变量**：`extractLastEnvelope`「最后一个 `<workflow-output>` 胜出」（`envelope.ts:157-165`）不得破坏；端口名重复维持「后者覆盖」现有语义。
**耦合点**：`services/protocol.ts`（协议块文案加约束声明）；`resolvePortContent*`（消费方不变）。

**必写测试**：① 端口内容含字面 `</port>` → 断言解析出**完整**内容（含该串），用完整相等替换弱 `toContain`；② **负向**：端口内容含字面 `<port name=` → 断言按协议边界处理（不静默吞后续端口）；③ 重复 port 名 → 断言「后者胜出」；④ 既有正常信封 + `extractLastEnvelope` 多 envelope「最后胜出」回归保等价。文件 `tests/rfc103-envelope-nested-port.test.ts`，注释链接 05-PORT-02。

---

## B. 安全急修

### T7 — 端口 symlink 越界读取（High，`services/envelope.ts`）

**证据**：`envelope.ts:124-130`：
```
const rootAbs = resolve(worktreeAbsPath)
const targetAbs = isAbsolute(rawContent) ? resolve(rawContent) : resolve(rootAbs, rawContent)
// realpath() is intentionally NOT done here; the documented limit (a symlink inside...)
const insideWorktree = targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep)
```
只做**词法**包含（注释明示有意不做 realpath，是已知 documented limit）。worktree 内放一个 symlink 指向 `/etc/passwd` 或仓外密钥，`path`/`markdown_file` 端口即可读出（测试 `envelope-parse-md-edge-cases.test.ts:83-99` 锁定能读出 `TOP SECRET`）。与 `services/worktreeFiles.ts` 的 realpath 防护不一致（同类读取面双标准）。

**修法**：解析后对 `targetAbs` 做 `realpathSync`（或 `fs.realpath`），再判 realpath 是否仍在 `realpath(worktree)` 内；symlink 落到 worktree 外 → 抛 `ValidationError('port-content-outside-worktree')`。与 `worktreeFiles` 复用同一 realpath-containment helper（抽 `util/safePath.ts` 若已有则用）。**契约**：端口文件读取的越界判定 = realpath 包含，与 worktree 文件浏览一致。
**失败模式**：目标不存在 → 维持现有「不存在」错误（realpath 对不存在路径抛错，需先判存在再 realpath，或捕获）；worktree 本身经 symlink（少见）→ 对两侧都 realpath 后比较。
**注意**：这是收紧安全边界，可能让「故意用 symlink 指向 worktree 内另一真实路径」的合法用例变化——realpath 后仍在 worktree 内的 symlink 应**放行**（只拦越界）。更新 `envelope-parse-md-edge-cases.test.ts` 中那条「读出 worktree 外 TOP SECRET」的用例为「应被拒」。

**必写测试**：worktree 内 symlink → 仓外文件，断言端口解析**抛错**（注意实际抛的可能是 `PortValidationError extends ValidationError`，按真实类型断言，Codex 提示）；worktree 内 symlink → 仓内文件，断言**放行**；并把现有 `envelope-parse-md-edge-cases.test.ts:83-99`「读出仓外 TOP SECRET」用例改为「应被拒」。文件 `tests/rfc103-envelope-symlink-containment.test.ts`，注释链接 05-PORT MISSED（Codex）。

### ~~T8 — 缓存仓凭据 URL 泄漏~~（**已移出本 RFC**，Codex 复审）

真问题（`schemas/cachedRepo.ts:5-10` 暴露 `url` 原文、`routes/cached-repos.ts:25-29` 原样返回、`gitRepoCache.ts:181-185 rowToCached` 填 `row.url`），但**直接删 `url` 会破坏现有契约**：前端启动下拉用 `it.url`（含凭据）作为 Select 的 **value** 提交为 `repoUrl`（`RepoSourceRow.tsx:229-240`）、服务端据此 clone 私有仓，记忆弹窗也展示 `r.url`（`MemoryNewDialog.tsx:163-165`）。正确修法是 **launch-by-`cachedRepoId`**（列表只回 `id`/`urlRedacted`、StartTask schema 加 `cachedRepoId`、服务端 id→url 内部解析、前端改用 id+redacted），属契约变更 → **独立 RFC**（凭据隔离 + launch-by-id）。本 RFC 不含 T8。

### T9 — 登录非 constant-time（Medium，`routes/auth.ts` + `auth/passwords.ts`）

**证据**：`auth.ts:38-44`：未知用户 / `status!=='active'` / 无 `passwordHash` → 直接抛 `UnauthorizedError`（注释自称 constant-time，**实则未跑 Argon2**）；仅有效用户跑 `verifyPassword`（Argon2，昂贵）→ 计时可区分「有效活跃账号」与「不存在/禁用」。叠加无速率限制（10-ACL-09）可枚举。

**修法**：对「无 row / 非 active / 无 hash」分支也跑一次**dummy Argon2 verify**（针对一个固定的假 hash），使两路径耗时趋同后再统一抛 `UnauthorizedError`。在 `auth/passwords.ts` 加 `verifyPasswordDummy()`（verify against a constant well-formed hash）。**契约**：登录响应时间不随「账号是否存在/是否 active」而显著变化。
**失败模式**：dummy hash 必须是合法 Argon2 串且参数与真实一致（否则耗时不匹配）；用一个固定常量。
**范围说明**：本 RFC 只做 constant-time；速率限制/退避是更大改面，列入非目标（建议随认证硬化 RFC）。

**必写测试**：断言三条早退分支——**未知用户 / inactive 用户 / 有 row 但无 passwordHash**——与「密码错」一样都调用了 Argon2 verify（spy 计数 ≥1）（Codex：三条早退都要覆盖）。用「都跑 Argon2」作计时代理而非脆弱真实 timing 断言（符合 CLAUDE.md「去时序 race」）。文件 `tests/rfc103-login-timing.test.ts`，注释链接 10-ACL MISSED（Codex）。

### T10 — `/api/skill-sources` 无 ACL 过滤（Medium，`routes/skill-sources.ts`）

**证据**：`skill-sources.ts:50-52`：
```
app.get('/api/skill-sources', async (c) => {
  const sources = await listSkillSourcesWithStats(deps.db)
  return c.json({ sources })
})
```
无 registrar/admin 过滤，任何认证用户可读所有 source 的本机绝对路径 + label + childCount/skipped。对比同文件写操作有 `requireSourceRegistrar`（`:44` 的 ForbiddenError 路径），读列表却敞开。

**修法**：列表按 actor 过滤——非 admin 只见自己 registrar 的 source（与该文件写路径的 `requireSourceRegistrar` 同一判定单一事实源），或 admin-only。**契约**：source 的本机路径只对 registrar/admin 可见，与 RFC-099「未授权不可见」一致。
**耦合点**：`services/skill-source.ts:listSkillSourcesWithStats` 加 actor 过滤参数；与 RFC-099 `resourceAcl`/`requireSourceRegistrar` 复用。
**失败模式**：source 无 registrar 概念的历史数据 → 默认 admin-only（保守）。

**必写测试**：① 非 registrar 普通用户请求，断言看不到他人 source 的绝对路径；② registrar 只能看自己创建的 source；③ **legacy `createdBy=null` 的 source 仅 admin 可见**（Codex 要求覆盖历史数据保守路径）。文件 `tests/rfc103-skill-sources-acl.test.ts`，注释链接 12-RES MISSED（Codex）。

---

## 测试策略（汇总 — PR 必须全绿才算交付）

| 任务 | 必写测试文件 | 断言核心（先红后绿） |
|---|---|---|
| T1 | `rfc103-resume-rollback-baseline.test.ts` | fanout 子行不冒充节点最新行，回滚用父行 pre_snapshot |
| T2 | `rfc103-launch-config-passthrough.test.ts` | service options 覆盖（retry commitPush / 全入口 maxConcurrentNodes / multipart start）+ 5 入口文本断言 |
| T3 | `rfc103-token-accumulate.test.ts` | 真 fixture：cacheRead===7040 且 framework total===tokens.total(7523) |
| T4 | `rfc103-fanout-kind-aware-split.test.ts` | list<markdown> 切 2 shard 非按行，内容完整 |
| T5 | `rfc103-validator-builtin-vars.test.ts` | `{{__repos__}}` 不误报 + 校验器集===prompt.ts BUILTIN_VARS |
| T6 | `rfc103-envelope-nested-port.test.ts` | 端口含字面 `</port>` 时内容完整 + 既有信封回归等价 |
| T7 | `rfc103-envelope-symlink-containment.test.ts` | 越界 symlink 抛错 / 界内 symlink 放行 |
| T9 | `rfc103-login-timing.test.ts` | unknown/inactive/no-hash 三早退分支都跑 Argon2 |
| T10 | `rfc103-skill-sources-acl.test.ts` | 非 registrar 看不到他人 source 绝对路径 |

**等价锚（防行为回归）**：T6（envelope 解析）、T4（fanout）、T1（resume）改动后，既有 `envelope-*` / `scheduler-*` / `clarify-*` / `retry-cascade-*` / `auth-routes` 套件必须保持绿。
**运行门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿；T5 因触碰 shared/import 方向，额外跑 `bun run build:binary` smoke（[reference_binary_build_module_cycle]）。前端无改动（本 RFC 纯后端）。
**Codex 复审**：按 [feedback_codex_review_after_changes] 两 gate——本设计文档落档后先跑设计 gate；每个 PR 代码完成后跑实现 gate。

## 失败模式与回滚

- 全部任务**向后兼容**：T3 兼容旧扁平 token 形状；T2 缺配置维持默认；T5 同源后行为不变（只是不再误报）；T7/T10 收紧边界——需确认无合法用例依赖旧的宽松行为（T7 界内 symlink 放行、T10 admin 仍可见）。
- 单 PR 可独立 revert，无跨 PR 数据迁移、无新表、无 schema migration。
