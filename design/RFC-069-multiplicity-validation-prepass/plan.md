# RFC-069 Plan — Multiplicity Validation Pre-pass：任务分解

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)
> 估算：≈ 2-3 工作日 / 单 PR
> 启动前置：RFC-064 落地稳定（main 上 cci 列已 DROP / services/crossClarify.ts 已物理删 / scheduler 4 处 cci 派生已切）

## 1. PR 拆分

**单 PR**——本 RFC 范围小（单文件 validator.ts + 几个新 case），不需要 RFC-058 / RFC-064 那种"PR-A baseline 锁全行为 + PR-B 重构"成本分摊。

| PR | 范围 | 估算 | 任务 |
|---|---|---|---|
| 单 PR | pre-pass 函数实现 + §4c / §4d 清理 + 新 6 case 测试 + grep 守门 | 2-3 d | T1-T6 |

## 2. 任务清单

**T1 pre-pass 函数实现**（0.5 d）
- `packages/backend/src/services/workflow.validator.ts` 新增 `validateAgentClarifyMultiplicity({ nodes, edges })` 函数（design.md §2 实现）
- 函数体 ≈ 70 行：scan `__clarify__` 出边 + 收集 clarify NodeKind 入边 source agent set + emit 3 类 issue（既有错误码 + message 模板）
- typecheck 全绿

**T2 §4c / §4d 清理**（0.5 d）
- `workflow.validator.ts:863-893` 删除 §4c 块内 `clarify-multiple-source-agents` (G1) + `clarify-multiple-clarify-on-same-agent` 规则身体（保留 `agentSourceIds: Set<string>` 派生计算供其它检查用）
- `workflow.validator.ts:996-1006` 删除 §4d 块内 G2 `cross-clarify-multiple-questioners` 规则身体
- `validateWorkflow` 主函数加 1 行调用：在 case 循环之前 `issues.push(...validateAgentClarifyMultiplicity({ nodes, edges }))`
- typecheck 全绿
- 跑既有 validator 套件确认行为不退化（次一步在 T4 系统性确认）

**T3 新增 case 测试**（1 d）

- 文件：`packages/backend/tests/multiplicity-pure-cross-coverage.test.ts`（新）
  - C2-1：纯 cross+cross 同一 agent 报错 `clarify-multiple-clarify-on-same-agent`（无 self-clarify 节点工作流）
  - C2-2：错误 message 字典序含两 cross-clarify NodeId
  - C2-3：pointer 指向 dictionary-min target id

- 文件：`packages/backend/tests/multiplicity-prepass-singleton.test.ts`（新）
  - C3-1：源代码 grep `validateAgentClarifyMultiplicity` 函数定义 = 1 次
  - C3-2：源代码 grep 旧规则身体（§4c / §4d 内的 G1/G2/multi-clarify-on-same-agent）= 0 次

- 文件：`packages/backend/tests/multiplicity-prepass-no-duplicate.test.ts`（新）
  - C4-1：构造 multi-attachment + per-kind self-loop 双错的 case；断言 multi-attachment 错误只出现 1 次

合计 ≥ 6 case。

**T4 既有 case 零退化验证**（0.5 d）
- 跑：
  - `workflow-validator-clarify.test.ts`（RFC-063 G1 + multi-clarify 既有 9 case）
  - `workflow-validator-cross-clarify-rfc056.test.ts`（RFC-056/063 G2/G3 多 case）
  - `cross-clarify-validator-rules.test.ts`（enum 10 codes 守门）
- 比对错误码 + message 字面量 + pointer 字段
- **判据**：字节级 diff = 0
- 如果有顺序敏感断言因为 pre-pass 在循环前的位置变化而失败 → 调整 expect 顺序但**不允许**改 message 文本

**T5 grep 守门验证**（0.2 d）
- 跑 `bun run test` 全套
- 手动 grep（design.md §6 列出的命令）
- 期望：pre-pass 函数定义 = 1 / 旧规则位置 = 0 / G3 仍在 §4d / enum 10 codes 不变

**T6 PR 提交 + 文档收尾**（0.3 d）
- commit message：`refactor(validator): RFC-069 multiplicity validation pre-pass — close RFC-064 §7.1 gap`
- design/plan.md RFC 索引登记（Draft → 完工时 Done）
- STATE.md 顶部加 "RFC-069 完工" 段
- push + CI 全绿

## 3. 跨 PR 守门

| 守门 | 来源 | 触发点 |
|---|---|---|
| typecheck | bun run typecheck | 每个 commit |
| test | bun run test | 每个 commit |
| format:check | bun run format:check | 每个 commit |
| C1 既有 RFC-063 9 case 字节守恒 | workflow-validator-clarify.test.ts + workflow-validator-cross-clarify-rfc056.test.ts | T2 + T4 完工 |
| C2 pure cross+cross 覆盖 | multiplicity-pure-cross-coverage.test.ts | T3 完工 |
| C3 pre-pass 单源真理 grep | multiplicity-prepass-singleton.test.ts | T3 + T5 完工 |
| C4 pre-pass 无重复报错 | multiplicity-prepass-no-duplicate.test.ts | T3 完工 |
| C5 enum 守门 | cross-clarify-validator-rules.test.ts（既有） | T4 完工 |

## 4. 风险缓解检查表

- [ ] RFC-064 在 main 上落地稳定后再启动（避免与 RFC-064 PR-B 同窗口操作 validator.ts 冲突——虽然 RFC-064 0 行动 validator，但合并冲突管理简单）
- [ ] pre-pass 函数 message 字面量与既有 §4c / §4d 实现严格对照（字面字符位、含空格 / 标点 / 引号 / 字典序）；任何 diff 在 T4 期间被既有 9 case 抓到
- [ ] 删除 §4c / §4d 规则身体后保留 `agentSourceIds: Set<string>` 派生计算（其它检查可能用到）；不要因为"看起来死代码"误删
- [ ] §7.1 漏网修复行为变更（pure cross+cross 从 silent 变 fail）：proposal.md §3 S6 已文档化；commit message 标注此行为变更让用户提前知晓
- [ ] G3 不动——`cross-clarify-multiple-designers` 在 §4d 中保持原位置 + 原 message 字面；C5 守门
- [ ] 不引入新错误码——既有 4 个 attachment 错误码字面量保持（`clarify-multiple-clarify-on-same-agent` / `clarify-multiple-source-agents` / `cross-clarify-multiple-questioners` / `cross-clarify-multiple-designers`）；C5 enum 守门 10 → 10

## 5. PR 提交模板

**Commit message**：

```
refactor(validator): RFC-069 multiplicity validation pre-pass — close RFC-064 §7.1 gap

Extract three agent-level clarify attachment multiplicity rules out of §4c/§4d
case blocks into a NodeKind-agnostic pre-pass that runs before the per-kind
case loop:

  - clarify-multiple-clarify-on-same-agent (was §4c body)
  - clarify-multiple-source-agents (was §4c body, RFC-063 G1)
  - cross-clarify-multiple-questioners (was §4d body, RFC-063 G2)

G3 cross-clarify-multiple-designers stays in §4d (not agent-level attachment).

Side-effect (intentional): closes RFC-064 §7.1 follow-up gap — workflows with
ONLY cross-clarify nodes (no self-clarify) where an agent attached to 2+
cross-clarify nodes previously slipped through silently, now correctly emit
`clarify-multiple-clarify-on-same-agent`.

Tests: +6 case (multiplicity-pure-cross-coverage.test.ts +3 / multiplicity-
prepass-singleton.test.ts +2 / multiplicity-prepass-no-duplicate.test.ts +1).
Existing RFC-063 9 case + RFC-056 validator suite byte-level preserved.

Zero schema / migration / runtime / scheduler / frontend changes — single
file `packages/backend/src/services/workflow.validator.ts` refactor.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

## 6. 完工 STATE.md 更新模板

```markdown
**RFC-069 Multiplicity Validation Pre-pass 完工**（单 PR commit `<sha>`, CI run <id> 全 15 jobs 全绿）：[proposal.md](design/RFC-069-multiplicity-validation-prepass/proposal.md) / [design.md](design/RFC-069-multiplicity-validation-prepass/design.md) / [plan.md](design/RFC-069-multiplicity-validation-prepass/plan.md) — 把 `workflow.validator.ts` 中 3 条 agent-level clarify attachment multiplicity 规则（`clarify-multiple-clarify-on-same-agent` / RFC-063 G1 `clarify-multiple-source-agents` / RFC-063 G2 `cross-clarify-multiple-questioners`）从 §4c / §4d case block 内抽出为 NodeKind 无关的 pre-pass 函数 `validateAgentClarifyMultiplicity({nodes, edges})`，在 `validateWorkflow` case 循环前调用一次。G3 `cross-clarify-multiple-designers` 不动（不是 agent attachment 规则、保持在 §4d 内）。**RFC-064 §7.1 漏网修复**：工作流完全没有 self-clarify 节点 + agent 同时挂到 2+ cross-clarify 节点这条 case 过去 silently 通过、现在正确报错 `clarify-multiple-clarify-on-same-agent`（message 含两 NodeId 字典序）。新增 ≥ 6 case（multiplicity-pure-cross-coverage / multiplicity-prepass-singleton / multiplicity-prepass-no-duplicate）；既有 RFC-063 9 case + RFC-056 validator 套件字节级守恒。**零 schema / migration / scheduler / runtime / frontend 改动**——单文件重构。改动文件：`packages/backend/src/services/workflow.validator.ts` + 3 个新测试文件 + design/RFC-069-* 三件套 + plan.md 索引 + STATE.md。
```

## 7. 与其它 RFC 的并发关系

- **RFC-064**：必须先落地（前置）。两 RFC 文件改动面零重叠
- **RFC-065 task-worktree-files-tab**：独立 frontend 任务详情 tab，与本 RFC 文件改动零重叠，并行无冲突
- **RFC-066 multi-repo-task-launch**：动 `services/task.ts` / migration / schema / runner，与本 RFC 文件改动零重叠，并行无冲突
- **RFC-067 task-git-identity**：动 `services/task.ts` startTask / runner spawn env，与本 RFC 文件改动零重叠，并行无冲突
- **RFC-068 pull-base-branch-on-task-launch**：动 `services/gitRepoCache.ts` / launcher，与本 RFC 文件改动零重叠，并行无冲突

本 RFC 不影响其它 RFC 的实施窗口；同样不被其它 RFC 阻塞（除 RFC-064 必须先落地）。
