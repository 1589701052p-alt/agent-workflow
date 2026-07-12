# RFC-W003 - 慢机器 / 时序敏感测试弹性

状态：Draft（待用户批准。按 CLAUDE.md RFC 流程，批准前不改实现代码）

## 1. 背景

upstream sync（PR #6，RFC-147~168）合并后，Windows full-suite CI gate 在一轮实跑中暴露 2 条 flaky（re-run 后均 pass）：

1. **RFC-053 `lifecycle-property.test.ts` T1h**（`packages/backend/tests/lifecycle-property.test.ts:345`）
   - property-based 测试（fast-check `numRuns:30`，per-test 超时 15s）
   - 每迭代 `buildHarness()` spawn ~3-5 个 git 子进程 + 跑 DB migration 集
   - 慢 Windows runner 上 30 轮累计 > 15s -> 超时（`^ this test timed out after 15000ms`）
   - 叠加 `retry-agent` 事件用 `opencodeCmd: ['/usr/bin/env', 'true']`（POSIX-only，Windows ENOENT -> 触发内部重试开销，日志满屏 `spawn opencode failed: ENOENT ... uv_spawn '/usr/bin/env'`）
2. **RFC-098 `rfc098-commitpush-nonblocking.test.ts` B1**（`:238`）
   - `CP_COMMIT_DELAYS: [600, 1500]` sleep + wall-clock 时序断言 `expect(n2Start!.t).toBeLessThan(commit0End!.t)`（~600ms 结构裕量）
   - 慢 Windows runner 上 dispatch 开销吃掉裕量 -> 任务 `status: 'failed'`（不是断言失败，是真实 timing 假设被打破导致节点 run 失败）

确认两测试文件**本次 sync 未改动**（pre-existing on `origin/main` `0e7ffd82`），re-run 后均 pass。非合并回归，是 pre-existing 慢机器 flaky。

全量调研（子 agent 扫描 backend 全测试）确认这是**一类 ~15-25 测试的冰山一角**，分 4 个系统性根因模式（非孤立 2 个点）。RFC-W001 的 S-RFC074（`clarify-review-combination-scenarios` 级联 demote 超 bun:test 默认 5s 超时 -> clobber 共享状态）已修过同款「慢机器超时」根因；本 RFC 是该弹性模式的系统化收口，并覆盖 W001 未触及的另 3 类。

## 2. 失败分类（4 类根因）

### C1: `/usr/bin/env` opencodeCmd POSIX-only（13 文件 ~26 处）

测试用 `opencodeCmd: ['/usr/bin/env', 'true']` 作占位 deps。Windows 上 `/usr/bin/env` 不存在 -> ENOENT。多数是 `resumeTask`/`syncTaskWorkflow` 占位（spawn 路径不触达，agent-not-found 先短路），但 ~5-8 处在 `retryNode(cascade:true)` 后台 `runTask` 路径上，是潜在 ENOENT。`lifecycle-property.test.ts:324` 已实锤 flaky（property 测试随机命中 `retry-agent` 事件）。

涉及文件：`lifecycle-property`、`retry-cascade-kind-matrix`、`retry-node-no-review-cascade`、`rfc096-retry-cascade-inherit`、`rfc098-process-governance`、`rfc108-resume-safety`、`rfc109-sync-task-workflow`、`resume-task-idempotent`、`lifecycle-transitions-current`、`scheduler-audit-gap1-limits-resume-startedat`、`scheduler-audit-s22-canceled-retry-stall`、`scheduler-boundary-resume-retryindex-vs-id`。

**修法**：统一迁移到 W001 既有 `stubCmd()` helper（Windows `['bun','run',path]`，POSIX `[path]`），或跨平台 no-op `['bun','-e','process.exit(0)']`（无需落盘 stub 文件的纯占位场景）。一次扫描全替，平台差异收口到 helper。

### C2: wall-clock 时序断言（3-5 文件）

`rfc098-commitpush-nonblocking`、`scheduler-audit-s17-readonly-starved-by-writer-queue`、`scheduler-boundary-fanout-concurrency` 用 `expect(a.t).toBeLessThan(b.t)` + 固定 sleep 裕量（300-600ms）断言「调度交错」。慢 runner 上 dispatch / spawn 开销吃掉裕量 -> 假红或真失败。

**修法**：改事件驱动轮询（`waitForTraceEvent(agent, phase)` 等 trace 事件出现而非假设 wall-clock 顺序）+ 放宽结构裕量（或改用因果断言「commit 由 n1 完成触发」而非「n2.start < commit0.end」毫秒级）。

### C3: property-based 每迭代 spawn git（1 文件 3 测试）

`lifecycle-property.test.ts` 每迭代 `buildHarness()` spawn ~5 git 子进程 × `numRuns:30`。Windows CI git 慢 3-5x，30 轮累计超 15s。

**修法**：stub-based harness（`buildHarness` 不 spawn 真 git，改用 in-memory git repo 或 stub 掉 `runGit`）或平台感知 `numRuns`（Windows 降到 `numRuns:10`，POSIX 保留 30）。优先前者（不削弱覆盖强度）。

### C4: 硬编码 sleep budget 无慢机器缩放（~8 文件）

`MOCK_OPENCODE_DELAY_MS` / `CP_COMMIT_DELAYS` / `WRITER_DELAY_MS` / `S17_DELAY_MS_FOR_*` 是硬编码常量。慢 runner 上这些 sleep 既是「被吃掉裕量」的源头（C2），也是自身超时风险（sleep + 周边开销累计超 per-test timeout）。

**修法**：引入 `tests/helpers/slow-runner.ts` 的 env 驱动缩放因子（`AW_TEST_DELAY_MULTIPLIER`，默认 1，CI 慢 runner 可设 2-3），所有 delay 常量经它缩放。同时把「结构裕量」（断言用的容差）也经它缩放，使断言与 sleep 同步放大。

## 3. 目标 / 非目标

### 目标

- Windows full-suite CI gate 在慢 runner 上 0 flaky（连续 2 轮 0 fail，不依赖 re-run）
- 4 类根因系统化收口，复用 W001 既有 `stubCmd`/`writeStubOpencode`/`rimrafDir` helpers
- 不削弱测试覆盖语义（POSIX 行为 byte-for-byte 不变；Windows 不降级到 skip 除非有等价覆盖）

### 非目标

- 不改生产代码（C1/C2 若取证发现真生产 bug，另立 issue/RFC，不混入本 RFC）
- 不重写测试框架（沿用 bun:test + 既有 helpers）
- 不删测试（降级/skip 必须有等价覆盖或明确标注原因 + 开 issue）
- 不动 Playwright e2e（另有 visual/e2e 套件，本 RFC 只管 unit/integration）

## 4. 验收标准

1. Windows full-suite gate（`.github/workflows/ci.yml` `Windows full-suite gate` job）连续 2 轮触发 0 fail（不依赖 `gh run rerun`）
2. POSIX CI（ubuntu + macos `Lint + Typecheck + Test`）行为不变，全绿
3. `bun run typecheck && bun run lint && bun run test && bun run format:check` 三门 + 全量测试本地绿
4. C1 的 13 文件 0 处残留 `'/usr/bin/env'` opencodeCmd（源码层 grep 锁）
5. C2/C3/C4 修复各带回归锁测试（防 refactor 退回裸时间戳断言 / 裸 `/usr/bin/env`）
6. RFC-053 `lifecycle-property` + RFC-098 `commitpush-nonblocking` 两条原 flaky 在 Windows CI 上连续稳定 pass
