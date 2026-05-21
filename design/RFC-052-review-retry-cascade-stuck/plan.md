# RFC-052 — review retry-cascade 卡死（任务分解）

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。
> 当前状态：**Done**（fix landed in commit `be93be7`，2026-05-21）。

## 总体策略

四个子任务可独立写代码、独立锁测试，但建议**单 PR 一并交付**——它们
合起来才能完整止血一条 task。commit message 前缀：
`fix(review): RFC-052 …`，body 里把 task id `01KS1N8WVZWE8FTR4K9WSETRNW`
写进去便于历史追溯。

## 子任务

### RFC-052-T1 — `dispatchReviewNode` 用 isFresherNodeRun 选 row + 终态短路

- 文件：`packages/backend/src/services/review.ts`（约 line 386-425）
- 改动：
  - `Array.find` → 循环 + `isFresherNodeRun` 比较器；
  - 若选出 row 已落 `done` / `canceled`，直接 `return { kind: 'ok' }`，
    不创建新 doc_version、不广播。
- 测试新增：
  - `packages/backend/test/review-dispatch-terminal-state.test.ts`
  - `packages/backend/test/review-dispatch-row-selection.test.ts`
- 依赖：无前置子任务。

### RFC-052-T2 — `retryNode` 不再为非进程 kind mint 占位

- 文件：
  - `packages/backend/src/services/task.ts`（约 line 641-669）
  - `packages/shared/src/`（新增或扩展 `isProcessNodeKind` 谓词；若 shared
    端已经有 kind 集合，把它就近声明在那个文件里）
- 改动：
  - retryNode 的 `targets` 过滤掉 kind ∈ {review, clarify, output, input}
    的下游节点。
- 测试新增：
  - `packages/backend/test/retry-node-no-review-cascade.test.ts`
- 依赖：无前置子任务。

### RFC-052-T3 — `submitReviewDecision` approved 分支幂等

- 文件：`packages/backend/src/services/review.ts`（约 line 1109-1148）
- 改动：
  - `db.insert(nodeRunOutputs).values(...)` 拆成两次 + `onConflictDoUpdate`
    （或先 delete 再 insert，看 drizzle 版本能否支持 upsert，开工前 grep
    既有用法）。
  - 确认 `status='done', finishedAt=decidedAt` update 在 outputs upsert
    之后总会执行；不再依赖 try/catch 兜底。
- 测试新增：
  - `packages/backend/test/review-approve-idempotent.test.ts`
- 依赖：可与 T1 并行；先 T1 后 T3 更利于复现单元测试场景。

### RFC-052-T4 — 卡死 task 一次性 fix-up

- 文件：`packages/backend/scripts/fixup-rfc052-stuck-review.ts`（新增）
- 改动：
  - 接 `--task-id` 参数；
  - 用 drizzle 读 node_runs + doc_versions 验证 task 真的处于 RFC-052
    描述的卡死形状（防止误跑）；
  - 满足条件后执行 design.md §Fix-4 列出的更新；
  - 退出码：0 = 推进了 / 1 = task 不符合卡死形状（no-op，安全）。
- 一次性运行：本地连接生产 DB（用户自己跑），观察 task 进入 pending →
  resumeTask 自动跑下游 output → done。
- 测试新增：可选——`task-01KS1N8W-fixup.test.ts` 在 in-memory db 上
  构造同形状测脚本是否把它推到 pending。
- 依赖：T1 + T2 + T3 都合并后再跑——否则推到 pending 会触发同样的回弹
  路径，白干。

## PR 拆分建议

**默认**：一个 PR，`feat(review): RFC-052 review 节点 retry 级联卡死`，
含 T1+T2+T3 + 单测。Fix-up 脚本（T4）可以放同 PR 里——脚本是只读 +
惰性的、不影响其他 task。

如果 reviewer 觉得 PR 过大，可以拆为：

- PR-A：T1 + T2 + T3 + 单测（核心修复）
- PR-B：T4 fix-up 脚本

T4 单独发可以观察一段时间生产再跑 fix-up，但增加 user 等待感，不推荐。

## 验收清单

- [ ] 4 个新测试文件全部加上，每条对应一类回归防护，文件顶部注释指明
      "锁住 RFC-052 ..."。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] GitHub Actions CI run 六 jobs 全绿（按 [feedback_post_commit_ci_check]）。
- [ ] 在本地 daemon + 一份 e2e workflow 上手动跑一次：agent→review，
      iterate v1 → 对 agent 点 Retry → agent 重跑完 → approved v2 →
      看到 task 推进到 done（v3 不会自动冒出来）。
- [ ] 跑 T4 脚本，把 `01KS1N8WVZWE8FTR4K9WSETRNW` 推到 done；详情页
      不再显示 awaiting_review。
- [ ] `STATE.md` 顶部"进行中 RFC"删除 RFC-052 条目，移到"最近完成 RFC"
      区段，写明 commit hash + CI run。
- [ ] `design/plan.md` RFC 索引登记一条 `RFC-052` 状态变 Done。

## 风险 + 兜底

- **风险 1**：drizzle/sqlite 版本不支持 `onConflictDoUpdate`。
  - 兜底：grep 现有用法（`grep -rn "onConflictDoUpdate" packages/backend/src`）
    确认能用；若不能，T3 改成 delete-then-insert。
- **风险 2**：T2 把某些边缘场景下原本依赖"review 占位行"的代码路径
  打回未知形状。
  - 兜底：review.ts 没有读 `errorMessage='queued for retry'` 的逻辑（grep
    确认）；scheduler 对 review 节点的处理只看 latestPerNode 是否 done。
    Fix-1 已经把 dispatchReviewNode 改成"按 isFresherNodeRun 选 row +
    终态短路"，没了占位行只会让 latest 自然落在原 review row 上，符合
    预期。
- **风险 3**：T4 在某些"看着像卡死但其实正常"的 task 上误推。
  - 兜底：脚本 SELECT 阶段必须**全部**断言 (a) node_run 的 status=
    awaiting_review，(b) doc_versions 最新一条 decision='approved'，
    (c) 不存在 pending doc_version。三条同时为真才推进，否则 no-op。
