# RFC-073 opencode Subagent Permission / Question 交互死锁根治 — Proposal（产品视角）

状态：**Done**

## 背景

线上（另一台机器）出现 task 卡死：worker 的 opencode 子进程不退出，框架一直停在 `await child.exited`，直到 30 分钟 node-timeout 才 SIGTERM 标记 failed，且监控面板没有明显原因（`stuck_task_detector` 的 S3 规则要求"所有 node_run 都 terminal"，而此时 node_run 仍是 `running`，故不告警）。

经逐层核对 opencode 源码，根因链如下：

1. **opencode permission 的默认裁决是 `ask`**（`permission/evaluate.ts:14`：无规则匹配时 `return { action: "ask", ... }`）。
2. agent-workflow 注入给 opencode 的 `agent.<name>.permission` 默认是 `{}`（`runner.ts:buildInlineAgentEntry`），且 **没有注入任何全局 `permission`**；只靠 CLI flag `--dangerously-skip-permissions`（`runner.ts:1427`）。
3. `--dangerously-skip-permissions` 走的是 `opencode run` 的事件 loop 应答（`cli/cmd/run.ts:706-726`），但那段有 `if (permission.sessionID !== sessionID) continue`（`:708`）——**只应答根 session，跳过所有 subagent 子 session**；并且**完全没有 `question.asked` 分支**。
4. subagent（`task` 工具派生，且允许 `allow:task` 多层嵌套）一旦触发需要 `ask` 的操作（实测：`bash` 执行 `cd <越界目录> && pwd` → `shell.ts:627` 检测 cwd 在 worktree 外 → `external_directory` ask），就 `bus.publish(permission.asked)`（子 session）并阻塞在 `Deferred.await`（`permission/index.ts:187-195`）。**没有人应答** → 子 session 永久挂起 → `task` 工具不返回 → 根 session 永不 idle → 进程不退出。
5. opencode 内置的 `question` 工具同理：它走独立的 `Question.Service.ask`（`question/index.ts`，阻塞 + `question.asked`），`opencode run` 的 loop 对任何 session 都不应答 `question.asked` → 一旦 agent 调用 `question` 工具即死锁。
6. 框架在 `opencode run --format json` 这条 CLI 路径下**没有反向通道**（`stdin: 'ignore'`，只读 stdout），结构上无法自己应答 permission/question。
7. 多层嵌套放大问题：深层 subagent 卡死时，post-run 的子 session capture（`sessionCapture.ts`，在 `child.exited` 之后才跑）根本没机会执行，运行期只剩 live poller，深层 subagent 往往**既不可应答、也不可观测**。

**参考实现（multica）**：multica 自己的 opencode adapter（`server/pkg/agent/opencode.go`）走的是**和 agent-workflow 一模一样**的 `opencode run --format json` CLI 模式（`:52`），并没有为 opencode 做 server/ACP 模式；它解决卡死靠**一行环境变量**（`:76-79`）：

```go
env = append(env, `OPENCODE_PERMISSION={"*":"allow"}`)
```

这把全局 `config.permission` 设成 allow，让 opencode 在 `evaluate` 阶段就放行所有 session（含任意层 subagent）、**根本不发 `permission.asked`**——这是生产验证过的根治手段，与"事后应答"的 `--dangerously-skip-permissions` 有本质区别。

## 目标（Goals）

- **G1**：从源头消除 subagent（含任意层嵌套）因 `permission.asked` 无人应答导致的死锁——让 permission 不再触发 `ask`。
- **G2**：消除 agent 调用 opencode `question` 工具导致的死锁——禁用该工具。
- **G3**：覆盖根 session + 所有层 subagent，**不依赖** `opencode run` loop 的应答、**不依赖** subagent 的 permission 继承转发。
- **G4**：不破坏框架自身的反问能力——clarify / clarify-cross-agent 节点走 `<workflow-clarify>` envelope，与 opencode `question` 工具正交。
- **G5**：用测试锁住回归（注入形态 + 顺序 + clarify 仍可用）。

## 非目标（Non-Goals）

- **不**实现 server 模式 + 自建 permission/question responder（那是后续可选增强，单独立 RFC；multica 在 opencode 上也没做）。
- **不**解决"框架看不到 permission 请求"的可观测性缺口——本 RFC 让请求不再产生，缺口不再致命，可观测性增强另议。
- **不**改变 worktree 隔离 / `readonly` 控制 / git identity 等既有安全边界。全局 allow 的安全前提（worktree 隔离 + readonly 节点串行）本就存在，且与现状 `--dangerously-skip-permissions` 的语义一致。
- **不**引入"人工审批 permission"功能。
- **不**改多层 subagent 的捕获时序（post-run capture / live poll）——本 RFC 让深层不再卡死，捕获缺口另议。

## 用户故事

- **US1**：作为平台用户，我的 worker agent 及其派生的 subagent 在执行 `bash` / 访问越界目录时不再卡死，任务正常推进到 done。
- **US2**：作为平台用户，即使 agent "想"调用 opencode 的交互式 `question` 工具，任务也不会挂起——agent 被引导走框架的 clarify 反问。
- **US3**：作为运维，不再出现"task 卡满 30 分钟才 node-timeout failed 且无明显原因"的故障。
- **US4**：作为设计者，反问节点（clarify / clarify-cross-agent）行为完全不变。

## 验收标准（Acceptance Criteria）

- **AC1**：runner 为每个 opencode 子进程注入全局 permission `{"*": "allow", "question": "deny"}`（经 `OPENCODE_CONFIG_CONTENT` 顶层 `permission` 字段；`question` 键排在 `*` 之后）。
- **AC2**（源码/单元级）：`buildInlineConfig` 的返回值含顶层 `permission`，其 `JSON.stringify` 序列化后 `question` 键出现在 `*` 键**之后**（`Permission.disabled` 用 `findLast`，顺序错则 question 不被禁）。
- **AC3**（防复活）：`buildInlineAgentEntry` 注入的 `agent.<name>.permission` 不得含 `question: "allow"`（否则 `agent.ts:306` 的 override merge 会盖掉全局 `question:"deny"`，question 工具复活）。
- **AC4**（死锁回归）：一个会触发越界 `bash`、以及一个会调用 `question` 工具的 agent，其 opencode 子进程能正常退出、不卡到 timeout，不产生 `permission.asked`/`question.asked` 死锁。（优先真 opencode / mock-opencode 实跑；若实跑不稳定，退化为 §测试策略中的源码级 + 单元断言。）
- **AC5**（不误伤反问）：禁用 `question` 工具后，clarify / clarify-cross-agent 节点从 `<workflow-clarify>` envelope 仍能正常进入 `awaiting_human`（`parseClarifyEnvelopeBody` 纯函数 + 一条端到端 clarify 流程断言）。
- **AC6**：保留现有 `--dangerously-skip-permissions`（作根 session 冗余，无害）。
- **AC7**：`bun run typecheck && bun run test && bun run format:check` 全绿；CI 三项 + 单二进制 build smoke + Playwright e2e 绿。

## 关联

- 与 [RFC-023](../RFC-023-agent-clarify/proposal.md)（clarify）正交：本 RFC 禁的是 opencode `question` 工具，clarify 走 `<workflow-clarify>` envelope，两者实现路径完全独立。
- 后续可选增强（不在本 RFC 范围）：server 模式 + 自建 responder（拿完整可观测性 / 人工审批 / 彻底覆盖 question），参考 multica 给 codex 的 ACP `handleServerRequest` 模式（`server/pkg/agent/codex.go:636-654`）。
