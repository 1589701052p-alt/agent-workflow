# RFC-W003 - 任务分解

状态：**Done**（2026-07-12 实现 + CI 连续 2 轮验收达成，PR #8 全绿）。用户 2026-07-12 批准「单 PR 全做」；在本分支 `rfc-W003-slow-runner-test-resilience` 上一次性实现，commit 前缀 `fix(test): RFC-W003 ...`，docs 落档 commit 前缀 `docs(rfc): RFC-W003 ...`。

## PR 策略

用户批准**单 PR 全做**（4 类根因 ~25 文件一次性闭环，不分阶段）。执行顺序仍按依赖：T1（helper 基建）-> T3-helper（trace-poll + slow-runner）-> T2 + T3（两条确认 flaky）-> T4（C1 扫荡）-> T5（C2 剩余）-> T7（C4 全量）-> T6（源码锁置 0）-> T8（CI 设缩放）。原 2-PR 拆分作废。

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

**T1-T8 全实现完成**（2026-07-12，单 PR `rfc-W003-slow-runner-test-resilience`，9 commits）：

- **T1** ✅ `noopOpencodeCmd()`（`process.execPath -e process.exit(0)`，零 PATH 依赖）+ 源码锁 `rfc-w003-no-posix-env-cmd.test.ts`（grep backend `tests/` 断言 `/usr/bin/env` opencodeCmd = 0）
- **T3-helper** ✅ `trace-poll.ts`（`waitForTraceEvent` 事件驱动轮询，deadline 超时）+ `slow-runner.ts`（`testDelay`/`testTolerance` 经 `AW_TEST_DELAY_MULTIPLIER` 缩放，默认 1）+ `rfc-w003-helpers.test.ts`（9 case）
- **T2** ✅ lifecycle-property（flaky #1）：`/usr/bin/env 'true'` -> `noopOpencodeCmd()`（C1）+ 3 per-test 超时经 `testDelay`（C3，numRuns 平台感知）。本机 3 pass。
- **T3** ✅ rfc098-commitpush（flaky #2）：`waitForTraceEvent` 替 `expect(n2Start.t < commit0End.t)` 墙钟断言（C2）+ `CP_COMMIT_DELAYS`/`CP_DELAY_MS_FOR_*` 经 `testDelay`（C4）。本机 3 pass。
- **T4** ✅ C1 扫荡 11 文件（26 处）`/usr/bin/env 'true'` -> `noopOpencodeCmd()`。源码锁随扫递减至 0。
- **T5** ✅ C2 剩余：s17 `WRITER_DELAY_MS` 经 `testDelay` + fanout-concurrency `MOCK_OPENCODE_DELAY_MS` + `toBeGreaterThan(1000)` 经 `testTolerance` + 预算经 `testDelay`。s17 本机 1 pass。
- **T6** ✅ 源码锁 `expect(total).toBe(0)` 收尾，清理「扫荡进行中」措辞为「回归锁」。
- **T7** ✅ C4 全量：runner（2000×2）/ runner-subagent-live-capture（400）/ canceled-fanout（1000 + 30_000 预算）/ scheduler（2000/1500 + 30_000 预算防 MULT=2 下 41%->11% 余量超时 / 250）/ rfc130（0×2 约定统一）经 `testDelay`。本机 runner 9/0、runner-subagent 3/0、canceled-fanout 1/0、scheduler 我 3 编辑测试全 pass 且 vs baseline 零回归。
- **T8** ✅ `ci.yml` check-windows Test 步设 `env: AW_TEST_DELAY_MULTIPLIER='2'`。

**门禁**（2026-07-12，rebase 到含 PR#6 upstream-sync 的 origin/main 后）：typecheck×3 全绿 / lint 全绿 / `format:check` 全绿 / 源码锁 0 / 2 目标 flaky 本机连过 / scheduler vs baseline 零回归。本机 git 依赖测试（loop / wrapper-git / retries）预存失败（temp worktree 非真 git repo，baseline 同形、非本 RFC 引入），由 CI Windows gate 验。

**✅ CI 验收达成**（2026-07-12，PR #8）：全 17 检查全绿（ubuntu/macOS 全后端套件 + 3 OS single-binary build + 4 Playwright e2e shard + Static scans/Perf/Markdown）。`check-windows` **连续 2 轮** `bun test --timeout 60000`（`AW_TEST_DELAY_MULTIPLIER=2`）success：run #1（job 86630952033）+ run #2（job 86631324252），5239 测试 0 fail。2 目标 flaky（RFC-053 / RFC-098）CI 全 pass。

**修复中暴露并修的 1 个 helper bug**：`rfc-w003-helpers.test.ts` 的 "default multiplier 1 = identity" 在 Windows CI（`AW_TEST_DELAY_MULTIPLIER=2`）下 fail - `slow-runner.ts` 的 `MULT` 在模块加载时捕获一次（race-free），但测试运行时 `delete process.env` 对已捕获 `MULT` 无效（dead code）。修法：断言改相对缩放契约 `testDelay(ms) === ms * testDelayMultiplier`，去掉 env mutation；dev(MULT=1) 与 CI(MULT=2) 均过。Windows gate run #1 唯一 fail 即此，修后 run #1' 全绿。

**RFC-W003 状态：Done。** STATE.md 进行中 -> 已完成；plan.md RFC 索引 In Progress -> Done。
