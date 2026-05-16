# RFC-014 Plan — 拆解 + 验收清单

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 默认数：1（如 review 决策耦合 + prompt + agent schema 改动同 PR 风险可控）

## 任务分解

### RFC-014-T0：Agent schema 加开关字段

- **What**
  - `packages/shared/src/schemas/agent.ts`：`AgentSchema` / `CreateAgentSchema` / `UpdateAgentSchema` 各加 `syncOutputsOnIterate: z.boolean()`（`AgentSchema` 必填、Create 默认 `true`、Update partial 可选）。
  - drizzle migration 0004（按当前 head 顺延编号）：`agents` 表 `ALTER TABLE agents ADD COLUMN sync_outputs_on_iterate INTEGER NOT NULL DEFAULT 1`。
  - `packages/backend/src/db/schema.ts`：drizzle 表定义同步加列 `syncOutputsOnIterate: integer('sync_outputs_on_iterate', { mode: 'boolean' }).notNull().default(true)`。
  - `packages/backend/src/services/agents.ts`：CRUD 读写新字段；frontmatter 解析支持 `syncOutputsOnIterate: true/false`，缺省 = true；序列化时只在 false 时写出（保持 frontmatter 简洁，与 readonly 风格一致）。
- **Tests**
  - `agent-sync-outputs-opt-out.test.ts` case 2 + case 3（CRUD + migration backfill，含在 RFC-014-T2 backend cascade 套件内或独立文件，由实现细化）。
- **Deps**：无（DB / schema 改动独立可先落）。

### RFC-014-T1：共享 prompt 引擎扩展

- **What**
  - `packages/shared/src/prompt.ts`：
    - `BUILTIN_VARS` 加 `'__sibling_outputs__'`。
    - `ReviewPromptContext` 加可选 `siblingOutputs?: string`。
    - `renderUserPrompt` switch 加 `'__sibling_outputs__'` case；auto-append 段在 `iterateTargetPort` 段之后追加 `## Sibling Outputs`。
    - 顶部注释 stable contract 一段：与 `__review_rejection__` / `__review_comments__` / `__iterate_target_port__` 并列列出。
  - 共享层不接 DB，不读文件——`siblingOutputs` 由 caller pre-render 后传入（与现有 `comments` 一致）。
- **Tests**
  - `packages/shared/tests/prompt-sibling-outputs.test.ts`：
    - 模板引用 token → 替换文本与 auto-append 不双重出现（1 case）。
    - 模板不引用 + siblingOutputs 非空 → auto-append `## Sibling Outputs`（1 case）。
    - siblingOutputs=undefined → token 替换为空、不 auto-append（1 case）。
  - 既有 `prompt.test.ts` 不退化。
- **Deps**：无。

### RFC-014-T2：backend cascade + sibling content 拉取

- **What**
  - `packages/shared/src/review.ts`：
    - `isMultiMarkdownUpstream(outputs)` 纯函数 + 类型定义。
  - `packages/backend/src/services/review.ts`：
    - `buildSiblingOutputsBlock({ taskId, upstreamNodeRunId, siblingPorts })`：循环每个 port 取最新 doc_version body，拼带英文前缀的 markdown 段；全 0 → undefined。
    - `cascadeSiblingReviews` 重构为带 `triggeredBy: 'reject' | 'iterate'` 参数；现有 reject 调用点 pass `'reject'`；iterate 分支新增调用点 pass `'iterate'`。
    - `submitReviewDecision` iterate 分支：
      1. 判定上游 multi-markdown（依赖 `tasks.definitionSnapshot` 内的上游节点 outputs）。
      2. trigger=true → 先 cascade sibling reviews（含 done(approved) 一并回退）+ 在 ReviewPromptContext 中带 siblingOutputs。
      3. trigger=false → 走老路径。
    - `buildReviewPromptContextForUpstream` 在 decision=`iterated` 分支接 sibling outputs。
    - `dispatchReviewNode` 接受可选 `reviewIterationOverride`，多 markdown iterate 路径上游重跑产出 envelope 后由 scheduler 传入同一个值。
  - `packages/backend/src/services/scheduler.ts`：iterate 后续 review 节点 dispatch 时传 reviewIterationOverride（取 target review 的 nextIter）。
- **Tests**
  - backend 至少 +12（按 design.md §8.1）：
    - `review-iterate-sibling-cascade.test.ts`（3）
    - `review-sibling-outputs-prompt.test.ts`（3）
    - `review-iterate-single-port-baseline.test.ts`（2）
    - `review-iterate-partial-merge.test.ts` 改写顶部注释 + 反转断言（保留原 case 数，语义反转）
    - `is-multi-markdown-upstream.test.ts`（3 case：双 markdown、单 markdown、markdown+string）
  - `review-prompt-injection.test.ts` reject 路径加反向断言：rendered prompt 不含 `## Sibling Outputs`（1 case）。
- **Deps**：T1（依赖共享 token 已声明）。

### RFC-014-T3：frontend preview + cascade UI + Agent 表单 toggle

- **What**
  - `packages/frontend/src/components/NodeInspector.tsx`：preview pane 渲染含 `__sibling_outputs__` 占位提示（与现有 review tokens 一致的 muted 占位字符串）。
  - `packages/frontend/src/routes/reviews.detail.tsx`：消费 WS `review.created` 事件的 `reason` 字段，`reason='iterate-sibling-cascade'` 时弹 toast「{count} 条已通过的兄弟评审被同步重审」（i18n 中英双语 key 各 1）。
  - `packages/frontend/src/routes/reviews.tsx` + `reviews.detail.tsx` 版本列表：基于"同一上游 nodeRunId 下 reviewIteration 相等的 doc_version ≥ 2 个 port"派生标记"因 cascade 重生"，渲染小 chip（i18n 中英 1 key）。
  - `packages/frontend/src/routes/agents.*.tsx`（Add / Edit Agent 表单）：新增 toggle 字段，**label 文案为「文档迭代期间是否同步刷新本代理生成的其他文档」**；helper 文案「仅当本代理 outputs 含 ≥ 2 个 markdown / markdown_file 时实际生效；关闭则在用户点'返回修改'时只重生被评审的那一份」；默认开（与后端 default 一致）。i18n key 中英各 1 label + 1 helper。
  - i18n：`reviews.cascadeSiblingToast` / `reviews.versionListCascadeChip` 中英各 1 + tooltip 1 + `agents.form.syncOutputsOnIterate.label` / `.helper` 中英各 2。
- **Tests**
  - frontend 至少 +8：
    - `node-inspector-prompt-preview-sibling.test.tsx`（2）
    - `reviews-detail-cascade-toast.test.tsx`（2）
    - `reviews-detail-history-cascade-mark.test.tsx`（2）
    - `agent-form-sync-outputs-toggle.test.tsx`（2：默认开 + 切 off 提交 body 正确）
  - 既有 `reviews.*.test.tsx` / `agents.*.test.tsx` 全绿。
- **Deps**：T0（依赖 schema 字段已存在）+ T2（依赖 WS 事件 `reason` 字段）。

### RFC-014-T4：源代码层兜底 + e2e + 文档同步

- **What**
  - `packages/backend/tests/review-prompt-builtin-tokens-source.test.ts`：扩 RFC-005 既有源代码层 grep，新增 `__sibling_outputs__` 字面量出现断言。
  - `e2e/review.spec.ts`：新增三 markdown 输出 workflow + iterate target 中间 port 的 spec 步骤（fixture 用 stub-opencode）。
  - `design/RFC-005-human-review/design.md` §5.2 / §11 / 章末加一行 "see RFC-014 for multi-markdown iterate revision"。
  - `design/RFC-005-human-review/proposal.md` §2.1 #8 / A3 加 RFC-014 修订标注（不改原文，只加注脚）。
- **Tests**：无新 unit，e2e 在 CI 跑。
- **Deps**：T1 + T2 + T3。

## 验收清单

- [ ] **A1**（多文档 iterate 全 port 重生）`review-iterate-sibling-cascade.test.ts` case 1 绿。
- [ ] **A2**（sibling cascade 含 already approved）case 2 绿。
- [ ] **A3**（`__sibling_outputs__` prompt 注入）`review-sibling-outputs-prompt.test.ts` 3 case 绿。
- [ ] **A4**（单 port 节点零回归）`review-iterate-single-port-baseline.test.ts` case 1 绿。
- [ ] **A5**（kind=string 不进集合）`review-iterate-single-port-baseline.test.ts` case 2 绿。
- [ ] **A6**（reject 路径零回归）`review-prompt-injection.test.ts` 新增反向断言 case 绿；既有 reject case 不退化。
- [ ] **A7**（reviewIteration 共享）`review-iterate-sibling-cascade.test.ts` case 1 内 assertion 相等。
- [ ] **A8a / A8b / A8c**（agent 开关默认 true / migrator backfill / opt-out 退化）`agent-sync-outputs-opt-out.test.ts` 三 case 绿。
- [ ] **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] **B2** RFC-005 / RFC-011 / RFC-013 既有 review 测试套全绿（含 `review-state-machine` / `reviews-iterate-mints-new-run` / `review-version-comments`）。
- [ ] **B3** backend tests +15 已落（含本 RFC 5 文件含 agent-sync-outputs-opt-out）。
- [ ] **B4** frontend tests +8 已落（含本 RFC 4 文件含 agent-form-sync-outputs-toggle）。
- [ ] **B5** e2e `review.spec.ts` 三 markdown 段绿（macos + ubuntu 矩阵）。
- [ ] **B6** 单二进制 build smoke 绿；包体积不退化（diff 0 deps）。
- [ ] **C1** `review-iterate-sibling-cascade.test.ts` 顶部注释含 RFC-014 链回 + 红了的诊断指引。
- [ ] **C2** `review-sibling-outputs-prompt.test.ts` 顶部注释含 stable contract 注。
- [ ] **C3** `review-prompt-builtin-tokens-source.test.ts` 含 `__sibling_outputs__` 源码层断言。
- [ ] **C4** `review-iterate-single-port-baseline.test.ts` 顶部注释明文锁"≥ 2 markdown 守卫不许拆"。
- [ ] **C5** `agent-sync-outputs-opt-out.test.ts` 顶部注释明文锁"opt-out 通路不许被框架在'我觉得应该同步'下覆盖"。
- [ ] **CI** GitHub Actions 全绿（按 [feedback_post_commit_ci_check]：push 后立刻查）。
- [ ] **STATE.md / plan.md / 索引** 同步：RFC-014 状态从 Draft → In Progress → Done。

## PR 拆分

默认单 PR：`feat(review): RFC-014 多 markdown iterate 同步重生 + agent syncOutputsOnIterate 开关 + __sibling_outputs__ token`。

如审查反馈改动量过大想拆，建议拆 3 PR（schema → 后端逻辑 → 前端）：
- PR-1：T0 agent schema + migration 0004 + CRUD（feat(agents): RFC-014 add syncOutputsOnIterate field default true）
- PR-2：T1 + T2 backend cascade + prompt token + 测试（feat(review): RFC-014 backend iterate sibling cascade + prompt token）
- PR-3：T3 + T4 frontend + e2e + 文档（feat(review): RFC-014 frontend cascade toast + agent form toggle + history chip + e2e）

PR-1 单独落地后行为完全不变（开关默认 true 但 T2 还没消费它，路径完全等同 RFC-005 老 iterate）；PR-2 后行为开始按新规则跑，老 frontend 不消费 `reason` 字段时 toast 不弹但行为正确；PR-3 把 UI 拉齐。如选拆分，plan.md 不再二修。
