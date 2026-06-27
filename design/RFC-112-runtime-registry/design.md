# RFC-112 — 运行时注册表（技术设计）

配套 `proposal.md`（决策 D1–D9）。给数据模型、解析/冻结推广、深度冒烟探测器、路由、UI、与 RFC-111 的兼容、失败模式、测试策略。

---

## 0. 现状锚（RFC-111 已落，本 RFC 在其上推广）

- `RuntimeDriver`（`services/runtime/`）= **协议层**：`getRuntimeDriver('opencode'|'claude-code')` → `parseEvent` + 各自 `buildOpencodeSpawn`/`buildClaudeSpawn`（argv head 可被 `opencodeCmd`/`runtimeCmd` 覆盖——本 RFC 用它喂自定义二进制路径）。**不改**。
- `resolveRuntime(agentRuntime, defaultRuntime)`（`services/runtime/index.ts`）→ `'opencode'|'claude-code'`，三层回退。本 RFC **推广**：先解析「运行时名」，再映射到 protocol。
- `resolveFrozenRuntime`（`nodeRunMint.ts`）冻结 `node_runs.runtime`。本 RFC 冻结的是**运行时名**（其 protocol 稳定）。
- `agents.runtime` / `node_runs.runtime`（text 列，RFC-111）、`config.defaultRuntime`（RFC-111 enum）→ 语义改为**运行时名**，列与存量值兼容（内置名 = 'opencode'/'claude-code'）。
- `builtin` 列模式（RFC-104，schema.ts:80/328）：`integer({mode:'boolean'})` 锁只读内置行。本 RFC 复用到 `runtimes`。
- RFC-111 的 `/api/runtime/{opencode,claude}`（版本 probe）+ `RuntimeStatusCard`（版本状态）→ 本 RFC **超集替代**为 `/api/runtimes` + 列表 + 冒烟状态（D9）。daemon 启动 opencode 版本硬门（`cli/start.ts`）**保留不动**。

## 1. 数据模型

### 1.1 `runtimes` 表（migration，手写 + statement-breakpoint〔注释勿含该字面量〕）

```sql
CREATE TABLE IF NOT EXISTS `runtimes` (
  `id`            text PRIMARY KEY NOT NULL,
  `name`          text NOT NULL,                         -- 唯一；agent.runtime / defaultRuntime 引用它
  `protocol`      text NOT NULL,                         -- 'opencode' | 'claude-code'（驱动）
  `binary_path`   text,                                  -- NULL → 协议默认二进制（见 §2.2）
  `builtin`       integer NOT NULL DEFAULT 0,            -- RFC-104 式只读锁
  `last_probe_json` text,                                -- 缓存冒烟结果 {conforms,detail,at,sawEnvelope}
  `created_by`    text,                                  -- 管理员 user id（审计）
  `created_at`    integer NOT NULL,
  `updated_at`    integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_runtimes_name` ON `runtimes` (`name`);
```

**种子**（启动 seed，**Codex P2 修订——hard-reset 而非 adopt**）：每次启动把内置两行**强制重置为精确规范形态** `{name, protocol, binary_path=NULL, builtin=1}`（按 name upsert），**绝不 adopt 既有同名行的脏值**（用户手建的 `opencode` 行若 protocol 错或 binary_path 非空会被改成不可变脏状态）。规范形态：
- `opencode`：protocol=opencode, binary_path=NULL, builtin=1
- `claude-code`：protocol=claude-code, binary_path=NULL, builtin=1

冲突处理：若存在同名**非内置**行（builtin=0）→ 启动 seed 直接覆盖为内置规范形态（内置名是保留名，§4 注册时已禁用户取这两个名，故正常不会撞；防御性硬重置）。

### 1.2 引用列（不新增列，语义推广）

- `agents.runtime`（RFC-111 text 列）：NULL=继承 `config.defaultRuntime`；否则=**运行时名**。存量 `'opencode'`/`'claude-code'` = 内置名 → 解析照常。**零数据迁移**。
- `config.defaultRuntime`（RFC-111 字段）：从 `z.enum(['opencode','claude-code'])` 放宽为 `z.string()`（任一运行时名；默认 'opencode'）。存量值兼容。
- `node_runs.runtime`（RFC-111 text 列，D15 冻结）：保持 = 冻结 **protocol**（Codex P1，见 §2.3）。
- **新增 `node_runs.runtime_binary`**（nullable，migration）：dispatch 时的 **binary head 快照**（自定义路径 / 内置默认=NULL），resume 自洽不查注册表。（可选 `node_runs.runtime_name` 仅 UI 展示。）

## 2. 解析与驱动接线

### 2.1 名 → (protocol, binaryPath)（`services/runtimeRegistry.ts`）

```ts
export interface ResolvedRuntime { name: string; protocol: RuntimeKind; binaryPath: string | null }

/** 解析运行时名 → 注册行。未知名 fail-safe 回内置 opencode（+ warn）。 */
export function resolveRuntimeByName(db, name: string | null | undefined): ResolvedRuntime {
  const n = name && name.length > 0 ? name : null
  if (n !== null) {
    const row = lookup(db, n)
    if (row) return { name: row.name, protocol: row.protocol, binaryPath: row.binaryPath }
    log.warn('runtime-name-unknown-fallback-opencode', { name: n })
  }
  return { name: 'opencode', protocol: 'opencode', binaryPath: null }
}

/** agent.runtime ?? config.defaultRuntime ?? 'opencode'，再解析为运行时行。 */
export function resolveAgentRuntime(db, agentRuntime, defaultRuntime): ResolvedRuntime {
  return resolveRuntimeByName(db, agentRuntime ?? defaultRuntime ?? 'opencode')
}
```

### 2.2 二进制 head 解析（保 RFC-111 行为不变）

```ts
// opencode 协议：binaryPath ?? config.opencodePath ?? 'opencode'（PATH）
// claude  协议：binaryPath ?? config.claudeCodePath ?? 'claude'
export function runtimeHead(resolved: ResolvedRuntime, config): string[] {
  if (resolved.binaryPath) return [resolved.binaryPath]
  if (resolved.protocol === 'opencode') return config.opencodePath ? [config.opencodePath] : ['opencode']
  return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
}
```

### 2.3 runner / scheduler 接线

- scheduler 派发点（RFC-111 已在 2380 / fanout 3685 / aggregator 3943 接 `resolveFrozenRuntime`）：`resolveFrozenRuntime` 推广为**冻结运行时名**，并解析出 `(protocol, binaryPath)` 透传给 runNode：
  - `opts.runtime` → 改为 `opts.runtimeProtocol`（protocol，决定 driver/spawn 分支，RFC-111 已有逻辑）+ 新 `opts.runtimeBinary?: string[]`（head 覆盖，生产专用——与 RFC-111 P1-1 的 `runtimeCmd`〔测试专用〕区分）。
  - runNode：`getRuntimeDriver(opts.runtimeProtocol)` + spawn 用 `runtimeBinary ?? runtimeCmd ?? 协议默认`。**内置 opencode/claude（binaryPath=NULL）→ runtimeBinary=undefined → 走 RFC-111 既有默认路径，逐字不变。**
- **冻结 D15（Codex P1 修订——冻结快照、registry-mutation 免疫）**：**不冻结运行时名**（名/binary_path 可变，删/改名会让冻结失稳、把 claude 会话错配回内置 opencode）。改为冻结**自包含快照**：
  - `node_runs.runtime` **保持 RFC-111 语义 = 冻结 protocol**（'opencode'|'claude-code'，决定 driver + session id 格式，跨 resume 稳定；未知值仍 RFC-111 P2-2 warn 处理，protocol 是 2 值枚举故损坏极罕见）。
  - **新增 `node_runs.runtime_binary`**（nullable，migration）= dispatch 时解析出的 **binary head 快照**（自定义→实际路径；内置默认→NULL）。
  - resume：`getRuntimeDriver(冻结 protocol)` + head = `runtime_binary ?? 协议默认`（config.opencodePath/claudeCodePath/PATH）。**完全不查注册表**——runtime 被删/改名/改 binary_path 都不影响已冻结 run（快照自洽）；session id 与冻结 protocol 配对、零错配。
  - 二进制已从磁盘消失：spawn 抛 → RFC-111 P1-2 try/catch → node failed（清晰报错）。
  - **故删除守卫只需扫当前引用**（`agents.runtime` + `config.defaultRuntime`，防悬空），**无需扫 resumable node_runs**（它们有快照）。可选 `node_runs.runtime_name` 仅作 UI 展示（不参与解析）。

## 3. 深度冒烟符合性探测（D2，核心）

`services/runtimeSmoke.ts` `smokeRuntime({ protocol, binaryPath, config, timeoutMs }): Promise<SmokeResult>`：

```ts
// Codex P2: classify the outcome so an auth/quota failure on a CONFORMING fork
// isn't misjudged as non-conformance. UI shows the class + lets admin decide.
type SmokeOutcome =
  | 'conforms'            // 协议事件流 + nonce 回显（端到端通过）
  | 'spawn-failed'        // 二进制起不来（ENOENT/权限）——明确不可用
  | 'auth-missing'        // 起来了但鉴权失败（claude is_error "Not logged in" / opencode auth）——可能符合、缺鉴权
  | 'model-call-failed'   // 起来了、鉴权 OK，但模型调用失败（限额/超时/模型不可用）——可能符合、环境问题
  | 'stream-nonconforming'// 起来了但 stdout 不是该协议可解析的事件流——明确不符合
type SmokeResult = {
  outcome: SmokeOutcome
  conforms: boolean       // === outcome==='conforms'
  detail: string
  capturedSessionId?: string
  sawNonce: boolean       // 模型回显了 prompt nonce（证明二进制消费了 prompt + 真跑了一轮）
  sawEnvelope: boolean    // <workflow-output> 出现（更强信号）
  exitCode: number | null
}
```

**机制**（复用 RFC-111 的 driver spawn + parseEvent，**不走完整 runNode**——无 DB 行 / 无 worktree，只一次性 spawn + pump）：

1. 建临时 cwd（`mkdtempSync`，claude 需要 cwd 推导 slug；opencode 需要 cwd）。
2. 用协议的 spawn 构造器，**head = `[binaryPath]`**（自定义二进制），跑一个**最小冒烟 agent**：
   - opencode：`buildOpencodeSpawn({ opencodeCmd:[binaryPath], agentName:'aw-smoke', prompt:<冒烟 prompt>, inlineConfigSerialized: JSON(冒烟 inline agent), runDir:tmp/.opencode, worktreePath:tmp, ... })`。
   - claude：`buildClaudeSpawn({ claudeCmd:[binaryPath], prompt:<冒烟 prompt>, systemPromptText:'You are a smoke-test agent.', attemptDir:tmp, worktreePath:tmp, bridgeCredentials:true, ... })`。
   - 冒烟 prompt = trivial + **随机 nonce**（「把这一串 `<nonce>` 原样用 `ok` 端口回出来」）+ RFC-111 协议块（诱导信封）。模型用**最便宜**（config.smokeModel ?? 协议默认便宜档）。nonce 经 `process` 无法预知（每次 probe 现生成，传给冒烟 prompt + 比对输出），杜绝「预录回放」假阳。
3. `Bun.spawn`（含 P1-2 try/catch：spawn 抛 → conforms=false「二进制无法启动」），短 `timeoutMs`（默认 60s，SIGTERM→SIGKILL 复用 RFC-098 kill）。
4. 逐行 `getRuntimeDriver(protocol).parseEvent(line)` 累积：是否捕获 `sessionId`、是否有可解析事件、accumulatedText 是否含 `<workflow-output>`。
5. **判定（Codex P2 强化——端到端 + 分类，非「一条可解析行」）**：
   - **spawn 抛** → `spawn-failed`。
   - **起来了但 stdout 完全无可解析事件**（如 `/bin/echo`）→ `stream-nonconforming`。
   - **有可解析事件但鉴权失败**（claude `result.is_error` + "Not logged in" / opencode auth 错日志）→ `auth-missing`（**不判非符合**——可能是符合的 fork 缺鉴权，admin 可选「仍保存为未验证」）。
   - **鉴权 OK 但模型调用失败**（限额/超时/模型不可用）→ `model-call-failed`（同上，环境问题非协议问题）。
   - **`conforms`** 需端到端全绿：`exitCode===0 ∧ 协议事件序列完整`（claude：`system/init → assistant → result`；opencode：捕获 sessionId + ≥1 text/step 事件）`∧ 捕获 sessionId ∧ (sawNonce ∨ sawEnvelope)`。**nonce**：冒烟 prompt 内嵌随机串、要求模型在输出里回显它；`sawNonce` = accumulatedText 含该 nonce → 证明**二进制真消费了 prompt + 跑了一轮 + 输出被我方按协议捕获**（远强于「emit 了一行 JSON」，杜绝假阳）。`sawEnvelope` = `<workflow-output>` 出现（更强）。
   - 即「真按协议端到端跑通一轮」才算 conforms；auth/model 类失败单独分类、不误杀。
6. **生命周期（Codex P2——脱离 runNode 必须显式收口，否则漏进程/fd/临时目录/无界 buffer）**：整个 spawn+pump 包在 `try/finally`：
   - stdin（claude pipe）写完 `end()`；stdout/stderr 都 drain（不读 stderr 会阻塞写端）。
   - accumulatedText / 事件计数**设上限**（如 256KB / 2000 行——冒烟只需开头若干事件 + nonce，超限即停读判定，防恶意/异常二进制刷爆内存）。
   - 超时 + 收尾**复用 RFC-098 `killTree`**（进程组 SIGTERM→grace→SIGKILL，`detached:true`）；spawn 抛 / 超时 / 任意异常 → `finally` 里 `killTree` + `rmSync(tmp, recursive)`。
   - 临时 cwd / 临时 CLAUDE_CONFIG_DIR 一律 `finally` 清；凭据桥接的 `.credentials.json`（claude 真跑）随临时目录清。

**不探版本**（D2）：完全不跑 `--version`、不比对 MIN。

**成本/门控（D7）**：仅注册时 + 显式「测试」按钮触发（非列表刷新）；结果 `last_probe_json` 缓存展示。真二进制需 auth（claude 走 RFC-111 凭据机制；opencode 走其 auth）；冒烟是一次 trivial 模型调用，admin 动作可接受。

**测试**：mock-opencode/mock-claude 已 emit 协议事件 + 可选信封 → 冒烟确定性 conforms=true；指向 `/bin/echo` 或不存在路径 → conforms=false（无事件 / spawn 失败）。

## 4. 注册表 CRUD + 守卫（`services/runtimeRegistry.ts`）

- `listRuntimes(db)` / `getRuntime(db, name)`：全员可读。
- `createRuntime(db, { name, protocol, binaryPath }, actorAdmin)`：校验 name 唯一 + 非内置名 + protocol ∈ 两协议；**先冒烟**（conforms 才落库，或落库带 last_probe）；`created_by`。
- `updateRuntime` / `deleteRuntime`：**内置只读守卫**（`builtin=1` → 403 `runtime-builtin-readonly`，仿 RFC-104 `assertNotBuiltin`）；改 protocol 禁止（即便自定义——protocol 决定 driver/session 格式，改了破坏已冻结 node_runs；只允许改 binary_path / name / 重新冒烟）；**删除引用守卫**：被任何 `agents.runtime` 或 `config.defaultRuntime` 引用 → 阻断（`runtime-in-use`，先改引用）。
- **ACL（D3）**：写操作 `requireAdmin()`（仿 RFC-099 distill jobs）；读全员。不进 RFC-099 五资源 owner/visibility 模型。
- **name 规范化（Codex P3）**：`name` 强约束 `^[a-z0-9][a-z0-9-]{0,30}$`（小写、URL-safe 给 `/:name` 路由、无空格）；保存前 trim；保留名 `opencode`/`claude-code` 仅内置可用（用户取这两个名 → 422）。大小写敏感按规则即小写唯一。
- **执行边界（Codex P3，显式声明）**：「运行时管理员」= **受信本机代码执行角色**——admin 本就掌控 daemon，注册一个会被 spawn 的二进制路径**不构成提权**（他能改 config / 重启 daemon）。守护：`binary_path` 校验为**单个可执行文件路径**（非 shell 串、无参数注入）；spawn 一律 **argv 数组**（`[binaryPath, ...flags]`，绝不拼 shell）；`/probe` 与所有写路由 admin-only。
- **删除守卫范围（Codex P1 衍生）**：只需扫**当前引用**（`agents.runtime` + `config.defaultRuntime`）阻断删除（防悬空 → 下次派发 fail-safe opencode）；**无需扫 resumable `node_runs`**——它们冻结了 (protocol, binary) 快照、与注册表解耦（§2.3）。

### 4.1 运行时名推广的 API 边界（Codex P2——枚举校验/模型路由需同步）

`config.defaultRuntime` 放宽 `z.enum`→`z.string()` 之外，以下边界也须从「两值枚举」改为「名→protocol 解析」，否则自定义 claude 协议运行时会被旧校验拒、或被显示成 opencode 模型：

- **Agent 创建/更新校验**：`agents.runtime` 不再校验 ∈ {opencode,claude-code}，改为「∈ 已注册运行时名 或 空（继承）」（`createRuntime`/`updateRuntime` 时校验引用存在）。
- **`/api/runtime/models?runtime=`**：参数从 protocol 改为**运行时名**（或兼容两者）；服务端 `resolveRuntimeByName(name).protocol` → 决定返 claude 静态列表 / opencode 动态列表。前端 AgentForm/Settings 的 ModelSelect 按选中运行时的 protocol 取命名空间。
- **workflow 校验**（若有运行时引用）：同 agent。
- RFC-111 残留的 `defaultRuntime` 前端 `<Select>` 两硬编码值 → 改为列表（§6）。

## 5. 路由（`routes/runtimes.ts`，挂 `/api/*`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/runtimes` | 全员 | 列全部（含 last_probe 状态） |
| POST | `/api/runtimes/probe` | admin | 对 `{protocol, binaryPath}` 跑深度冒烟，返回 SmokeResult（不落库——注册前预检 / 列表「测试」按钮） |
| POST | `/api/runtimes` | admin | 注册 `{name, protocol, binaryPath}`（冒烟 + 落库） |
| PUT | `/api/runtimes/:name` | admin | 改 binary_path（自定义；内置 403） |
| DELETE | `/api/runtimes/:name` | admin | 删自定义（内置 403 / in-use 阻断） |

RFC-111 的 `/api/runtime/{opencode,claude,models}` → `models` 保留（`?runtime=` 仍按 protocol 返模型）；`opencode`/`claude` 版本 probe 路由由列表的 `/probe` 超集替代（保留兼容别名或删，见 D9——实现期定，倾向保留 opencode 别名给 daemon 健康用）。

## 6. 前端（公共组件优先，CLAUDE.md 前台统一风格）

### 6.1 设置页运行时**列表**（取代 RFC-111 两张堆叠 RuntimeStatusCard）

- `components/RuntimeList.tsx`（新公共组件）：一个 `.page__section` 内的紧凑列表/表，每行一个运行时：
  - 列：名称（+ 协议徽标 opencode/claude）· 冒烟状态点（`<StatusChip>`/`StatusDot`：符合绿 / 不符合红 / 未测灰）· 二进制路径（NULL 显「默认 PATH / opencodePath」）· 操作。
  - 内置行（opencode/claude）：只读徽标，仅「测试」按钮。
  - 自定义行：「测试」「编辑」「删除」。
  - 顶部「+ 添加运行时」→ `RuntimeFormDialog`（复用 `Dialog` + `Form` `<Field>`/`<TextInput>` + 协议 `<Select>`），保存前调 `/api/runtimes/probe` 显示冒烟结果再确认。
- 设置页保留 `defaultRuntime` `<Select>`（选项来自 `/api/runtimes` 列表，非硬编码两值）+ opencodePath/claudeCodePath 文本框（内置默认二进制路径，喂内置运行时）。
- RFC-111 的 `RuntimeStatusCard` 退役 / 收编进 RuntimeList 的行渲染。

### 6.2 Agent 表单运行时选择器

- `AgentForm` 的运行时 `<Select>`：选项来自 `/api/runtimes`（全部已注册运行时名 + 「继承默认」空项），取代 RFC-111 的硬编码 opencode/claude-code 两值。选中运行时的 protocol 决定模型命名空间（claude 协议→`<ModelSelect runtime="claude">`、隐 variant/temp；opencode 协议→opencode 模型）。

### 6.3 i18n

runtimes 列表 / 表单 / 协议名 / 冒烟状态 / 操作 中英对称。

## 7. 失败模式

- **未知运行时名**（agent 引用了已删运行时）：`resolveRuntimeByName` fail-safe 回内置 opencode + warn（不 brick 任务）；删除引用守卫（§4）从源头降低概率。
- **自定义二进制运行期不存在 / 不符合**：RFC-111 P1-2 spawn try/catch → node failed（清晰报错）；注册时冒烟已先拦一道。
- **改 protocol 破坏已冻结 node_runs**：禁改 protocol（§4）。
- **冒烟需 auth / 耗额度**：D7 按需触发 + 最便宜模型 + 短超时；CI 用 mock（零额度）。
- **删被引用的运行时**：in-use 守卫阻断。
- **内置被改/删**：RFC-104 式 `builtin` 守卫 403。

## 8. 测试策略（每条先红后绿）

- 注册表：CRUD + 内置只读守卫（删/改名/改协议 403）+ in-use 删除阻断 + name 唯一 + 种子幂等。
- 解析：`resolveRuntimeByName`（命中/未知 fail-safe/内置）+ `runtimeHead`（binaryPath / 协议默认回退，opencode/claude 各态）+ 冻结推广（冻运行时名、resume 读冻结）。
- 冒烟：mock-opencode/mock-claude 指定 head=mock → conforms=true（捕 sessionId + 事件 + 可选信封）；head=`/bin/echo` 或不存在 → conforms=false（无事件 / spawn 失败 try/catch）；超时 → conforms=false。
- 路由：`/api/runtimes` CRUD admin 门（非 admin 403/读 OK）+ `/probe` + api-contract 登记。
- runner：内置 opencode/claude（binaryPath=NULL）spawn head **逐字等于 RFC-111**（黄金断言）；自定义 binaryPath → head=[binaryPath]。
- 前端：RuntimeList 渲染（内置只读/自定义可改/冒烟状态点）+ 添加对话框预冒烟 + AgentForm 选择器列注册项 + defaultRuntime 选项来自列表；i18n 对称。
- e2e：注册自定义 mock 运行时 → agent 选它 → 跑通（混用拓扑）。

门禁：typecheck×3 + 后端 bun test + 前端 vitest + format + binary smoke（新 migration 嵌入 + 无模块环）。Codex 设计 gate（本文）+ 实现 gate 各 fold。

## 9. 推出顺序（PR 拆分见 plan.md）

强序：A 注册表数据层（表+种子+CRUD+守卫+解析推广，无 UI/冒烟）→ B 冒烟探测器 + 路由 → C runner/scheduler 接线（binaryPath head + 冻结名，opencode 黄金断言）→ D 前端列表 + agent 选择器。每 PR 独立绿、独立可上。回退：无自定义运行时 + defaultRuntime=opencode → 行为与今日（RFC-111 后）一致。

## 10. Codex 设计 gate fold 记录

2026-06-27 第一轮（codex-cli read-only，范围限定 RFC-112 三件套，排除已完成 RFC-111 + 工作树协作者 RFC-108）。verdict=needs-rework，**8 findings 全部采纳**：

| # | 级别 | finding | 处置 |
|---|---|---|---|
| 1 | P1 | 冻结运行时名不稳——名/binary 可变、删/改名把 claude 会话错配回 opencode | 改**冻结 (protocol + binary 快照)**：`node_runs.runtime`=protocol（RFC-111 不变）+ 新 `node_runs.runtime_binary` 快照；resume 自洽不查注册表、registry-mutation 免疫；删除守卫只扫当前引用（§2.3/§1.2/§4）。 |
| 2 | P2 | 冒烟判定太弱（一条可解析行即过） | 强化为**端到端 + nonce**：协议事件序列完整 + 捕 sessionId + (sawNonce ∨ sawEnvelope)；nonce 现生成、要求模型回显、比对输出，证明二进制真消费 prompt 跑通一轮（§3 判定/步骤2）。 |
| 3 | P2 | auth/config 失败被误判为不符合 | SmokeResult **分类** outcome（spawn-failed / auth-missing / model-call-failed / stream-nonconforming / conforms）；auth/model 类不判非符合、admin 可「仍保存为未验证」（§3 接口/判定）。 |
| 4 | P2 | 冒烟生命周期（脱离 runNode）欠规范 | 显式 try/finally + stdin close + stdout/stderr drain + buffer 上限 + RFC-098 killTree 进程组 kill + 临时目录/凭据 finally 清（§3 步骤6）。 |
| 5 | P2 | 运行时名推广在 API 边界不全 | 新 §4.1：agent 校验改「∈ 已注册名/空」、`/api/runtime/models?runtime=` 改名→protocol 解析、workflow 校验同步。 |
| 6 | P2 | 内置种子 adopt 会固化脏行 | seed 改 **hard-reset** 为精确规范形态（非 adopt），同名非内置行硬覆盖（§1.1）。 |
| 7 | P3 | name 规范未定 | `^[a-z0-9][a-z0-9-]{0,30}$` 小写 URL-safe + trim + 保留内置名（§4）。 |
| 8 | P3 | admin 执行二进制边界未明 | 显式声明 admin=受信本机执行角色（非提权）；binary_path 校验单可执行路径、spawn 用 argv 数组非 shell、写路由 admin-only（§4）。 |

2026-06-27 **实现 gate**（codex-cli read-only，范围限定 RFC-112 实现、排除 RFC-111/其它）。verdict=needs-fix，**4 findings 全部修复 + 各带回归测试**：

| # | 级别 | finding | 修复 |
|---|---|---|---|
| 1 | P1 | retry/clarify-rerun 铸**新** node_run 行但携带前一行 session id，`resolveFrozenRuntime` 在新行重解析（查可变 registry）而非继承——改/删自定义运行时后捕获 session 在错误驱动/二进制上 resume | `nodeRunMint.frozenRuntimeOfSession(sessionId)` 查拥有该 session 的行返其 {protocol,binary}；`resolveFrozenRuntime` 加 `inheritFrom` 参数；主派发点 resume 时传入 → 新行继承源行冻结对、不重解析。回归：fresh retry 行携带 claude session + agent 翻 opencode → 仍冻结 (claude,/opt/v1)。 |
| 2 | P2 | 冒烟超时仅 signal 进程组后等 EOF，逃逸孙进程持管道可 hang；2s SIGKILL timer 未 track/unref | track+clear+unref SIGTERM/SIGKILL 两 timer（finally 清）；drain 改并发 + `await child.exited` 后 `Promise.race([drainAll, 2s])` **bounded flush**——孙进程持管道不再 wedge。 |
| 3 | P2 | `conformed` 用 `(sawNonce ∨ sawEnvelope)` 且 nonce 在裸 stdout 行也算 → 非协议二进制假阳 | nonce/信封**仅在 parsed event text** 检测（去裸行检查）；`conformed` **要求 sawNonce**（信封仅咨询）——证明真按协议吐出且消费了 prompt。回归：emit 信封但不回显 nonce → stream-nonconforming。 |
| 4 | P2 | 内置 claude 探测用 `claudeCodePath`，但 dispatch 走 `['claude']`（RFC-111 未透传）→ 探测与实跑测不同二进制 | 经 `resolveLaunchRuntimeConfig`→`StartTaskDeps.claudeCodePath`→3 派发点→runNode 透传 config.claudeCodePath；claude 分支 head fallback 链 `runtimeBinary ?? runtimeCmd ?? claudeCodePath ?? ['claude']`（自定义 fork 仍 win）——闭合 RFC-111 已知 gap，探测/实跑一致。 |

门禁：typecheck×3 + lint + format + 全量 backend 4151 pass/0 fail。
