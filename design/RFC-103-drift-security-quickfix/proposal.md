# RFC-103 漂移急修批 + 安全急修 — 产品视角

> 来源：架构调研 `design/arch-audit-2026-06-23/`（综合 `00-SYNTHESIS.md` 路线图 rank 1 + Codex 交叉核验 `00-CODEX-CROSSCHECK.md` §3 补漏的安全项）。
> 性质：**一批已确诊、各自独立、低风险高收益的修复**，每条都「先写复现红测 → 再修 → 文本/契约断言锁意图」（CLAUDE.md test-with-every-change）。不含结构重构（那是后续 rank 2+ 的 RFC）。
> 落档前已逐条**回源核实**（见 design.md 每条的 file:line + 证据），剔除了 Codex 判为「有意设计 / 夸大」的项。

## 1. 背景

调研发现项目「正确性网已密（P0=0），但散落着一批副本漂移已咬人的 P1 与若干安全洞」。这些问题的共性是：**单点、可独立修、有明确复现路径**，不需要等结构重构就能落地，且修完即为后续重构提供回归护栏。本 RFC 把综合报告 rank 1（漂移急修）与 Codex 补漏的安全急修合并为一个批次 RFC，分 3 个 PR 交付。

## 2. 目标

收敛以下**已回源确认**的缺陷（每条编号对应 design.md / plan.md 的 T 任务）：

**A. 漂移急修（正确性）**
- **T1 恢复回滚基线错**（P1）：`resumeTask` 取「每节点最新 run」时未排除 fanout/loop 子行，子行可冒充节点最新行 → 按子行 `pre_snapshot` 回滚错误基线。
- **T2 REST 入口漏传配置**（P1，**Codex 复审已扩面**）：`maxConcurrentNodes` 全生产路径未接线（恒走默认 4），且 `StartTaskDeps` 连该字段都没有；`commitPush` 只在 JSON start 传，resume/repair/retry/**multipart start** 均不传、`retryNode` 内部 `runTask` 也不透传 → 线上行为与设置/start 路径不一致。修法是 **service 层 plumbing**（给 deps/options 加 `maxConcurrentNodes` + 补 retryNode commitPush 透传）+ **5 个入口全覆盖**（JSON start / multipart start / resume / repair-resume / retry），不是纯 route 层补齐。
- **T3 opencode token 计量缺 ~15×**（P1）：`accumulateTokens` 读扁平 `cache_creation/cache_read`，真实 opencode 输出是嵌套 `cache:{read,write}` → cache token 恒计 0，`max_total_tokens` 限额按错误小值失效。
- **T4 fanout 按 `\n` 误裂 `list<markdown>`**（P1）：分片源 split 用裸 `.split('\n')` 绕过单一事实源 `splitListItems`/`splitMarkdownDocs` → 含换行的文档 item 被静默裂成多分片，任务照样 green。
- **T5 校验器 builtin 变量集漂移**（P1）：校验器与 `prompt.ts` 各维护一份 builtin 变量 Set，校验器漏 `__repos__`/`__repo_count__` → RFC-066 多仓 `{{__repos__}}` 被误报 `prompt-template-unresolved` 阻止合法 launch。
- **T6 信封端口内容嵌套 `</port>` 截断**（P1）：`PORT_RE` 非贪婪匹配到首个 `</port>` → 端口内容本身含 `</port>`（如讨论协议的代码块）时静默截断丢内容。

**B. 安全急修**
- **T7 端口文件经 symlink 越界读取 worktree 外文件**（High）：`path`/`markdown_file` 端口只做词法包含、不做 realpath，worktree 内的 symlink 指向外部可读出敏感文件。
- **T9 登录非 constant-time → 账号/状态枚举**（Medium）：注释自称 constant-time，实则未知/禁用/无密码用户直接 401、仅有效用户跑 Argon2 → 可计时区分有效账号。
- **T10 `/api/skill-sources` 无 ACL 过滤泄漏本机绝对路径**（Medium）：任何认证用户可读所有 source 的本机绝对路径 + label + 统计。

> **原 T8（缓存仓凭据 URL 泄漏）已移出本 RFC** —— Codex 设计 gate 复审指出：前端启动下拉用 `it.url`（含凭据原文）作为提交的 `repoUrl` 值、服务端据此 clone 私有仓（`RepoSourceRow.tsx:229-240`），记忆弹窗也展示 `r.url`（`MemoryNewDialog.tsx:163-165`）。直接从 API 删 `url` 会断掉「选最近仓免输凭据」启动能力。正确修法是 launch-by-`cachedRepoId`（前端 Select 值改 id + StartTask schema 加 cachedRepoId + 服务端 id→url 解析），属契约变更，超出「急修」范畴 → 见 §3 非目标，建议独立 RFC。

## 3. 非目标（明确不在本 RFC，列为候选后续 RFC）

以下也是 Codex 补漏的真问题，但**各自需要独立设计面 / 跨更多子系统 / 需产品决策**，不塞进急修批，避免 mega-RFC：

- **缓存仓凭据 URL 泄漏（原 T8）**（07/10，High）：真问题，但正确修法是 launch-by-`cachedRepoId` 契约变更（API 列表只回 `id`/`urlRedacted`、StartTask schema 加 `cachedRepoId`、服务端 id→url 内部解析、前端 `RepoSourceRow`/`MemoryNewDialog` 改用 id+redacted）。涉及前端启动契约 + 后端 schema，超「急修」范畴 → 建议独立 RFC（凭据隔离 + launch-by-id）。
- **GC 删除可恢复 worktree**（07，P1）：需先定 worktree 保留策略（failed/interrupted/canceled 是否、保留多久），是产品决策不是单点修。本 RFC 仅在 T 之外记录；建议独立 RFC。
- **cross-clarify 消费未按 `loopIter` 隔离**（09，High）、**复制 wrapper 不重写 nodeIds + 远端覆盖 dirty 草稿**（14，High）、**融合内置资源 shadow + 审批 ACL 未复检**（11，两条 P1）、**node/edge id 唯一性**（04，P1）、**plugin/MCP rename 跨 ACL 级联**（12）：均为真 P1/High，但分属不同子系统、改面较大，建议各自立 RFC 或并入对应子系统重构。
- **argv 大 prompt E2BIG**（06，High）：归属 rank 6「OpencodeProcess 适配层」RFC（涉及进程传输方式改造）。
- 任何 god-module/巨石裂解、声明式注册表化（rank 4+）：本 RFC 不碰结构。

## 4. 用户故事

- 作为**运维**，我在设置里调小并发，希望对新 start/resume 的任务立即生效，而不是发现只有测试直调才生效（T2）。
- 作为**平台用户**，我跑多仓任务用 `{{__repos__}}`，希望它能正常 launch 而不是被校验器误报拦下（T5）。
- 作为**安全负责人**，我希望普通成员读 cached-repos 时拿不到带凭据的 git URL、skill-sources 拿不到服务器本机路径、登录接口不能被用来枚举账号（T7/T8/T9/T10）。
- 作为**用 token 限额控成本的用户**，我希望 `max_total_tokens` 按真实用量生效，而不是因 cache token 漏计而形同虚设（T3）。
- 作为**单节点重试者**，我希望重试后的 commit&push 行为与首次 start 一致（T2），且回滚回到正确的节点基线而非某个分片子行（T1）。

## 5. 验收标准

- 每个 T 任务都带一条**先红后绿**的回归测试（见 design.md §测试策略），测试顶部注释链接本 RFC + 调研报告编号，说明「为什么这条测试存在」。
- `bun run typecheck && bun run test && bun run format:check` 全绿；CI（含前端 vitest + Playwright e2e + 单二进制 smoke + 静态扫描）全绿。
- 安全项（T7–T10）各带一条「越权/越界即失败」的负向断言。
- 不引入行为回归：既有 scheduler / clarify / review / envelope / auth 套件保持绿（等价锚）。
- 完成后按 [feedback_codex_review_after_changes] 跑 Codex 复审并修净 findings。

## 6. PR 拆分（详见 plan.md）

- **PR-A**（生命周期 + 配置 + token）：T1, T2, T3 —— `task.ts` / `routes/tasks.ts` / `runner.ts`。
- **PR-B**（端口 / 信封 / 校验器）：T4, T5, T6, T7 —— `scheduler.ts`(fanout split) / `workflow.validator.ts` / `envelope.ts`。
- **PR-C**（安全 / 认证 / ACL）：T9, T10 —— `routes/auth.ts` + `auth/passwords.ts` / `routes/skill-sources.ts` + `services/skill-source.ts`。

三 PR 之间无强依赖，可并行评审；组内按文件聚合以减小冲突面（多人并发树，见 CLAUDE.md 协作原则）。本 RFC 共 **9 个任务（T1–T7, T9, T10）**，纯后端、无新表无 migration。
