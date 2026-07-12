# RFC-W003 - 任务分解

状态：Draft（待用户批准）。批准后按 PR 顺序执行。每 PR 走分支 + PR 到 main（CLAUDE.md branch workflow），commit 前缀 `fix(test): RFC-W003 ...`。

## PR 拆分建议

scope 较大（4 类根因 ~25 文件），拆 2 个 PR 平衡 review 体积与回归隔离：

- **PR-1（确认 flaky 修复）**：T1（C1 helper）+ T2（lifecycle-property 实锤 flaky：C1 + C3）+ T3（rfc098-commitpush 实锤 flaky：C2 + C4 helper）+ T6（C1 源码锁）。锁住用户已看到的 2 条 flaky。
- **PR-2（同类硬化扫荡）**：T4（C1 剩余 12 文件扫荡）+ T5（C2 剩余 s17/fanout-concurrency）+ T7（C4 全量 delay 经缩放）+ T8（CI 设 `AW_TEST_DELAY_MULTIPLIER`）。

若 PR-1 review 后发现 scope 应收窄，PR-2 可延后或拆更细。

---

## T1: C1 helper + 源码锁基建

- `tests/helpers/stub-runtime.ts` 加 `noopOpencodeCmd(): string[]`（跨平台 no-op argv，POSIX `['bun','-e','process.exit(0)']` 即可，无需落盘）
- 新增 `tests/rfc-w003-no-posix-env-cmd.test.ts`：grep backend `tests/` 断言 `opencodeCmd:\s*\['/usr/bin/env'` 计数 = 0（先标 `// 当前 N 处，本 RFC 收尾后置 0` 跟踪进度）
- 无生产改动

## T2: lifecycle-property（C1 + C3，实锤 flaky #1）

- `retry-agent` 事件的 `opencodeCmd: ['/usr/bin/env', 'true']`（:324）-> `noopOpencodeCmd()`（C1）
- C3：先试方案 A（stub `buildHarness` 的 git 调用薄层）；不可行则方案 B（`numRuns` 平台感知 + per-test 超时经 C4 缩放）
- 验收：本机 Windows `bun test tests/lifecycle-property.test.ts --timeout 60000` 连续 3 轮 0 fail

## T3: rfc098-commitpush-nonblocking（C2 + C4，实锤 flaky #2）

- 新增 `tests/helpers/trace-poll.ts`：`waitForTraceEvent(stateDir, agent, phase, opts)`（事件驱动轮询，带超时）
- 新增 `tests/helpers/slow-runner.ts`：`testDelay(ms)` / `testTolerance(ms)`（env `AW_TEST_DELAY_MULTIPLIER` 缩放，默认 1）
- `rfc098-commitpush-nonblocking.test.ts`：`expect(n2Start.t < commit0End.t)` 改先 `waitForTraceEvent` 再断言；`CP_COMMIT_DELAYS` 经 `testDelay`
- **C2 排查**：先用 `AW_TEST_DELAY_MULTIPLIER=3` 本地复现任务 `failed`，判定是测试假设过紧（按 T3 放宽）还是真生产 race（另立 issue，本 RFC 不改生产代码）
- 验收：本机 Windows 连续 3 轮 0 fail

## T4: C1 剩余 12 文件扫荡

`retry-cascade-kind-matrix` / `retry-node-no-review-cascade` / `rfc096-retry-cascade-inherit` / `rfc098-process-governance` / `rfc108-resume-safety` / `rfc109-sync-task-workflow` / `resume-task-idempotent` / `lifecycle-transitions-current` / `scheduler-audit-gap1-limits-resume-startedat` / `scheduler-audit-s22-canceled-retry-stall` / `scheduler-boundary-resume-retryindex-vs-id` + `lifecycle-property`（T2 已改的不再重复）。

逐文件：`opencodeCmd: ['/usr/bin/env', 'true']` -> `noopOpencodeCmd()`（A 类占位）或 `stubCmd(writeStubOpencode(tmpDir))`（B 类真 spawn）。T1 源码锁计数应随扫荡递减至 0。

## T5: C2 剩余时序断言

- `scheduler-audit-s17-readonly-starved-by-writer-queue.test.ts`：overlap 断言 + `WRITER_DELAY_MS=300` -> `waitForTraceEvent` + `testDelay`
- `scheduler-boundary-fanout-concurrency.test.ts`：`expect(elapsed).toBeGreaterThan(1000)` + `MOCK_OPENCODE_DELAY_MS=400` -> 经 `testDelay` 缩放 + 容差经 `testTolerance`

## T6: C1 源码锁置 0

T4 扫荡完，`tests/rfc-w003-no-posix-env-cmd.test.ts` 断言置 `toBe(0)`，移除进度跟踪注释。

## T7: C4 全量 delay 经缩放

扫所有 `CP_COMMIT_DELAYS` / `MOCK_OPENCODE_DELAY_MS` / `WRITER_DELAY_MS` / `S17_DELAY_MS_FOR_*` / `CP_DELAY_MS_FOR_*` 硬编码，经 `testDelay()`。结构裕量断言经 `testTolerance()`。

## T8: CI 设慢机器缩放

- `.github/workflows/ci.yml` `Windows full-suite gate` job 加 `env: AW_TEST_DELAY_MULTIPLIER: 2`（按实测调，PR-2 验证后定值）
- 验收：Windows gate 连续 2 轮触发 0 fail

## 执行顺序

PR-1：T1 -> T2 + T3（依赖 T1 helper）-> T6 部分锁
PR-2：T4 -> T5 -> T7 -> T8 -> T6 置 0

---

## 完成状态

（待批准后实现填入）
