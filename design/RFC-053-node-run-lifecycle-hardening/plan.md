# RFC-053 — node_run 生命周期硬化（任务分解）

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。
> 当前状态：**Draft**，等用户批准后进入实现。

## PR 与依赖图

```
PR-A 测试 baseline  ─────────┐
   （50-80 新测试，全 bug 区） │
                              ▼
PR-B P-1 状态机化  ──┬───────►├──► PR-C P-2 kind handler 表
                     │        │      （retryNode / limits / orphans / gc /
                     │        │       shutdown 全部走表）
                     │        │
                     │        ├──► PR-D P-3 双层 invariant 启动+周期扫
                     │        │      （含 migration 0028 lifecycle_alerts）
                     │        │
                     │        └──► PR-E P-6 stuck-task detector
                     │               （后端 service + 前端 banner + diagnose 弹窗）
```

- **PR-A 必须先**：所有后续 PR 必须保持 PR-A 全绿。
- **PR-B 必须在 PR-C/D/E 前**：后三者都需要 transition helper。
- **PR-C / PR-D / PR-E 可并行**，但建议串行评审避免冲突。

## 子任务

### RFC-053-T1（PR-A）— 测试 baseline

详见 design.md §测试策略。8 类共 50-80 case：

- T1a：状态转移矩阵（~15 case）
- T1b：多行 dispatch 一致性（~10 case）
- T1c：双层 invariant 演示（~10 case，PR-A 阶段用 utility 直接 SQL）
- T1d：retry cascade 全 kind 矩阵（~8 case）
- T1e：resume 幂等 + race（~8 case）
- T1f：loop / fan-out / wrapper 嵌套（~10 case）
- T1g：approve / iterate / reject 全字段断言（~8 case）
- T1h：property-based 随机事件序列（~3-5 case，可选 fast-check）

**完工标准**：
- 全 case green
- typecheck / lint / format:check / 全 backend 套件 pass count 不下降
- CI 六 jobs 全绿
- 不动任何生产源码

### RFC-053-T2（PR-B）— P-1 node_runs.status 状态机化

- 新文件 `packages/shared/src/lifecycle.ts`（NodeRunStatus / NodeRun
  Event / `nextNodeRunStatus` / `IllegalNodeRunTransition`）
- 新文件 `packages/backend/src/services/lifecycle.ts`（`transition
  NodeRunStatus` + `ConcurrentNodeRunTransition`）
- 替换全部 ~15 处 `db.update(nodeRuns).set({ status: ... })` 为
  `await transitionNodeRunStatus(...)`
- 新 ESLint rule `no-direct-node-run-status-write`（自定义 plugin
  注册到 `eslint.config.js`）+ 白名单
- 新单测：
  - `tests/lifecycle-transition-table.test.ts`（直接对
    `nextNodeRunStatus` 做矩阵断言；与 T1a 一致但走 helper 接口）
  - `tests/lifecycle-cas-race.test.ts`（两个并发 transition 一个
    成功一个抛 `ConcurrentNodeRunTransition`）
  - `tests/eslint-no-direct-status-write.test.ts`（rule 自身的 lint
    测试）

**完工标准**：
- PR-A 所有 case 仍 green
- grep `nodeRuns).set({ status` 在 backend src 下命中 0
  （services/lifecycle.ts 自己内部除外）
- ESLint rule active；违反触发 error
- 新 case 全 green

### RFC-053-T3（PR-C）— P-2 kind handler 表

- 新文件 `packages/shared/src/node-kind-behavior.ts`（导出
  `NODE_KIND_BEHAVIORS` Record，`satisfies` 保证 exhaustiveness）
- 改造调用点：
  - `services/task.ts` retryNode 改查 `NODE_KIND_BEHAVIORS[k].retry
    Cascade === 'mint-placeholder'`
  - `services/limits.ts` enforceLimits（如有 per-node 维度）
  - `services/orphans.ts` reapOrphanRuns
  - `services/gc.ts` runWorktreeGc
  - `services/shutdown.ts` gracefulShutdown
- 新单测：
  - `tests/node-kind-behavior-table.test.ts`（断言每个 NodeKind 在每
    个 behavior 维度上的取值，与 design.md 矩阵一一对照）
  - `tests/eslint-kind-behavior-exhaustiveness.test.ts`（构造一个
    fake NodeKind 验证编译报错——通过 `// @ts-expect-error` 标记 +
    `bun run typecheck` 见证）

**完工标准**：
- PR-A + PR-B 所有 case 仍 green
- retryNode 不再含 hardcoded `NON_PROCESS_KINDS` Set
- 新加 NodeKind 时不填表 → `bun run typecheck` 报错

### RFC-053-T4（PR-D）— P-3 双层 invariant 启动+周期扫

- migration `db/migrations/0028_lifecycle_alerts.sql` + drizzle
  schema 更新
- 新文件 `services/lifecycleInvariants.ts`（R1/R2/C1/T1/T2/T3/U1 七条
  invariant 各一个纯函数 + 入口 `runLifecycleInvariants()`）
- 调度：daemon 启动 5s 后跑一次 `{all: true}`；
  `services/backgroundTasks.ts` 增加每小时 `{since: now-2h}` 调用
- 新路由 `POST /api/tasks/{id}/diagnose` → 调
  `runLifecycleInvariants({ taskScope: { taskId } })` 返回结构化
  alerts
- 新 WS 事件 `tasksListBroadcaster.emit('lifecycle.alert', ...)`
- 新单测：
  - `tests/lifecycle-invariants-review.test.ts`（R1/R2 各 satisfied
    + violated）
  - `tests/lifecycle-invariants-clarify.test.ts`（C1 同上）
  - `tests/lifecycle-invariants-task.test.ts`（T1/T2/T3/U1 同上）
  - `tests/migration-0028.test.ts`（lifecycle_alerts 表结构 + index）
  - `tests/api-tasks-diagnose.test.ts`（端到端调路由 → 返回 alerts）

**完工标准**：
- PR-A + PR-B + PR-C 全绿
- 启动扫见证：本地 daemon 启动后 log "[lifecycle] scanned N tasks,
  M alerts"
- 旧 task（如有遗留 stuck task）首次扫为 severity='warning'，24h 后
  切 'error'

### RFC-053-T5（PR-E）— P-6 stuck-task detector + 前端 UI

- 后端：
  - 新文件 `services/stuckTaskDetector.ts`（S1/S2/S3/S4 检测 + 写
    `lifecycle_alerts`）
  - `backgroundTasks.ts` 每 5 min 调用
  - 路由 `GET /api/tasks/{id}/alerts` 返当前 task 的开放 alerts
- 前端：
  - 新组件 `components/task/StuckTaskBanner.tsx`（红章 + 描述 + 按钮）
  - 新组件 `components/task/TaskDiagnosePanel.tsx`（弹窗，调
    `/diagnose` 路由展示实时检查结果）
  - `routes/tasks.detail.tsx` 顶部接入 Banner
  - `i18n/zh-CN.ts` + `en-US.ts` 新增 `tasks.diagnose.*` 段（对称
    检查走 i18n-keys-symmetry test）
- 新单测：
  - `tests/stuck-task-detector.test.ts`（S1/S2/S3/S4 各 satisfied +
    not-stuck）
  - `tests/api-tasks-alerts.test.ts`（路由返回 + 鉴权）
  - frontend `tests/stuck-task-banner.test.tsx`（有 alerts vs 无 alerts
    渲染，i18n key 命中）
  - frontend `tests/task-diagnose-panel.test.tsx`（按钮触发 → fetch
    `/diagnose` → 渲染结果表格）

**完工标准**：
- PR-A + PR-B + PR-C + PR-D 全绿
- 手动复现：本地起 daemon，故意构造一个 stuck task（修 DB），等 5 min
  后 UI 顶部出红章 + 点 Diagnose 看到 invariant 报告
- i18n-keys-symmetry test 不退化

## 验收清单

合并整个 RFC 后：

- [ ] 全部 5 个 PR 落 origin/main，commit message 前缀 `feat(lifecycle): RFC-053 …`
- [ ] 五次 CI run 都六 jobs 全绿
- [ ] STATE.md "进行中 RFC" 删 RFC-053 条目，移到"最近完成 RFC"
- [ ] design/plan.md RFC 索引 RFC-053 → Done
- [ ] backend 套件 pass count 从 1764 涨到 1820+ （PR-A 加 50-80 case
      + PR-B/C/D/E 各加少量；fail count 不上升）
- [ ] CLAUDE.md（如有相关章节需要更新，例如把"非进程 kind 不级联 retry"
      的隐式约定写进 "Test-with-every-change" 或单独一节）
- [ ] grep 守卫：`nodeRuns).set({ status` 全 0 命中（service/lifecycle.ts
      除外）
- [ ] ESLint 自定义规则触发的回归测试在所有 PR 中保持 green

## 风险 + 兜底

- **风险 1**：T1（PR-A）50-80 case 工作量大，估计 3-5 个工时；中途
  发现 case 写起来很重复 → 把 table-driven test 抽成共用 helper
  （已经在 design.md §测试策略 提到）。
- **风险 2**：T2（PR-B）替换 status 写者时漏掉某处。
  - 兜底：grep 守卫单测 + ESLint rule 双保险。
- **风险 3**：T2 引入 CAS 失败导致原本能跑过的 race 路径开始抛错。
  - 兜底：每个改造点单独跑相关测试，遇到 race 抛错时根据上下文决定
    "log warn + ignore" 还是"upgrade 成 error"。
- **风险 4**：T4（PR-D）启动扫历史 task 触发大量 alert 噪声。
  - 兜底：首次扫 default severity='warning'；运维清理完再切
    'error'（design.md 已写）。
- **风险 5**：T5（PR-E）前端 UI 变动可能与并发 RFC 起冲突。
  - 兜底：按 CLAUDE.md "多人协作并发改动保留原则"，PR 提交前
    `git diff origin/main` 仔细审；遇到冲突先停下问用户。
- **风险 6**：fast-check 引入新 dep（T1h 可选）。
  - 兜底：若用户不批准，T1h 退化为手写 stress 序列（5 条精心挑选）。

## 时间线（粗估）

| PR | 工作量 | 关键内容 |
|---|---|---|
| PR-A | 1-1.5 天 | 50-80 测试，纯加 case |
| PR-B | 0.5-1 天 | helper + 替换 15 处调用点 + ESLint rule |
| PR-C | 0.5 天 | 表 + 替换 4-5 处调用点 |
| PR-D | 1 天 | migration + 7 条 invariant + 调度 + 路由 |
| PR-E | 1 天 | detector + UI banner + diagnose 弹窗 + i18n |

合计约 4-5 工时。
