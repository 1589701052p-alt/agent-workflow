# RFC-073 opencode Subagent Permission / Question 交互死锁根治 — Design（技术设计）

状态：**Done**

> 本 RFC 涉及 opencode 运行时行为，所有断言均以本机 opencode 源码核实，下文标注 `文件:行号`。实现前请按 [opencode 源码自取规则] 复核一遍当前版本未漂移。

## 0. 现状梳理（代码锚点）

### 0.1 agent-workflow 侧

- `services/runner.ts:buildCommand`（`:1421-1436`）：`opencode run <prompt> --agent <name> --format json --thinking`；`:1427` 默认追加 `--dangerously-skip-permissions`（`?? true`）。
- `services/runner.ts` env 构造（`:699-717`）：设 `PWD` / `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_AW_INVENTORY_OUT` / `GIT_*`，**无 `OPENCODE_PERMISSION`**。
- `services/runner.ts:buildInlineConfig`（`:1276-1334`）：返回 `{ agent, mcp?, plugin? }`，**无顶层 `permission`**。
- `services/runner.ts:buildInlineAgentEntry`（`:1253-1274`）：注入 `agent.<name>` = `{ prompt, description, permission: agent.permission, options, model?, variant?, temperature?, steps? }`；`agent.permission` 默认 `{}`（`shared/schemas/agent.ts`：`permission: AgentPermissionSchema.default({})`）。
- stdin 为 `'ignore'`（`:750`），只读 stdout（`:819-861`）→ **无反向通道**。`inferEventKind`（`:1495-1509`）有 `permission_asked` 分类，但 `opencode run` 的 stdout 不产出该事件（死分类）。

### 0.2 opencode 侧（运行时权威）

- **默认裁决 = ask**：`permission/evaluate.ts:14` `return match ?? { action: "ask", permission, pattern: "*" }`。
- **全局 permission 注入点**：`config/config.ts` —— `Flag.OPENCODE_PERMISSION`（读 `process.env`）与 inline config 顶层 `permission` 都经 `mergeDeep` 进 `result.permission`（全局 `config.permission`）。
- **全局 permission 进入每个 agent**：`agent/agent.ts:124` `const user = Permission.fromConfig(cfg.permission ?? {})`；`:290` 自定义 agent（`cfg.agent.*`，即 agent-workflow 注入的）base = `Permission.merge(defaults, user)`；`:306` 再 `merge` agent 自己的 `permission` override。
- **evaluate / 工具门禁用的 ruleset**：`session/prompt.ts` 的 `ctx.ask` ruleset = `Permission.merge(agent.permission, session.permission)`；`session/llm.ts:439-444` `resolveTools` 的 disabled ruleset 同样 = `Permission.merge(input.agent.permission, input.permission)`。**两者都用"当前 session 的 agent.permission"**，而 agent.permission 已含全局 `user`。
- **permission.ask 阻塞**：`permission/index.ts:161-196`，命中 `ask` → `bus.publish(Event.Asked)` + `Deferred.await`；只有 `reply()` 或进程销毁 finalizer 解阻塞。
- **CLI run 应答盲区**：`cli/cmd/run.ts:706-726` 只应答 `permission.sessionID === sessionID`（根）；`:708` `continue` 跳过子 session；全文件无 `question.asked` 分支。
- **question 工具门禁**：`session/llm.ts:444` `Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))`；`Permission.disabled`（`permission/index.ts:293-302`）：对工具 `k`，`ruleset.findLast(r => Wildcard.match(k, r.permission))`，若该规则 `pattern === "*" && action === "deny"` → 禁用。
- **question 工具本身**：`tool/question.ts` → `question/index.ts:81` `question.asked` BusEvent + 阻塞 `Deferred`；不经 `Permission.ask`，但**受 `disabled("question", ruleset)` 控制能否出现在工具列表**。
- **subagent 相关**：`tool/task.ts:147` 子 session `parentID = ctx.sessionID`；`:196-200` subagent 的 `tools` 由 task 工具**单独构造**（只塞 `todowrite`/`task`/`primary_tools` 开关），**不继承 agent config 的 `tools` 字段**；`agent/subagent-permissions.ts:28-30` 只转发父 session 的 `external_directory` 规则 + 所有 `deny` 规则（不转发 `allow`）。

### 0.3 clarify（反问）与 question 工具的正交性

- 反问要求由 framework 在 prompt 注入：`shared/clarify.ts:buildClarifyPromptBlock`（`:236`）/ `renderClarifyDirectiveTrailer`（`:280-293`），反复要求 agent **"emit another `<workflow-clarify>` envelope"**。
- 收集走 `shared/clarify.ts:parseClarifyEnvelopeBody`（`:81`）解析 agent stdout 里的 `<workflow-clarify>` XML → `services/clarify.ts` 转 `awaiting_human`。
- 经核查，agent-workflow 的 prompt 体系**无一处**引导 agent 使用 opencode `question` 工具。故禁用 `question` 工具与反问节点完全正交。

## 1. 设计概览

在 opencode 子进程的**全局** `config.permission` 注入：

```jsonc
{ "*": "allow", "question": "deny" }
```

- `"*": "allow"` → `evaluate` 对所有 permission/所有 session 命中 allow → `ask()` 在 `needsAsk=false` 处直接 return（`permission/index.ts:178`）→ **根本不发 `permission.asked`**。彻底解决 §0 的死锁链第 1-4 步。
- `"question": "deny"` → `resolveTools` 的 `disabled` 把 `question` 从模型可见工具列表摘除（`llm.ts:444`）→ 模型看不到 → 不调用 → **不发 `question.asked`**。解决第 5 步。
- **覆盖所有层 subagent 的机理**：全局 `config.permission` 经 `agent.ts:124/290` 进入**每个** agent 的 `agent.permission`；而 `prompt.ts` 的 `ctx.ask` 和 `llm.ts:resolveTools` 在**每个 session（含任意层 subagent）** 都用"该 session 的 agent.permission"重新计算。因此覆盖不依赖 subagent 的继承转发（`subagent-permissions.ts` 只转发 `external_directory`/`deny`，转发不了 `allow`，但**我们不靠转发**——靠的是每个 agent.permission 自带全局 allow）。

## 2. 实现

### 2.1 注入点：`OPENCODE_CONFIG_CONTENT` 顶层 `permission`（推荐）

`services/runner.ts:buildInlineConfig`（`:1276-1334`）的返回类型与构造体加一个顶层 `permission`：

```ts
// 模块级常量，集中定义、单测可断言。
// 顺序关键：'*' 在前、'question' 在后（见 §2.2）。
export const AW_GLOBAL_PERMISSION = { '*': 'allow', question: 'deny' } as const

// buildInlineConfig 返回值类型增加：
//   permission?: Record<string, unknown>
// 构造末尾：
out.permission = AW_GLOBAL_PERMISSION
```

`OPENCODE_CONFIG_CONTENT` 是 opencode config 合并链里**优先级最高**的来源（CLAUDE.md「Resolved open questions」已述：merge 在所有目录扫描之后）。顶层 `permission` 经 `config/config.ts` 进入全局 `config.permission` → `agent.ts:124` 的 `user`。

> **等价备选**（与 multica 完全一致）：在 env 注入 `OPENCODE_PERMISSION={"*":"allow","question":"deny"}`（`runner.ts:699-717` 的 env map 加一行）。两者都汇入全局 `config.permission`，效果等价。选 inline config 的理由见 §5 D1。实现时二选一即可，**不要两条都设**（避免双源混淆）。

### 2.2 顺序敏感性（必须处理）

`Permission.disabled` 用 `findLast`：对 `question`，ruleset 里 `{permission:"*",action:"allow"}` 与 `{permission:"question",action:"deny"}` **都匹配**，取**最后一条**。

- 正确顺序 `[{*,allow},{question,deny}]` → `findLast` = `{question,deny}` → `pattern==="*" && action==="deny"` → **禁用**。✓
- 顺序写反 `[{question,deny},{*,allow}]` → `findLast` = `{*,allow}` → `action!=="deny"` → **不禁用**。✗

`fromConfig`（`permission/index.ts:273-285`）按 `Object.entries` 顺序展开，JS 对象非整数字符串 key 保插入序，`JSON.stringify` 亦保序。故 `AW_GLOBAL_PERMISSION` 字面量里 `question` 写在 `*` 之后即可。**用单测把这条顺序锁死**（AC2），防未来有人「整理」对象 key 时无意重排。

### 2.3 防 question 工具复活（AC3）

`agent.ts:306` 会把 agent 自己的 `permission`（即 agent-workflow 注入的 `agent.<name>.permission`，优先级最高）merge 到最后。若某 agent 的 `permission` 显式含 `question:"allow"`，会盖掉全局 `question:"deny"`。

- 守卫：`buildInlineAgentEntry` 注入 `agent.permission` 时，集中校验/清洗——若用户 agent 定义里出现 `question` 键，记 warning 并丢弃该键（与 `agent-md.ts` 既有 frontmatter 清洗同模式），保证注入的 `agent.<name>.permission` 永不含 `question:"allow"`。
- 单测锁此不变量（AC3）。

### 2.4 与 `--dangerously-skip-permissions` 的关系

保留（`runner.ts:1427` 不动）。它对根 session 是无害冗余；`*:allow` 已经让 permission 不触发，两者不冲突。移除它没有收益、反增回归面，故**保留**。

### 2.5 （可选）根 session 双保险 `tools.question=false`

`buildInlineAgentEntry` 可额外注入 `tools: { question: false }`（命中 `llm.ts:444` 的 `user.tools[k]!==false` 那条）。但注意：subagent 的 `tools` 由 `task.ts:196-200` 单独构造、**不继承 agent config 的 tools**，故该手段**对 subagent 无效**，仅作根 session 双保险。真正覆盖所有层的是 §2.1 的 `question:"deny"`（走 `disabled`，每 session 重算）。列为可选，默认可不做。

## 3. 与现有模块的耦合点 / 失败模式

- **OPENCODE_CONFIG_CONTENT 合并优先级**：顶层 `permission` 经 `config.ts` mergeDeep，inline 优先级最高，覆盖 repo `.opencode/config.json` 与 `~/.opencode/` 的 permission。符合现有「平台注入总是赢」契约。
- **失败模式 A（用户显式 deny）**：用户在 repo `.opencode/config.json` 把某 permission key 设 deny。inline 顶层 `*:allow` 与之经 `findLast` 交互；更具体的 key 规则可能覆盖 `*`。**这是用户显式意图，尊重之**——本 RFC 只保证「默认空配置不卡」，不强行用 `*:allow` 碾压用户的显式 deny（否则反而违背用户安全意图）。
- **失败模式 B（多层 subagent 的 external_directory 残余）**：`subagent-permissions.ts:28-30` 把父 session 的 `external_directory` 具体规则转发给子；叠加 `evaluate` 的 `findLast`，理论上极少数 `external_directory` 路径规则可能排在全局 `*:allow` 之后被命中。但：① 全局 `*:allow` 在每个 agent.permission 里都有；② 实测的 `bash` 越界场景，`disabled`/`ask` 都因 `*:allow` 放行；③ multica 生产用同款方案。残余风险用 §4 集成测试覆盖；若真出现，回退到「按 key 显式 allow external_directory」。
- **失败模式 C（question 复活）**：见 §2.3，由守卫 + 单测兜住。
- **clarify 正交**：禁 question 工具不影响 `<workflow-clarify>` envelope 路径（§0.3）。反而堵死「agent 误用 opencode question 工具 → 卡死且框架收不到反问」的歧路。

## 4. 测试策略（test-with-every-change）

### shared / backend 单元（必写）
- `buildInlineConfig` 返回值含顶层 `permission`，深度等于 `AW_GLOBAL_PERMISSION`。
- **顺序锁**（AC2）：`JSON.stringify(buildInlineConfig(...).permission)` 中 `"question"` 的下标 > `"*"` 的下标。直白断言序列化后子串位置，防 key 重排。
- **防复活锁**（AC3）：对一个 `permission` 含 `question:"allow"` 的 agent 定义跑 `buildInlineAgentEntry`，断言产物的 `permission` 不含 `question:"allow"`（被清洗）+ 产生 warning。
- env / config 注入路径断言：runner 构造的 inline config（或 env，取决于 §2.1 选型）含目标 permission。

### clarify 回归（必写，AC5）
- 纯函数：`parseClarifyEnvelopeBody` 对样例 `<workflow-clarify>` body 正常解析（既有用例保持绿）。
- 正交锁：源码层断言 clarify 路径（`shared/clarify.ts` / `services/clarify.ts`）不引用 opencode `question` 工具（grep guard：这些文件里的 "question" 仅指 `ClarifyQuestion`）。
- 端到端：既有 clarify / clarify-cross-agent 流程测试在「question 工具被禁」配置下仍进入 `awaiting_human`。

### 集成 / 死锁回归（AC4）
- 优先：mock-opencode 或真 opencode 实跑一个会触发越界 `bash`（`cd /tmp && pwd`）的 agent + 一个会调 `question` 工具的 agent，断言子进程在远小于 timeout 的时间内正常退出、`node_runs.status` 非 `node-timeout`。
- 若实跑不稳定（环境/版本）：退化为「注入形态单元断言 + 源码锚点断言」，并在测试注释里写明降级原因 + 关联本 RFC。**不允许「重跑就过」当通过依据**。

### gate
- `bun run typecheck && bun run test && bun run format:check` 全绿；CI 三项 + build smoke + e2e 绿；推后按 [feedback_post_commit_ci_check] 查 Actions。

## 5. 决策记录

- **D1（注入点 inline config vs env）**：选 inline config 顶层 `permission`。理由：`buildInlineConfig` 已是集中、可单测的构造点，避免再扩 env 传递面；语义与 env 完全等价（都进全局 `config.permission`）。env 形式（multica 同款）作等价备选保留，二选一、不并设。
- **D2（不做 server 模式）**：multica 证明 opencode 用全局 permission 即可根治，server 模式是后续可选增强（可观测性 / 人工审批），不在本 RFC 范围。
- **D3（question 用 permission `deny` 而非 `tools.question=false`）**：后者对 subagent 无效（`task.ts` 单独构造 subagent tools）；`permission` 走 `disabled`，每 session 重算，覆盖所有层。
- **D4（保留 `--dangerously-skip-permissions`）**：无害冗余，移除无收益反增回归面。
- **D5（尊重用户显式 deny）**：不用 `*:allow` 碾压 repo `.opencode` 的显式 deny；本 RFC 只兜「默认不卡」。

## 6. PR 拆分

单 PR（改动集中在 `services/runner.ts` 的 `buildInlineConfig` / `buildInlineAgentEntry` + 一个模块常量 + 测试）。无 migration、无前端、无 schema 变更。
