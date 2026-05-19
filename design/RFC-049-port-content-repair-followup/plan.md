# RFC-049 — 任务分解

## PR 拆分

两 PR；PR-A 行为零变化（仅改 errCode + 加目录骨架），PR-B 全部行为变化（forgiveness 删除 / 新校验加严 / 决策 + 文案 / migration 0026 + 新列读写）。

### PR-A — errorMessage 命名空间 + OutputKindHandler 接口骨架 + prompt guidance 搬家（行为零变化）

> 目标：把 `markdown-file-*` 三个 errorCode 改成**命名空间形态** `port-validation-markdown_file-*`、把 envelope.ts 里的三层校验拆进 `services/outputKinds/` 的 handler 接口、把 `buildMarkdownFilePortGuidance` 从 shared/prompt.ts 搬进 `markdownFile.ts` handler。**严格行为零变化**：forgiveness path 保留、不加新校验、不写 DB 新列、不改 scheduler 决策、不改追问行为。先单独绿一次 CI 再进 PR-B。

- **RFC-049-T1（handler 接口骨架）**：新 `packages/backend/src/services/outputKinds/types.ts`（`OutputKindHandler` 接口 + `ValidateCtx` / `ValidateResult` / `KindFailure` 类型，含文件头注释"四方法上限，不导出到 shared 公共 barrel"）+ `string.ts` / `markdown.ts` / `markdownFile.ts`（每个 `export default` 一个 handler；string/markdown 的 buildPromptGuidance/buildRepairBlock 返 null、validate 永真；markdownFile 实现 3 层校验 buildPromptGuidance（搬自原 `buildMarkdownFilePortGuidance`，参数化 ports 列表）+ buildRepairBlock（自渲染段头 + 5 subReason 文案，但 PR-A 阶段 markdownFile.validate 只覆盖 3 个原有 subReason，wrong-extension/empty-file 留给 PR-B）+ `index.ts`（静态 import 三个 handler 组成 HANDLERS const + 模块加载期 assert subReasons 拍平唯一 + export getOutputKindHandler / iterateHandlers / composePerKindRepairBlocks）。**测试**：`tests/output-kinds-handler-interface.test.ts` 5 case（接口完整性 / HANDLERS 表完整 / assert 成功 / fake-handler 冒烟 / subReason 命名空间冲突）+ `tests/output-kinds-string.test.ts` 3 + `tests/output-kinds-markdown.test.ts` 3 + `tests/output-kinds-markdown-file.test.ts` 6（PR-A 版只测 3 个原有 subReason validate + buildPromptGuidance 1 + buildRepairBlock 2；wrong-extension / empty-file case 留给 PR-B）= 17 case。
- **RFC-049-T2（envelope.ts dispatch + prefix 命名空间）**：改 `packages/backend/src/services/envelope.ts` `resolvePortContentDetailed`：kind 已声明时调 `getOutputKindHandler(kind).validate`、失败时 throw 新 `PortValidationError('port-validation-${kind}-${subReason}', '<prefix>: <detail>', { failure })`；**forgiveness path 保留**（`tryReadInWorktreeMarkdownPath` 整段不动）。errorCode 三处全部命名空间 prefix swap。**测试**：现有 `tests/envelope-resolve-port-md-path.test.ts` / `envelope-resolve-port-detailed.test.ts` / `envelope-parse-md-edge-cases.test.ts` 锚点统一更新（命名空间前缀，行为不动）；新增 `tests/envelope-prefix-swap-source.test.ts` 1 case（源码层 grep 守卫：envelope.ts 必出现 3 个新命名空间 prefix；必不再出现 3 个旧 `markdown-file-*` 前缀；**必不再出现非命名空间的 `port-validation-empty-path` 等"裸 sub"形态**）。
- **RFC-049-T3（首轮 prompt build 搬家）**：`buildProtocolBlock(agent)` 改成调 `iterateHandlers(agent.outputKinds)` + 对每 distinct kind 调 `handler.buildPromptGuidance`，把非 null 段拼到现有 protocol block 末尾；**`packages/shared/src/prompt.ts` 删除 `buildMarkdownFilePortGuidance` 函数定义 + 删除所有引用**（功能由 backend handler 等价提供）。**测试**：既有 prompt build 测试统一更新断言锚点；新增 `tests/build-protocol-block-via-handlers.test.ts` 3 case（声明 markdown_file → 含 handler 渲染的两步协议短句；只声明 string/markdown → 不含 markdown_file 段；零 outputKinds → 等于原始 protocol block）。grep 守卫：shared/prompt.ts 必不再出现 `buildMarkdownFilePortGuidance` / "two-step protocol" 字面。
- **RFC-049-T4（CI gate）**：本地 `bun run typecheck && bun run test && bun run format:check` 全绿；按 `feedback_post_commit_ci_check` 查 GitHub Actions 六 job 状态。
- **依赖**：仅依赖现有 `resolvePortContentDetailed` 主路径。
- **风险点**：T2 改名跨多文件 string 改动 + 命名空间升级；grep 守卫保住不留旧字面 / 不留裸 sub 中间态。T3 prompt 搬家会触动既有渲染测试断言；逐 case 把锚点从 "buildMarkdownFilePortGuidance contains ..." 改成 "buildProtocolBlock output contains ..."。
- **commit message 前缀**：`refactor(envelope): RFC-049 PR-A — OutputKindHandler 接口骨架 + port-validation-<kind>- 命名空间 + buildMarkdownFilePortGuidance 搬进 handler`。

### PR-B — 决策 + per-kind repair 渲染 + forgiveness 删除 + 校验加严 + migration 0026（行为变化）

> 目标：让框架在 port-validation 失败时走同 session 追问，并锁紧 markdown_file 契约。**多个行为变化打包在一个 PR 里**——因为 schema 改名、forgiveness 删除、新 subReason 之间相互锚定，分得更细反而留中间态难调试。

- **RFC-049-T5（生产扫描，落地前置）**：用 `sqlite3 ~/.agent-workflow/db.sqlite "SELECT name, outputs, frontmatter_extra FROM agents WHERE outputs != '[]'"` 在生产端复跑扫描，把"outputs 含端口但 outputKinds 没声明对应 markdown_file"的 agent 报告给作者，等作者补声明再合并。本机已扫零 freeloader（见 proposal §生产扫描），生产端必须重做。**不算 PR 内文件改动**，是合并 gate。
- **RFC-049-T6（migration 0026 + schema）**：新 `packages/backend/db/migrations/0026_port_validation_failures.sql`（`ALTER TABLE node_runs ADD COLUMN port_validation_failures_json TEXT`，nullable）+ `packages/backend/src/db/schema.ts` `nodeRuns` 表加字段 + `packages/shared/src/schemas/nodeRun.ts` `NodeRunSchema` 加 `portValidationFailures: ...nullable().default(null)`。**测试**：`tests/migration-0026-port-validation-failures.test.ts` 3 case（列存在 / nullable / 老行 SELECT 出来恒 NULL）。
- **RFC-049-T7（删除 forgiveness path + 加 wrong-extension/empty-file 校验 + handler buildRepairBlock 完整化）**：envelope.ts 删除 `tryReadInWorktreeMarkdownPath` 整段函数 + 所有调用点；`resolvePortContentDetailed` 在 kind 未声明时直接 raw 透传；outputKinds/markdownFile.ts 加 `wrong-extension` 校验（后缀检查 lowercased ∈ {.md, .markdown}） + `empty-file` 校验（readFile 后 trim 非空）+ `subReasons` 集合补全 5 项；`buildRepairBlock` 补齐 5 个 subReason 的短词映射 + detail 透传。新 `PortValidationError extends ValidationError` 带 `failure` payload。**测试**：output-kinds-markdown-file.test.ts 从 6 case 扩到 11 case（happy + 5 subReason + 大小写 + buildPromptGuidance + buildRepairBlock 多 case）；envelope-resolve-port-md-path.test.ts 把 forgiveness case 改写为"raw 字符串透传"等价或迁移；新 `tests/envelope-undeclared-kind-raw-passthrough.test.ts` 2 case；envelope-prefix-swap-source.test.ts 扩 grep：必不再含 `tryReadInWorktreeMarkdownPath`。
- **RFC-049-T8（shared prompt 渲染 + composePerKindRepairBlocks）**：`packages/shared/src/prompt.ts` `EnvelopeFollowupInput` 加 `portValidationFailures?` + `agentOutputKinds?` + `perKindRepairBlocks?: readonly string[]`；`reason` 枚举加 `'port-validation'`；`renderEnvelopeFollowupPrompt` 按 design.md §2.2 顺序锚点把 perKindRepairBlocks 数组按 first-occurrence 顺序拼进去（bi-modal preamble → blocks join with blank line → RFC-039 trailer）。backend `outputKinds/index.ts` export `composePerKindRepairBlocks(failures, outputKinds)` helper（按 kind 分桶 + 调每 kind 的 handler.buildRepairBlock + 未知 kind 跳过 + warn log）。**测试**：`packages/shared/tests/envelope-followup-port-validation.test.ts` 6 case（M1-M6 矩阵）+ `packages/shared/tests/render-envelope-followup-with-perkind-blocks.test.ts` 5 case + `tests/compose-per-kind-repair-blocks.test.ts` 5 case = 16 case。RFC-042 既有 6 case followup 测试零退化。
- **RFC-049-T9（runner 落新列 + composePerKindRepairBlocks 调用）**：runner.ts catch `PortValidationError` 时同步 `UPDATE node_runs SET port_validation_failures_json = ?, errorMessage = ?`；`RunNodeOptions.envelopeFollowupPortValidations?` 透传；followup 分支调 `composePerKindRepairBlocks(failures, agent.outputKinds)` 拿 `perKindRepairBlocks` + 透传到 `renderEnvelopeFollowupPrompt`。task.ts `rowToNodeRun` mapper 加 `portValidationFailures` 解析 + 坏 JSON 兜底 null + warn 不 5xx。**测试**：`tests/runner-writes-port-validation-failures-column.test.ts` 4 case（empty-path / wrong-extension 失败写列 + 成功保持 NULL + 老行 NULL → mapper 不崩）+ `tests/runner-port-validation-followup.test.ts` 4 case。
- **RFC-049-T10（scheduler 决策）**：`scheduler.ts` `decideEnvelopeFollowup` 加 `PORT_VALIDATION_PREFIX = 'port-validation-'` 命中 + reason='port-validation' 返回；`PreviousAttemptShape` 加可选 `portValidationFailures`；scheduler 决策时 SELECT 新列 + zod safeParse 还原 failures + 坏 JSON 退化为 []。decode 时**不**解析 `<kind>` 段（路由由 composePerKindRepairBlocks 负责）。**测试**：`tests/scheduler-port-validation-followup-decide.test.ts` 7 case + `tests/scheduler-port-validation-followup-branch.test.ts` 7 case = 14 case。RFC-042 既有 8 case `decideEnvelopeFollowup` 单测零退化。
- **RFC-049-T11（审计行）**：scheduler 决定走 port-validation followup 时 `node_run_events` 加 `kind='text'` 行 payload `[rfc049/port-validation-followup] {"port":"docpath","kind":"markdown_file","subReason":"missing-file","retryAttempt":N}`（payload 含 kind）。**测试**：`tests/node-run-events-port-validation-followup.test.ts` 1 case。
- **RFC-049-T12（RFC-042 §F 标 Superseded）**：`design/RFC-042-envelope-followup-recover/proposal.md` §F 段末追加 "Superseded by RFC-049"；plan.md RFC-042 索引保留 Done 不变。
- **RFC-049-T13（CI + STATE/plan 收尾）**：跑全套 backend / shared 测试零退化（重点 RFC-005 / RFC-014 / RFC-023 / RFC-026 / RFC-040 / RFC-042 / RFC-047 / RFC-048）；本地三件套 + GitHub Actions 六 jobs；plan.md RFC-049 状态 Draft → Done；STATE.md 进行中 RFC 段移出到已完成段。
- **依赖**：PR-A 必须先 origin/main 全绿；T5 必须先在生产端跑过。
- **风险点**：T7 forgiveness 删除是 breaking change（proposal §R7 + §生产扫描）；T9 落库与 errorMessage 写入同一 transaction 保一致性；T8 shared 不依赖 backend 的隔离要靠 `perKindRepairBlocks: readonly string[]` 字符串数组桥接，注意 TS 类型分层不要让 shared 直接 import 任何 `outputKinds/*`。
- **commit message 前缀**：`feat(scheduler): RFC-049 PR-B — port-validation 失败 → 同 session 追问 + per-kind repair 渲染 + forgiveness 删除`（含 `BREAKING:` 标签提醒 forgiveness path 已删）。

## 验收清单

- [ ] PR-A-T1：OutputKindHandler 接口 + types.ts + 三 handler 文件 + index.ts（HANDLERS + assert + helpers）+ 17 case（接口契约 5 + per-handler 6 + markdown_file PR-A 子集 6）；CI 六 jobs 全绿。
- [ ] PR-A-T2：envelope.ts dispatch 改 handler + errorCode 命名空间 prefix swap + 既有 3 套 envelope 测试锚点更新 + grep 守卫（含裸 sub 反向锚）。
- [ ] PR-A-T3：buildProtocolBlock 改迭代 handler + shared/prompt.ts 移除 `buildMarkdownFilePortGuidance` + 3 case 新增 + grep 守卫"两步协议短句不在 shared"。
- [ ] PR-A-T4：本地三件套 + GitHub Actions 六 jobs 全绿。
- [ ] PR-B-T5：生产端 sqlite scan，零未声明 freeloader（或全部已补声明）。
- [ ] PR-B-T6：migration 0026 + schema.ts + nodeRun.ts schema + 3 case 新增。
- [ ] PR-B-T7：删除 forgiveness path + 加 wrong-extension/empty-file 校验 + markdownFile handler 5 subReason 完整 + 11 case + raw passthrough 2 case + grep 守卫扩。
- [ ] PR-B-T8：shared prompt.ts 扩字段（含 perKindRepairBlocks）+ 矩阵渲染 + composePerKindRepairBlocks helper + 16 case + RFC-042 6 case 零退化 + shared 不依赖 backend 类型分层 lint。
- [ ] PR-B-T9：runner 落新列 + composePerKindRepairBlocks 调用 + 4 case + 4 case followup。
- [ ] PR-B-T10：scheduler decideEnvelopeFollowup 加 prefix 分支（仅外层）+ 14 case + RFC-042 8 case 零退化。
- [ ] PR-B-T11：节落 `[rfc049/port-validation-followup]`（payload 含 kind）审计行 + 1 case。
- [ ] PR-B-T12：RFC-042 §F 标 Superseded（PR-B 同 commit 一并改）；plan.md RFC-042 索引保持 Done。
- [ ] PR-B-T13：全套测试零退化 + 三件套 + CI 六 jobs；plan.md / STATE.md 同步。

## 不做（显式拒绝）

- 不引入运行时 plugin loader / 动态 `register()` API / `package.json` 插件读取（见 proposal §G4 / §R6）。
  - **本 RFC 落地的**是**静态** OutputKindHandler 接口 + 静态 import 表，不是运行时可插拔注册表——区别是新增 kind 仍需编译 + 改 index.ts 一行；编译后 HANDLERS 是 const。
- 不为 string / markdown 加任何强制 schema 校验。
- 不保留 forgiveness path（**与 PR-A 中保留区分**——PR-A 临时保留是因为它是行为零变化 PR；PR-B 必删）。
- 不引入新 WS schema / 不广播 port-validation 事件（审计行复用既有 node_run_events 渠道）。
- 不动 opencode 源码。
- 不引入前端 UI 改动（zero frontend code change）。
- 不一次性 collect 所有 multi-port failures，保留 fail-fast 模型（design.md §7 已说明）。
- 不让 shared/prompt.ts 直接 import `outputKinds/*`——shared 只接收 backend pre-rendered `perKindRepairBlocks: readonly string[]` 字符串数组；handler 接口 internal-only（不进 shared 公共 barrel）。
- 不往 `OutputKindHandler` 接口加第 5 个方法（sharding / aggregator / telemetry tag 等都是后续 RFC）。

## 时间估算

- PR-A：1 天写（handler 接口骨架 + 命名空间 prefix swap + prompt 搬家）+ 半天跑测试 + CI 等待 ≈ 1.5 个工作日。
- PR-B：1.5 天写 + 1 天测试 + CI 等待 + 生产 scan ≈ 3 个工作日。
- 合计 ≈ 4.5 工作日（不含 review）。
