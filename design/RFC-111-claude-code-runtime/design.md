# RFC-111 — Claude Code 作为第二运行时（技术设计）

配套 `proposal.md`（决策登记 D1–D14）。本文给接口契约、数据流、与现有模块耦合点、失败模式、测试策略、**待对照实装 claude 验证项**。

---

## 0. 现状调研（事实锚，均经源码 / 实跑核实）

### 0.1 opencode 在 runner.ts 完全硬编码、零抽象

- spawn：`buildCommand`（`runner.ts:1634-1649`）= `['opencode','run',prompt,'--agent',name,'--format','json','--thinking']` + `--dangerously-skip-permissions`（默认）+ 可选 `--session <id>`。prompt 走 **positional argv**。
- env（`runner.ts:722-747`）：`...process.env` + `PWD=worktree` + `OPENCODE_CONFIG_DIR=runDir` + `OPENCODE_CONFIG_CONTENT=JSON(inlineConfig)` + 可选 `OPENCODE_AW_INVENTORY_OUT` + git 身份（`GIT_AUTHOR_*`/`GIT_COMMITTER_*`）。
- spawn：`Bun.spawn({cmd, cwd:worktreePath, env, stdout:'pipe', stderr:'pipe', stdin:'ignore', detached:true})`（`runner.ts:767`）。
- stdout 泵（`runner.ts:879-921`）：逐行 `JSON.parse` → 捕 `evt.sessionID` → `accumulateTokens` → `extractTextFromEvent`（`evt.part.text` / `evt.text`）→ `inferEventKind` → 原始行落 `node_run_events`。
- 收尾：text 事件 join → `extractLastEnvelope` → `parseEnvelope(envelope, agent.outputs)`（`envelope.ts`，**runtime-agnostic**）。exit 0=done / 非 0=failed；`detached` 进程组 `killTree` SIGTERM→SIGKILL；RFC-108 持久化 `spawnBinaryPath=cmd[0]`。
- 注入：`buildInlineAgentEntry`/`buildInlineConfig`（`runner.ts:1455-1547`）→ `OPENCODE_CONFIG_CONTENT` JSON `{agent:{name:{prompt:bodyMd, description, permission, options:{outputs,readonly}, model, variant, temperature, steps}}, mcp, plugin, permission}`；`prepareSkills`（`runner.ts:1374-1393`）managed `cpSync` / external `symlinkSync` 进 `runDir/skills/`，project 跳过自发现。
- 协议块：`renderUserPrompt`（`shared/src/prompt.ts:509-575`）纯提示词，**runtime-agnostic**，无需改。
- 自然接缝：`runNode(opts: RunNodeOptions): Promise<RunResult>`（`runner.ts:378`）。

### 0.2 会话捕获三读者（读 opencode XDG SQLite）= 辅助非承重

`sessionCapture.ts`（RFC-027 worker 后）/ `distillSessionCapture.ts`（RFC-043 蒸馏）/ `subagentLiveCapture.ts`（RFC-048 live poll）经 `opencodeSessionWalk.ts` BFS `session`/`message`/`part` 表，路径 `resolveOpencodeDbPath`（`~/.local/share/opencode/opencode.db`，`sessionCapture.ts:85-103`）。**承重路径是 stdout 泵 + 信封解析**；捕获失败写 `subagent_capture_failed` 标记、不抛、SessionTab 降级。→ claude 用 JSONL 适配同 `node_run_events` + `parseSessionTree`。

### 0.3 Claude Code headless 契约（本机 `claude 2.1.193` 实跑确认）

- `claude -p`（print）；prompt 可 positional 或 **stdin**。`--output-format text|json|stream-json`（仅 `--print`）；`--input-format text|stream-json`。`stream-json` 实践需 `--verbose`。
- stream-json 事件（NDJSON）：`system`(subtype=init：session_id/model/tools/mcp_servers/apiKeySource) / `assistant`(message.content[]、message.usage) / `user`(tool_result) / `result`(subtype/is_error/result/session_id/total_cost_usd/usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}/num_turns/permission_denials/terminal_reason)。
- `--model opus|sonnet|haiku|fable|<full-id>`；`ANTHROPIC_MODEL` env；`--fallback-model`。
- `--system-prompt[-file]`（替换）/ `--append-system-prompt[-file]`（追加）；均 `-p` 可用。
- `--allowedTools, --allowed-tools <tools...>` / `--disallowedTools, --disallowed-tools <tools...>`；`--permission-mode <default|acceptEdits|plan|...>`；`--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`。
- `-r, --resume [id]` / `-c, --continue` / `--fork-session`；`claude -p --resume <id>` headless 续跑。
- `--mcp-config <configs...>`（文件路径 **或** 内联 JSON 串，可重复）；`--strict-mcp-config`。
- `--settings <file-or-json>`；`--agents <json>`（内联定义子代理）；`--add-dir`（CLAUDE.md/上下文目录）；`--plugin-dir`。
- transcript（**本机 claude 2.1.193 实测落盘确认**，2026-06-26；Codex P1-3 正确）：
  - **主**会话 `<configDir>/projects/<cwd-slug>/<session-id>.jsonl`，slug = cwd 把 `/`→`-`。NDJSON，每行 `type` ∈ `{user, assistant, system, attachment, file-history-snapshot, mode, permission-mode, ai-title, last-prompt}`；**对话正文在 `user`/`assistant` 行的 `message`**：`assistant.message.content[].type` ∈ `{thinking, text, tool_use}`、`user` 行含 `tool_result`——**思考 + 工具调用 + 工具结果全在**。DAG 串接靠 `parentUuid`/`uuid`，另有 `sessionId`/`isSidechain`/`timestamp`/`cwd`/`gitBranch`/`requestId`。捕获需**过滤元数据行**（mode/permission-mode/ai-title/last-prompt/file-history-snapshot）。
  - **子代理**会话在 `<session-id>/subagents/agent-<agentId>.jsonl`（**每个子代理一份完整 transcript**，同 schema、含自身 thinking/tool_use）+ 同名 `agent-<agentId>.meta.json` 侧车 `{agentType, description, toolUseId, spawnDepth}`——**`toolUseId` 精确挂回父 transcript 里那次 `tool_use`**（比 parentSessionId 更准）。另有 `<session-id>/tool-results/`（大工具输出外溢）。
  - NDJSON 与 stream-json 大体同构；解析以**真实 fixture** 为准（已取本会话样本）。`CLAUDE_CONFIG_DIR` 整体重定位 `~/.claude`（含 projects/、settings、agents、凭据、全局状态 `~/.claude.json`）——**惟「transcript 是否随 CLAUDE_CONFIG_DIR 重定位到 `<attemptDir>/projects/`」仍需 spawn 实测（V3 残留），布局本身已实证**。
- 鉴权：`ANTHROPIC_API_KEY` env（最简，覆盖订阅）/ 本机 `claude login`（macOS keychain；Linux `~/.claude/.credentials.json`）。本机当前**无 key**、走订阅、`~/.claude` 有 `daemon-auth-status.json` 与 `projects/`。
- exit 0=完成（含工具被拒）/ 非 0=致命；`is_error` = API 错误。`claude --version` → `2.1.193 (Claude Code)`。

### 0.4 multica 已驱动 claude（可借鉴）

`claude -p --output-format stream-json --input-format stream-json --verbose --strict-mcp-config --permission-mode bypassPermissions [--model X] [--resume ID] [--mcp-config FILE]`；`system`/`result` 取 session_id；`Backend.Execute` 单接口 + `agent.New(provider)` 工厂（`server/pkg/agent/agent.go:99-130`、`claude.go`）。

---

## 1. 运行时抽象（D5）

新增 `packages/backend/src/services/runtime/`：

```
runtime/
  types.ts          # RuntimeDriver 接口 + 归一化类型
  index.ts          # getRuntimeDriver(kind) 工厂注册表
  opencode/
    driver.ts       # 抽取自 runner.ts，行为逐字不变
    events.ts       # parseEvent: opencode --format json -> NormalizedEvent
    probe.ts        # = 现 util/opencode.ts
    models.ts       # = 现 util/opencode-models.ts
  claudeCode/
    driver.ts       # claude buildSpawn (argv/env/stdin)
    events.ts       # parseEvent: stream-json -> NormalizedEvent
    probe.ts        # claude --version + MIN_CLAUDE_CODE_VERSION
    models.ts       # 静态精选模型列表
    config.ts       # 每运行 CLAUDE_CONFIG_DIR 镜像 + 凭据桥接
    sessionCapture.ts  # JSONL transcript -> node_run_events
```

### 1.1 接口契约

```ts
export type RuntimeKind = 'opencode' | 'claude-code'

/** 归一化事件：generic 泵只认这个，不认任何运行时原始 JSON 形状。 */
export interface NormalizedEvent {
  kind: NodeRunEventKind          // 复用既有 enum（tool_use/text/reasoning/step_*/error/...）
  text?: string                   // 贡献到 envelope 的可见文本（join 后解析信封）
  sessionId?: string              // 首个出现即捕获
  tokens?: NormalizedTokenDelta   // { input, output, cacheRead, cacheWrite }
  rawLine: string                 // 原样落 node_run_events.payload
}

export interface SpawnPlan {
  cmd: string[]                   // 含 binary head
  env: Record<string, string>
  stdin?: { mode: 'ignore' } | { mode: 'pipe'; data: string }  // D12
  cleanup?: () => void            // 删每运行临时目录/文件
}

export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /** 组装本次 node_run 的进程启动计划（argv/env/stdin/cleanup）。 */
  buildSpawn(ctx: BuildSpawnContext): Promise<SpawnPlan>
  /** 解析一行 stdout 为归一化事件；非事件行返回 text 兜底。 */
  parseEvent(line: string): NormalizedEvent | null
  /** 版本探测 + 最低版本门。 */
  probe(binPath?: string): Promise<RuntimeProbe>
  /** 模型列表（opencode 动态 / claude 静态）。 */
  listModels(binPath: string, opts?: { refresh?: boolean }): Promise<RuntimeModel[]>
  /** 续跑会话的 CLI 形态：opencode '--session' / claude '--resume'（在 buildSpawn 内部用）。 */
  /** 可选：后置 transcript 捕获（opencode=SQLite walk / claude=JSONL）。失败非致命。 */
  captureSession?(ctx: CaptureContext): Promise<void>
}
```

`BuildSpawnContext` 携带 generic 已解析好的所有材料（agent 行 + 闭包成员 + 解析后的 skills + mcp + overrides + worktreePath + runDir + gitIdentity + resumeSessionId + inputPortKinds + 渲染好的 prompt）。**driver 不碰 DB / 不碰 scheduler**，只做「材料 → 进程计划」与「行 → 事件」的纯转换 + 文件系统准备（写 runDir / 镜像目录）。

### 1.2 runner.ts 重构（保持 generic）

`runNode` 改为：

1. `const driver = getRuntimeDriver(resolveRuntime(agent, config))`
2. `const plan = await driver.buildSpawn(ctx)` —— 取代内联 `buildCommand` + env 组装 + `buildInlineConfig` + `prepareSkills`。
3. `Bun.spawn({ cmd: plan.cmd, cwd, env: plan.env, stdin: plan.stdin?.mode==='pipe'?'pipe':'ignore', ... })`，pipe 则写入 `plan.stdin.data` 后 `end()`。
4. stdout 泵：`const evt = driver.parseEvent(line)` → 用 `evt.sessionId/text/tokens/kind/rawLine` 累积（**移除** runner 里的 `evt.sessionID`/`evt.part.text`/`accumulateTokens` 直读）。
5. 收尾、exit→status、kill 升级、reap、信封解析（`extractLastEnvelope`/`parseEnvelope`）、DB 落库 —— **全部 generic 不动**。
6. capture：`await driver.captureSession?.(...)`（替代当前对 `captureChildSessions` 的直调；opencode driver 内部仍调既有 SQLite 实现）。

**不变量**：opencode driver 抽取后，`plan.cmd`/`plan.env` 与现状**逐字相等**（黄金断言锁定）；`accumulateTokens` 改为消费 `NormalizedTokenDelta`，opencode events.ts 负责把现有多形状（含 RFC-103 嵌套 `cache:{read,write}`）归一化，保持累计值不变。

### 1.3 运行时解析 + 冻结（D1 + D15，Codex P1-2）

**解析**（仅在**全新 attempt** dispatch 时调用）：

```ts
// 纯函数，单测三层回退；NULL/缺省 = 合法默认 opencode
export function resolveRuntime(
  agentRuntime: string | null | undefined,
  defaultRuntime: string | undefined,
): RuntimeKind {
  const r = agentRuntime ?? defaultRuntime ?? 'opencode'
  return r === 'claude-code' ? 'claude-code' : 'opencode'
}
```

**冻结**：`resolveRuntime` 的结果在**铸 node_run 行时写入新列 `node_runs.runtime`**（migration，见 §5.2）。

**消费铁律**：`agent.runtime` 与 `config.defaultRuntime` 都**可变**——若 resume/clarify-rerun/retry 时重新解析，可能把上一轮捕获的 **claude session id 喂给 opencode**（或反之），且捕获路径 / CLI flag 全错。故：

- resume / clarify-rerun / 同 attempt 续跑：**读 `node_runs.runtime` 冻结值**，不重解析。
- 全新 attempt（首次 dispatch / 全新 retry 行）：重解析并冻结新值。
- 读到的冻结值若非 `'opencode'|'claude-code'`（数据损坏 / 未来运行时）：**fail-closed**（node `failed`，errorMessage 指明未知 runtime），**不**静默回退 opencode。

session id（`opencode_session_id`，D11）与 `runtime` **成对消费**——driver 由冻结 runtime 选定，再决定 `--session`（opencode）/ `--resume`（claude）。

---

## 2. opencode ↔ claude-code 注入映射（D2 全平价）

| 关注点 | opencode | claude-code |
|---|---|---|
| persona（系统提示） | `OPENCODE_CONFIG_CONTENT.agent.<name>.prompt=bodyMd` + `--agent <name>` | **D6** 写 `bodyMd` 到每运行临时文件 → `--append-system-prompt-file <file>` |
| 模型 | inline `model`（provider/modelID） | `--model <alias|id>`（agent.model 设则透传；否则 `config.defaultClaudeModel` 或省略） |
| variant/temperature | inline 字段 | **不支持**（CLI 无）—— 忽略 + 文档化 |
| 输出端口/信封 | 协议块（runtime-agnostic） | **同一协议块**，零改 |
| readonly | scheduler 写信号量 + inline metadata | scheduler 写信号量（**不变**）+ `--disallowed-tools "Write Edit NotebookEdit"`（D7） |
| 权限/非交互 | `--dangerously-skip-permissions` | `--dangerously-skip-permissions`（D8）；opencode `permission` JSON 忽略 |
| skills | `prepareSkills` 进 `OPENCODE_CONFIG_DIR/skills`（叠加扫描） | **D13** 每运行 `CLAUDE_CONFIG_DIR` 镜像 + `skills/` 叠加；repo 内 `.claude/skills` 自发现、不污染 worktree |
| MCP | inline `mcp` | `--mcp-config '<inline-json>'`（db 形状→claude mcp 形状）+ 视情况 `--strict-mcp-config` |
| dependsOn 闭包 | inline `agent.<dep>` | `--agents '<inline-json>'`：每 dep = `{description, prompt, ...}` |
| 会话续跑 | `--session <id>` | `--resume <id>`（D11 同一 session-id 列） |
| git 身份 | env `GIT_*` | env `GIT_*`（generic 不变） |
| prompt 投递 | positional argv | **stdin**（D12） |
| inventory 插件(RFC-029) | `OPENCODE_AW_INVENTORY_OUT` | 不支持，跳过 |
| plugins(RFC-031) | inline `plugin:[file://]` | 不做（非目标） |

### 2.1 claude buildSpawn argv（基线）

```
claude -p
  --output-format stream-json --verbose            # 事件流（D12）
  --permission-mode bypassPermissions \| --dangerously-skip-permissions   # 非交互（D8，实测择一）
  --model <resolvedModel>                           # 若解析出
  --append-system-prompt-file <runDir>/system.md    # persona（D6）
  --disallowed-tools Write Edit NotebookEdit        # 若 readonly（D7）
  --mcp-config <inline-json> [--strict-mcp-config]   # 若有 mcp
  --agents <inline-json>                            # 若有 dependsOn 闭包
  --resume <sessionId>                              # 若 clarify inline 续跑
# prompt 经 stdin 投递
```

env：`...process.env` + `PWD=worktree` + `CLAUDE_CONFIG_DIR=<attemptDir>/.claude`（D16 每 attempt 持久目录）+ git 身份 + 鉴权（D3，见 §4）。

### 2.2 MCP 形状转换

opencode db mcp 行（`{type, command|url, env, timeoutMs, ...}`）→ Claude Code `--mcp-config` 期望的 `{ mcpServers: { <name>: { command, args, env } | { url, type:'sse'|'http' } } }`。新纯函数 `toClaudeMcpConfig(dbMcps): object`，单测对照两形状。`--strict-mcp-config` 用以避免 repo 内 `.mcp.json` 叠加干扰（与 opencode inline 的「我方胜出」语义对齐）。

### 2.3 dependsOn 闭包 → claude 子代理

复用 scheduler 已算好的闭包成员（agent 行集合）。新纯函数 `toClaudeAgents(closureMembers): object`，每成员 `{ <name>: { description, prompt: bodyMd, model?, tools? } }` → `--agents '<json>'`。注意：Claude Code 子代理是**被主 agent 自主调用**（非平台编排），与 opencode 闭包语义一致（都是「让主 agent 能调到这些角色」）。

---

## 3. 会话 transcript 捕获（D4）

`claudeCode/sessionCapture.ts`：

- 定位（官方布局，Codex P1-3）：用**每 attempt 持久** `CLAUDE_CONFIG_DIR`（D16）`<attemptDir>/.claude`，主会话 `<attemptDir>/.claude/projects/<slug>/<sessionId>.jsonl`，子代理 `<attemptDir>/.claude/projects/<slug>/<sessionId>/subagents/*.jsonl`，`slug` 由 worktree cwd 推导（`/`→`-`）。`sessionId` 来自 stdout stream-json。**双候选兜底**：若实测 `CLAUDE_CONFIG_DIR` 不重定位 `projects/`（仅改配置/凭据，见 V3），回退真实 `~/.claude/projects/<slug>/`，仍按 `sessionId` 精确定位（唯一）。
- 读取（**实测 schema**）：
  - 主 jsonl：取 `user`/`assistant` 行（`message.content[]` 的 thinking/text/tool_use + user 行 tool_result），**过滤** mode/permission-mode/ai-title/last-prompt/file-history-snapshot 元数据行；DAG 用 `parentUuid`/`uuid`。
  - 子代理：遍历 `subagents/agent-*.jsonl` + 读同名 `.meta.json`（`agentType`/`description`/`toolUseId`/`spawnDepth`）；**`toolUseId` 把子代理挂回父 transcript 那次 `tool_use`**（parentSessionId 派生用此而非猜）。
  - 逐行转码为 `node_run_events`（kind 归一化、payload 原行、sessionId/parentSessionId）。
- 喂同一个 `parseSessionTree`（shared）→ SessionTab 平价。
- **真实 fixture 已取**：2026-06-26 已从本机真实 claude 会话取样（主 390 行 + 6 个子代理 jsonl + meta），解析按此核验（非 mock 自造）。
- 失败非致命：写 `subagent_capture_failed` 标记（复用既有 kind）+ warn，不抛。
- live：v1 承重 live 性来自 stdout stream-json（父事件已逐行落库 + WS ping）；子代理 transcript 后置捕获（与 opencode「stdout live + 后置 SQLite」对称）。可选后续：tail jsonl 做 live 子代理。

---

## 4. 鉴权（D3，Codex P1-4）+ 每 attempt 配置目录与信任边界（D16，Codex P1-1/P2-1）

### 4.1 鉴权——不建二元模型，呈现真实来源

Claude Code 鉴权优先级**远不止「key 否则订阅」**，至少含：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / settings 的 `apiKeyHelper` / 云厂商 env（Bedrock `CLAUDE_CODE_USE_BEDROCK`、Vertex `CLAUDE_CODE_USE_VERTEX` + 各自凭据）/ 本机 `claude login` 订阅。因子进程 env 透传 `...process.env`，**上述任一运维注入的 env 都可能静默胜出**。

设计：
- **不**在平台侧推断「用了哪种鉴权」；**鉴权来源以 probe/`system.init` 事件上报的 `apiKeySource` 为准**透出到设置卡（避免误诊真实部署）。**实测注意**：订阅鉴权成功时 `apiKeySource` 仍报 **`none`**（它只表「是否用了 API KEY env」，非「是否已鉴权」）——故设置卡「可用性」判定要结合一次 probe 实跑的 `is_error`（exit 0 / `is_error=false` 才算真可用），不能只看 `apiKeySource`。
- daemon **不**持久化任何 key 明文：`config.ts` 仅存「是否启用 claude」+ 可选 `claudeCodePath`；所有凭据 env 由**运维注入 daemon 进程环境**透传，不落 config.json。
- 文档化「运维注入的鉴权 env 会覆盖订阅」这一行为，让部署者知情。

### 4.2 每 attempt 配置目录 + 凭据桥接（信任边界收紧）

`claudeCode/config.ts` `prepareClaudeAttemptDir(task,node,retryIndex)`：

1. **生命周期（P1-1）**：目录键 `(task,node,retryIndex)`，**跨同 attempt 的 clarify 轮复用、不在每次 spawn 后删**——否则 `--resume` 找不到上一轮会话文件。随 worktree GC 一并清理（终态后）。
2. **仅白名单桥接凭据（P2-1，✅ 本机实测 2026-06-26 验证）**：重定位 `CLAUDE_CONFIG_DIR` **会打断订阅鉴权**（空目录→`Not logged in`，`is_error=true`，exit 1）；**拷 `~/.claude.json`（含 `userID`/`oauthAccount`）不足以恢复**。**有效且唯一需要的桥接 = 在 `<attemptDir>/.claude/.credentials.json` 放订阅凭据 JSON**（`{"claudeAiOauth":{accessToken,refreshToken,expiresAt,subscriptionType,…}}`），实测放上后 exit 0、`PONG`、正常计费：
   - **Linux**：复用真实 `~/.claude/.credentials.json`（软链/拷贝，存在才桥）。
   - **macOS**：凭据在 keychain 项 `Claude Code-credentials`（**不随目录走、故必须显式取出**）；`security find-generic-password -s "Claude Code-credentials" -w > <attemptDir>/.claude/.credentials.json`（0600）。
   - **绝不**镜像用户 `settings.json` / `agents/` / `plugins/` / hooks / `~/.claude.json` 全量——这些会把用户 hook、env 覆盖、MCP/plugin 行为、权限策略注入无人值守 daemon 跑，越过信任边界。
   - **安全：** 该桥接把短期 token 落到 attempt 目录磁盘 → 文件 0600 + 目录 0700 + 终态即随 worktree GC 清；**daemon 首选 env 鉴权**（`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`，见 §4.1，与目录正交、不落盘、不碰 keychain）；keychain 提取仅作「纯订阅、无 env」兜底，且首次访问可能触发 keychain 解锁/授权（运维须知）。
3. **平台自带最小 settings**：用 `--settings '<平台最小 JSON>'` 显式提供本次运行所需设置（而非继承用户全局），`--strict-mcp-config` 隔离 MCP。
4. **技能**：managed 拷贝 / external 软链到 `<attemptDir>/.claude/skills/`（同 opencode 语义）。
5. **目录权限**：`<attemptDir>` 0700；软链与写入限定在该目录内（防越界）。

> API key 路径与 `CLAUDE_CONFIG_DIR` **完全正交**（env 胜出、无需桥接）——首选、最干净。订阅路径按上方 `.credentials.json` 桥接，**已 §6 V2 实测验证**（macOS keychain 取 + Linux 文件复用，单文件足矣）。

---

## 5. 配置 / 路由 / 前端

### 5.1 config schema（`shared/src/schemas/config.ts`）

新增：`defaultRuntime: z.enum(['opencode','claude-code']).optional()`（默认 opencode）、`claudeCodePath: z.string().min(1).optional()`、`defaultClaudeModel: z.string().min(1).optional()`。既有 opencode 字段不动。

### 5.2 DB（`db/schema.ts` + migration）

两列，单次 migration（手写 SQL；本仓 0013 起停用 drizzle generate；新增 `00NN_rfc111_runtime.sql` + journal idx 顺延 + upgrade-rolling 测试同步）：

- `agents.runtime: text`（可空，NULL=继承 `defaultRuntime`）。存量 agent `runtime=NULL` → 解析 opencode，**零行为变化**。
- `node_runs.runtime: text`（可空；**铸行时冻结** `resolveRuntime` 结果，D15/Codex P1-2）。存量行 NULL → resume 时按 opencode 解读（与历史一致：旧行只可能是 opencode），**零行为变化**。新行恒写非空。

> 与并行的 RFC-108（migration 0052）/ 其它在途迁移**编号顺延不抢占**；按本仓惯例 push 前查最新 journal idx 再定 `00NN`。

### 5.3 routes（`routes/runtime.ts` 泛化）

- `GET /api/runtime/opencode` 不动（兼容）。
- `GET /api/runtime/claude` 新增：`{ binary, version, compatible, incompatibleReason, minVersion, apiKeySource }`。
- `GET /api/runtime/models?runtime=opencode|claude`（默认 opencode 兼容旧调用）：分派到对应 driver.listModels；claude 返回静态列表。
- 既有 `runtime:read` 权限门不变。

### 5.4 daemon 启动门（`cli/start.ts`）

opencode 探测 + 硬失败**不动**（D10）。其后**软探测** claude：仅当 `defaultRuntime==='claude-code'` 或库中存在 `runtime='claude-code'` 的 agent 时，探测失败给醒目 warn（不退出）。**spawn 前硬门**：`runNode` 解析到 claude 运行时却 probe 不兼容 → node 直接 `failed`（errorMessage 指明「claude 不可用/版本过低」），不进 spawn。

### 5.5 前端（公共组件优先，CLAUDE.md 前台统一风格）

> **暴露门控（D17/Codex P2-3）**：下列用户可见的 claude 选择/状态卡在**注入平价（PR-C）+ 捕获（PR-D）齐活前不接入用户路径**——用 feature-flag（`config.claudeCodeEnabled` 或编译期常量）默认关，PR-D 收尾翻开。PR-B 期只落组件 + mock e2e，不让用户在半成品期选到残缺 claude。

- **Agent 表单**（`AgentForm.tsx`）：新增「运行时」`<Select>`（opencode / claude-code，默认空=继承全局）。选 claude 时模型字段切到 claude 命名空间（`<ModelSelect runtime="claude">`），隐藏 variant/temperature（claude 不支持，置灰 + hint）。
- **设置 → Runtime**（`settings.tsx` RuntimeTab）：opencode 状态卡**不动**，**新增 claude `<RuntimeStatusCard runtime="claude">`**（复用同组件加 `runtime` prop 最小扩展），显示版本/最低版本/鉴权来源；新增 `defaultRuntime` `<Select>` 与 `defaultClaudeModel` `<ModelSelect runtime="claude">`。
- **ModelSelect**（`ModelSelect.tsx`）：加 `runtime` prop，查 `/api/runtime/models?runtime=`；claude 静态列表 + 既有自定义值兜底。
- **i18n**：runtime/claude 相关 key 中英对称。
- **NodeInspector** 模型覆盖：保持现状（节点不覆盖运行时，D1）；若该节点 agent 是 claude，模型覆盖下拉用 claude 命名空间（按 agent.runtime 派生）。

---

## 6. 失败模式 & 待验证项（对照实装 claude）

> 按本仓「opencode 源码自取规则」同理：**Claude Code 运行时行为以实装为准**，下列 V* 在实现期用本机 `claude` 实跑核实，结论引用到 design 收尾。

- **V1 — stream-json 事件字段（✅ 本机实测 2026-06-26）**：`claude -p --output-format stream-json --verbose` 跑通；事件 `type` ∈ `{system(subtype=init), assistant, result}`，**session_id**（snake_case）在每个事件都有；`result.usage` 键 = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation, server_tool_use, service_tier, …}`；`system.init` 带 `apiKeySource`/`model`。`--verbose` 与 `--print` 同用工作正常（保留带之）。残留：`--verbose` 是否**强制**未单独测（带着无害，固定带）。缓解：events.ts 多形状容错 + 真 fixture 单测。
- **V2 — CLAUDE_CONFIG_DIR 凭据桥接（✅ 本机实测 2026-06-26 闭合）**：重定位到空目录 → 订阅鉴权**断**（`Not logged in`/`is_error=true`/exit 1）；拷 `~/.claude.json` **无效**；**写 `<attemptDir>/.claude/.credentials.json`（macOS 从 keychain `security find-generic-password -s "Claude Code-credentials" -w` 取 / Linux 复用同名文件）→ exit 0、`PONG`、正常计费**。结论：**仅桥接这一个文件即可**，无需镜像 settings/agents/plugins/hooks（信任边界达成）。残留：daemon 以 root 跑时 keychain 访问行为 + env-token（`CLAUDE_CODE_OAUTH_TOKEN`）免落盘路径（首选，未单测）。缓解：首选 env 鉴权；订阅兜底按实测 `.credentials.json` 桥接；两路径 e2e。
- **V3 — transcript 落点（✅ 本机实测 2026-06-26 闭合）**：transcript **确实随 `CLAUDE_CONFIG_DIR` 重定位**——落 `<attemptDir>/.claude/projects/<slug>/<sid>.jsonl`（非真实 `~/.claude`）；布局 = 主 `<slug>/<sid>.jsonl` + 子代理 `<slug>/<sid>/subagents/agent-*.jsonl`+`.meta.json`〔`toolUseId` 挂回父〕 + `tool-results/`（schema 见 §0.3/§3）。**故每 attempt 持久目录 → transcript 天然隔离、捕获直读该目录**。`--resume` 亦从该持久目录命中（见下「P1-1 实测」）。缓解保留按 sessionId 双候选兜底（防未来版本变动）。
- **V4 — readonly 工具门禁名**：确认 Claude Code 写类工具精确名（`Write`/`Edit`/`NotebookEdit`/`MultiEdit`?）。**失败模式**：名错 → readonly 形同虚设。缓解：写信号量是真护栏（D7）；工具门禁尽力 + 单测断言 argv。
- **V5 — `--agents` / `--mcp-config` 内联 JSON 上限与转义**：超大闭包/many-MCP 时内联 JSON 经 argv 可能撞 `E2BIG`。**失败模式**：spawn 失败。缓解：prompt 已走 stdin（D12）省下主要体积；`--mcp-config`/`--agents` 支持文件路径形态作回退（写临时文件传路径）。
- **V6 — `--dangerously-skip-permissions` vs `--permission-mode bypassPermissions`**：实测 headless 非交互不挂起的最稳形态（multica 用后者）。**失败模式**：选错 → 子进程等待权限输入挂死。缓解：实测择一 + per-node 硬超时（RFC-108 已接线）兜底。
- **V7 — `MIN_CLAUDE_CODE_VERSION`**：实测本机 `2.1.193` 各 flag 齐备，钉一个保守下限（如 `2.0.0`），随能力回归再调。
- **V8 — exit/`is_error` 语义（✅ 部分实测）**：实测 `is_error=true`（如未鉴权）→ **exit 1**；`is_error=false` → **exit 0**。映射进 generic exit→status 时**须同时看 `result.is_error`**（不能只看 exit；且鉴权失败这类「软错误」也走 is_error=true/exit 1）。残留：工具被拒时 exit 是否仍 0（需带工具的跑验）。
- **V9 — headless 运维上限（Codex P2-5）**：① 官方文档 piped stdin **上限 10MB**——D12 用 stdin 规避 argv `E2BIG`，但超大 prompt 仍会撞 stdin 上限。**失败模式**：超限 spawn/投递失败。缓解：投递前测 prompt 字节数、超限显式 node failed 报清晰原因（而非神秘挂死）；与 opencode argv 上限对称记为已知边界。② `--dangerously-skip-permissions` 在 **root/sudo** 下且非「可识别沙箱」环境时**会拒绝运行**。**失败模式**：daemon 以 root 跑 → claude 节点全失败。缓解：启动 / spawn 前 preflight 探测（uid==0 且非沙箱 → 改用 `--permission-mode` 替代形态或醒目报错）；与 V6 一并实测择定最稳非交互形态。

### 6.1 实测验证记录（2026-06-26，本机 claude 2.1.193，最小 `claude -p --model haiku` 真实跑）

四次最小实验（纯文本提示、无工具、临时 cwd、用后即删含 token 的临时目录），一次性闭合多个最高风险点：

1. **重定位 + 空目录** → 订阅鉴权断（`Not logged in`/exit 1）、transcript 落**重定位目录** `<cfg>/projects/<slug>/<sid>.jsonl`（V3 ✅）。
2. **重定位 + 拷 `~/.claude.json`** → 仍 `Not logged in`（证明账户态文件不足，V2）。
3. **重定位 + 写 `.credentials.json`（keychain 取）** → **exit 0 / `PONG` / 正常计费**（V2 ✅ 桥接机制定论）。
4. **复用同持久目录 + `--resume <sid>`** → **exit 0、答出上一轮的 `PONG`、session_id 与上轮相同**（**P1-1 ✅ 闭合**：持久重定位目录下 clarify-inline 续跑成立）。

**净结论**：D16「每 attempt 持久 `CLAUDE_CONFIG_DIR` + 仅 `.credentials.json` 桥接」在本机**端到端验证可行**——鉴权、transcript 隔离捕获、`--resume` 续跑三者同时成立。剩余 V 项（V4/V5/V6/V7/V9 + V1 verbose 强制性 + env-token 免落盘）留实现期补测。

---

## 7. 与现有模块耦合点

- **runner.ts**：最大改动面（委派化）；安全关键（RFC-098 kill 升级 / RFC-108 spawn 身份 / RFC-026 续跑），故 **PR-A 行为不变抽取 + 黄金断言 + 全量回归**先行。
- **scheduler.ts**：`pickOverrides` / 写信号量 / 闭包解析 **不动**；仅在传给 runner 的 ctx 里多带 runtime（由 agent 派生）。
- **shared/prompt.ts**：信封/协议块 **零改**（runtime-agnostic）。
- **lifecycle / 状态机**：node_run / task 状态 **不动**；claude 节点复用同转移表。
- **mock harness**：现有 `mock-opencode`（`opcodeCmd` 注入 + `MOCK_OPENCODE_RAW_AGENT_TEXT`）→ 新 `mock-claude`（emit stream-json on stdout，支持注入原文/分片/session id）。driver 的 cmd head 可被测试覆盖（泛化 `opts.opencodeCmd` 为 `opts.runtimeCmd`）。
- **commitPush / distiller / fusion / skill-merger**：内部 agent，**留 opencode**（D14），不改。
- **embed.generated / pluginInstaller / opencode-plugin**：opencode 专属，claude 路径不触达。

---

## 8. 测试策略（CLAUDE.md test-with-every-change：每条先红后绿）

**PR-A（抽取，行为不变）**
- 全量后端回归绿（无退化即证抽取无害）。
- 新 `runtime-opencode-golden.test.ts`：给定固定 agent/skills/mcp，断言 `buildSpawn()` 的 `cmd`/`env`**以及 spawn 选项**（`detached`/`stdin` 模式/`cwd`/`stdout|stderr:'pipe'`）与抽取前**逐字相等**（硬锁）。
- **黑盒行为回归（Codex P2-2，cmd/env 黄金断言之外的安全关键路径必须各有专测，证「行为不变」非仅「字符串不变」）**：
  - kill 升级：SIGTERM→grace→SIGKILL **进程组**（负 pid）路径不变；child-unkillable 收尾。
  - spawn 身份持久化：`pid` + `spawnBinaryPath=cmd[0]`（RFC-108 AR-14）落库不变。
  - 续跑：`resumeSessionId` 透传到正确 CLI flag；缺失回退不续跑。
  - capture 调度：`driver.captureSession?` 在 exit 后被调一次、失败非致命（marker 行）。
  - 事件落库：stdout/stderr 行 → `node_run_events`（kind/payload/sessionId）顺序与计数不变；token 累计值不变。
- `accumulateTokens` 归一化等价测试（含 RFC-103 嵌套 cache）。
- `resolveRuntime` 三层回退 + 未知值单测；`node_runs.runtime` 铸行冻结 + resume 读冻结 + 未知值 fail-closed（D15）。

**PR-B（claude core + config/probe/models/UI/DB）**
- `claude-events.test.ts`：stream-json fixture → NormalizedEvent（session_id / text / tokens / kind）。
- `claude-buildspawn.test.ts`：argv 含 `-p`/`--output-format stream-json`/`--model`/`--append-system-prompt-file`；stdin=prompt；env 含 `CLAUDE_CONFIG_DIR` + 鉴权分支（有/无 key）。
- `claude-probe.test.ts`：`claude --version` 解析 + MIN 门 + 不兼容原因。
- mock-claude e2e：单 agent claude 节点产端口；Code→Audit→Fix（纯 claude / opencode+claude 混用）。
- 前端：AgentForm 运行时选择器切命名空间 + 隐藏 variant/temp；RuntimeStatusCard claude 卡；ModelSelect runtime 分派；i18n 对称。
- DB：migration 前后 `runtime=NULL` 解析 opencode；upgrade-rolling journal 顺延。

**PR-C（注入平价）**
- skills：managed 拷贝 / external 软链进 `<attemptDir>/.claude/skills`；worktree git status 干净断言；repo 内 skill 自发现不破坏。
- mcp：`toClaudeMcpConfig` 形状转换；argv 含 `--mcp-config`。
- subagents：`toClaudeAgents` 闭包→`--agents` JSON。
- readonly：argv 含 `--disallowed-tools` 写工具；写信号量路径不变。
- 续跑：clarify inline 重跑 argv 含 `--resume <id>`；session id 捕获→落 `opencode_session_id`（通用）。

**PR-D（transcript 捕获）**
- JSONL fixture（主 + 子代理）→ `node_run_events` → `parseSessionTree` → SessionTab 树。
- 捕获失败 → `subagent_capture_failed` 标记、不抛、编排继续。

**门禁**：typecheck×3 + 后端 bun test + 前端 vitest + format + `build:binary` smoke（新 migration 嵌入 + 无模块环）。Codex 设计 gate（本文）+ 实现 gate（每 PR）各 fold。

## 9. 推出顺序与回退

- 强序 PR-A→B→C→D；每 PR 独立可上、独立测试绿。
- PR-A 纯重构、零行为变化，可单独合入而不暴露 claude 能力（特性门：无 claude agent 即走原路径）。
- 回退：`defaultRuntime` 不设 + 无 agent 选 claude → 系统行为与今日**完全一致**；claude driver 不被触达。

## 10. Codex 设计 gate fold 记录

2026-06-26 第一轮（codex-cli 0.141.0，read-only，联网核对官方 Claude Code 文档；范围严格限定 RFC-111 三件套、显式排除工作树中协作者的 RFC-108 代码）。verdict=needs-rework，**8 findings 全部采纳**：

| # | 级别 | finding | 处置 |
|---|---|---|---|
| 1 | P1 | 每运行私有 `CLAUDE_CONFIG_DIR` 跑完即删 → `--resume` 找不到会话文件 | 改**每 attempt 持久目录**（D16/§4.2），跨 clarify 轮复用、GC 时清；resume 命中保证。验收 #5 + 真实续跑 e2e。 |
| 2 | P1 | runtime 由 node→agent 派生**不稳定**（agent/默认可变）→ resume 跨 runtime 错配 session id | 新增 **`node_runs.runtime` 冻结列**（D15/§1.3/§5.2）；resume 读冻结、未知值 fail-closed；session id 与 runtime 成对消费。 |
| 3 | P1 | transcript 子代理布局错（实为 `projects/<slug>/<id>/subagents/`）+ 需真 fixture | 修 §0.3/§3 为官方布局 + 双候选兜底；强制**真实 claude fixture** 核验（V3）。 |
| 4 | P1 | 鉴权非二元（还有 `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`/`CLAUDE_CODE_OAUTH_TOKEN`/云厂商 env）；状态卡推断会误诊 | 重写 §4.1：列全优先级、**来源以 probe `apiKeySource` 上报为准**、不推断（D3 修订）。 |
| 5 | P2 | D13 镜像用户 settings/agents/plugins/hooks → 越信任边界 | 收紧为 **D16 白名单：仅桥接凭据 + 平台自带最小 `--settings` + `--strict-mcp-config`**，不镜像 hooks/plugins/agents/`~/.claude.json`；目录 0700。 |
| 6 | P2 | PR-A 黄金断言不覆盖 spawn 选项/kill/spawn 身份/capture/resume/落库 | §8 PR-A 增**黑盒行为回归**（kill 升级 / spawn 身份 / 续跑 / capture / 事件落库 / spawn 选项逐字）。 |
| 7 | P2 | PR-B 在注入平价前暴露半成品 claude 选择器 | 新增 **D17：用户可见 claude 选择器 gate 到 PR-C/D 齐活后**（PR-B 仅驱动核心 + DB + mock e2e，UI 末位/flag）。 |
| 8 | P2 | readonly 过度承诺（漏 MultiEdit/Bash/MCP；写信号量非沙箱）| D7 改**显式 best-effort 工具门禁、非沙箱保证**；broaden disallowed 集（V4）；验收 #4 不强保证。 |
| + | P2 | headless 运维上限（stdin 10MB / `--dangerously-skip-permissions` 拒 root）缺失 | §6 增 **V9**：stdin 10MB 上限 preflight + root/sandbox preflight。 |

（实现 gate 各 PR 复审 findings 后续在此追加。）
