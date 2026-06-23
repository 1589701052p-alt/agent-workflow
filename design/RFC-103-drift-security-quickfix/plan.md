# RFC-103 漂移急修批 + 安全急修 — 任务分解

> 状态：**Draft（待用户批准后进入实现）**。
> 原则：每个 T = 「先红测 → 修 → 文本/契约断言锁意图」。无新表、无 migration、纯后端、三 PR 之间无强依赖。

## 任务表

| 任务 | 标题 | 文件 | 级别 | 依赖 | PR |
|---|---|---|---|---|---|
| RFC-103-T1 | 恢复回滚基线滤 parentNodeRunId | `services/task.ts`（+复用 `freshness.ts`） | P1 | — | A |
| RFC-103-T2 | service plumbing + 5 入口透传 maxConcurrentNodes/commitPush | `routes/tasks.ts`（5 入口含 multipart）、`services/task.ts`（StartTaskDeps 加字段 + retryNode 补 commitPush + runTask 透传） | P1 | — | A |
| RFC-103-T3 | token 兼容嵌套 cache.read/write + total 预言 | `services/runner.ts` | P1 | — | A |
| RFC-103-T4 | fanout 分片走 listWire kind-aware splitter | `services/scheduler.ts`、`shared/shardingRegistry.ts` | P1 | — | B |
| RFC-103-T5 | 校验器 builtin 变量集从 prompt.ts 单源 import | `services/workflow.validator.ts`、`shared/prompt.ts` | P1 | — | B |
| RFC-103-T6 | 信封端口边界容器化（嵌套 `</port>` 鲁棒） | `services/envelope.ts` | P1 | — | B |
| RFC-103-T7 | 端口文件 realpath 越界防护 | `services/envelope.ts`、`util/safePath.ts` | High(sec) | T6 同文件，先 T6 后 T7 同 PR | B |
| RFC-103-T9 | 登录 constant-time（dummy Argon2） | `routes/auth.ts`、`auth/passwords.ts` | Med(sec) | — | C |
| RFC-103-T10 | skill-sources 列表按 registrar/admin 过滤 | `routes/skill-sources.ts`、`services/skill-source.ts` | Med(sec) | — | C |

## PR 拆分

### PR-A —— 生命周期 + 配置 + token（`feat(scheduler): RFC-103 PR-A 漂移急修（恢复基线/配置透传/token）`）
- T1, T2, T3。三者都在调度/恢复正确性面，文件 `task.ts`/`routes/tasks.ts`/`runner.ts`。
- 验收：3 条红测先行后转绿；既有 retry-cascade / scheduler 套件保持绿。

### PR-B —— 端口 / 信封 / 校验器（`feat(workflow): RFC-103 PR-B 端口与信封急修（fanout split/builtin vars/envelope）`）
- T4, T5, T6, T7。T6+T7 同改 `envelope.ts` 合并为一组；T5 触碰 shared import 方向，跑 `build:binary` smoke。
- 验收：4 条红测；既有 `envelope-*` 全绿（等价锚）；多仓 `{{__repos__}}` launch 通过。

### PR-C —— 安全 / 认证 / ACL（`fix(security): RFC-103 PR-C 安全急修（登录计时/source ACL）`）
- T9, T10。两条独立安全洞，各带负向断言。
- 验收：2 条「越权/越界即失败」红测；既有 `auth-routes` / ACL 套件全绿。

## 全局验收清单

- [ ] 9 条 `tests/rfc103-*.test.ts`（T1–T7, T9, T10）全部先红后绿，顶部注释链接 RFC-103 + 对应调研报告编号。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] PR-B 额外 `bun run build:binary` smoke 绿（T5 改 import 方向）。
- [ ] CI（lint + typecheck + 全量 bun:test + 前端 vitest + Playwright e2e + 单二进制 smoke + 静态扫描）全绿（[feedback_post_commit_ci_check]）。
- [ ] 每个 PR 完成跑 Codex 实现 gate 复审并修净 findings（[feedback_codex_review_after_changes]）。
- [ ] T7/T10 收紧边界前，确认无合法用例依赖旧宽松行为（design.md §失败模式）。
- [ ] 多人并发树：只 `git add` 本 RFC 涉及文件，不动他人未追踪改动（[feedback_dont_delete_others_code_for_ci]、CLAUDE.md 协作原则）。
- [ ] 全程在 `main` 直接提交推送（[feedback_main_branch_only]）。

## 落档同步（本 RFC 完工时）

- [ ] `design/plan.md` RFC 索引：RFC-103 行 Draft → Done。
- [ ] `STATE.md`：顶部「进行中 RFC」行移除；已完成 issue 表加 RFC-103 行。

## 显式非目标（候选后续 RFC，见 proposal.md §3）

**原 T8 缓存仓凭据 URL 泄漏**（移出本 RFC，需 launch-by-cachedRepoId 契约变更，独立 RFC）｜GC 删可恢复 worktree（需保留策略决策）｜cross-clarify loopIter 隔离｜copy/paste wrapper nodeIds + dirty 草稿覆盖｜融合内置资源 shadow + 审批 ACL 复检｜node/edge id 唯一性｜plugin/MCP rename 跨 ACL 级联｜argv 大 prompt E2BIG（归 OpencodeProcess 适配层 RFC）。
