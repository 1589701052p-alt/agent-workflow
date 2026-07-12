# RFC-W003 - 技术设计

## 1. 核心原则

1. **复用 W001 既有 helpers**：`stubCmd` / `writeStubOpencode` / `writeStubScript`（`tests/helpers/stub-runtime.ts`）+ `rimrafDir`（`tests/helpers/cleanup.ts`）。本 RFC 不新建平行的平台分流 helper，只补一个「慢机器缩放」helper（C4）+ 一个「trace 事件轮询」helper（C2）。
2. **平台差异收口到 helper**：测试文件不散落 `if (process.platform === 'win32')`；POSIX 行为 byte-for-byte 不变（helper 在 POSIX 上是透传/默认值）。
3. **因果优先于墙钟**：C2 的核心是从「假设两个事件在 N ms 内发生」改为「等两个事件都发生后再断言其因果顺序」。墙钟只用于「不该超过 X」的松边界。
4. **不削弱覆盖**：C3 优先 stub harness（覆盖强度不变），降 `numRuns` 是 fallback（标注覆盖折损）。

## 2. 各类修复设计

### 2.1 C1: `/usr/bin/env` opencodeCmd -> 跨平台 stub（13 文件 ~26 处）

**判定分叉**（决定用哪种替代）：

- **A. 纯占位 deps（spawn 路径不触达）**：如 `resumeTask`/`syncTaskWorkflow` 的 `opencodeCmd`，agent-not-found 先短路。→ 用跨平台 no-op `['bun', '-e', 'process.exit(0)']`。无需落盘文件，零 IO，POSIX/Windows 等价。
- **B. 真会 spawn 的占位**：如 `retryNode(cascade:true)` 触发后台 `runTask`，spawn 路径会触达。→ 用 W001 `writeStubOpencode(tmpDir, {...})` + `stubCmd(stubPath)`，确保 spawn 成功且吐合法 envelope。

**收口位置**：`tests/helpers/stub-runtime.ts` 加一个导出 `noopOpencodeCmd(): string[]`（返回平台 no-op argv），让所有 A 类调用点一行替换；B 类直接用既有 `stubCmd`。

**源码锁**（回归防护，CLAUDE.md「最低限度兜底」）：新增 `tests/rfc-w003-no-posix-env-cmd.test.ts`，grep backend `tests/` 全目录断言 `opencodeCmd:\s*\['/usr/bin/env'` 出现次数 = 0。未来任何 refactor 重新引入 `/usr/bin/env` 即红。

**改动文件**（13）：见 proposal §C1 列表。逐文件 `opencodeCmd: ['/usr/bin/env', 'true']` → `noopOpencodeCmd()` 或 `stubCmd(writeStubOpencode(...))`。

### 2.2 C2: wall-clock 时序断言 -> 事件驱动轮询 + 因果断言

**新增 helper** `tests/helpers/trace-poll.ts`：

```ts
// 等待 trace.jsonl 出现指定 (agent, phase, callIndex?) 事件，带超时。
// 取代裸 `expect(a.t < b.t)` + 固定 sleep：先确保两事件都发生，
// 再断言其因果顺序（commit0 由 n1 完成触发 -> commit0.start >= n1.end
// 是因果硬约束；n2 在 commit0 期间被 dispatch 是设计约束，用
// 「n2.start 存在 && commit0.end 存在」+ 设计注释，不锁毫秒级 <）。
export async function waitForTraceEvent(
  stateDir: string,
  agent: string,
  phase: 'start' | 'end',
  opts?: { callIndex?: number; timeoutMs?: number },
): Promise<TraceEvent>
```

**`rfc098-commitpush-nonblocking.test.ts` 改法**：

- `expect(n2Start!.t).toBeLessThan(commit0End!.t)` → 先 `await waitForTraceEvent(... n2 start)` + `await waitForTraceEvent(... commit0 end)`，再断言 `n2Start.t < commit0End.t`。语义不变（仍锁「dispatch loop 未冻结」），但不再假设 wall-clock 在 600ms 内必发生——轮询等到发生为止（带 10s 上限防死锁）。
- `expect(commit0Start!.t).toBeGreaterThanOrEqual(n1End!.t)` → 因果硬约束，保留（commit 由 n1 完成触发，start 必 >= n1.end），但同样先 waitFor 两事件。
- `expect(t?.status).toBe('done')` → 任务 `failed` 的根因（C2 真失败）需单独排查：可能是慢 runner 上 n2 spawn 时机错位导致 commit session 序列破坏。若排查发现是测试 timing 假设过紧（非生产 bug），放宽 `CP_COMMIT_DELAYS`（经 C4 缩放）；若发现真生产 race，另立 issue 不混入本 RFC。

**`scheduler-audit-s17` + `scheduler-boundary-fanout-concurrency`**：同款「等事件 + 因果断言」模式，`WRITER_DELAY_MS=300` / `MOCK_OPENCODE_DELAY_MS=400` 经 C4 缩放放大。

### 2.3 C3: property-based 每迭代 spawn git -> stub harness

**`lifecycle-property.test.ts` `buildHarness()` 现状**：每迭代 `mkdtemp` + `git init` + 3-5 次 `runGit`（建 repo / commit / 等）。

**方案 A（优先）：stub 掉 `runGit`**。`buildHarness` 注入一个 in-memory 或 tmpfs 的 git repo 句柄，`runGit` 改走「预置的 fixture repo + 极少真 git 调用」。难点：`runTask` 内部真调 `git`（snapshot/diff），全 stub 会偏离被测行为。

**方案 B（fallback）：平台感知 `numRuns`**。

```ts
const numRuns = process.platform === 'win32' ? 10 : 30
fc.asyncProperty(..., { numRuns })
```

覆盖折损（Windows 10 轮 vs POSIX 30 轮），但 property 测试本就是概率覆盖，10 轮仍能抓大部分不变量违反。per-test 超时从 15s 提到 30s（经 C4 缩放）。

**决策**：先试 A（若 `buildHarness` 的 git 调用能隔离到可 stub 的薄层则覆盖不折损）；A 不可行则 B。实现期定。

### 2.4 C4: 硬编码 sleep budget -> env 驱动缩放

**新增 helper** `tests/helpers/slow-runner.ts`：

```ts
// CI 慢 runner（尤其 Windows）可设 AW_TEST_DELAY_MULTIPLIER=2 放大所有
// 测试 sleep 与结构裕量。默认 1（POSIX / 快机器 byte-for-byte 不变）。
const MULT = Number(process.env.AW_TEST_DELAY_MULTIPLIER ?? '1') || 1
export const testDelay = (ms: number): number => ms * MULT
// 用于断言容差（与 sleep 同步放大，避免「sleep 放大了但断言边界没放」错位）
export const testTolerance = (ms: number): number => ms * MULT
```

**收口**：所有 `CP_COMMIT_DELAYS` / `MOCK_OPENCODE_DELAY_MS` / `WRITER_DELAY_MS` / `S17_DELAY_MS_FOR_*` 经 `testDelay()` 计算。CI `Windows full-suite gate` job 设 `AW_TEST_DELAY_MULTIPLIER: 2`（或按实测调）。

**注意**：`bun test --timeout 60000`（W001 已设）覆盖 per-test 上限；C4 的 sleep 缩放是让「测试内部 timing 假设」与「慢机器现实」对齐，不是改 per-test 上限。

## 3. 测试策略

- **C1 源码锁**：`tests/rfc-w003-no-posix-env-cmd.test.ts` grep 锁 0 处 `/usr/bin/env` opencodeCmd（防退回）。
- **C2 helper 单测**：`waitForTraceEvent` 覆盖「事件已存在立即返回」「等至出现」「超时抛」3 case。
- **C3**：保留既有 property 不变量断言（修法不改被测不变量），加「Windows numRuns 降级不丢核心不变量」注释锁。
- **C4 helper 单测**：`testDelay`/`testTolerance` 默认 1（POSIX 等价）、`AW_TEST_DELAY_MULTIPLIER=2` 线性放大。
- **原 2 条 flaky**：`lifecycle-property` + `rfc098-commitpush-nonblocking` 在 Windows CI 上连续 2 轮 pass 作验收。
- **门禁**：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；Windows full-suite gate 连续 2 轮 0 fail。

## 4. 失败模式

- **C2 排查发现真生产 race**：若 `rfc098` 任务 `failed` 是真生产 timing bug（非测试假设过紧），停止本 RFC 改测试，另立生产 bug RFC（不在本 RFC 混改生产代码）。取证：本地用 `AW_TEST_DELAY_MULTIPLIER=3` 复现，看是测试假设还是真 race。
- **C3 方案 A 不可行**：fallback 到方案 B（`numRuns` 降级），在 plan.md 标注覆盖折损 + 开 issue 跟踪未来补强。
- **C4 缩放系数难定**：先默认 2，CI 实跑观察 flake 是否消失；若仍 flake 调到 3，若 POSIX 受影响（不该）则排查 helper 透传 bug。
- **stub 行为偏移**：C1 B 类用 `writeStubOpencode` 替 `/usr/bin/env true` 后，stub 会吐 envelope，可能改变被测代码路径（原来 ENOENT 走失败路径，现在走成功路径）。逐文件验证：若测试本就期望失败路径，改用 `writeStubOpencode({fail:true})`；若期望成功，原 `/usr/bin/env` 在 POSIX 上本就「成功 exit 0」，stub 等价。
- **rebase 与 sync PR #6**：本 RFC 从 `origin/main` 切，sync PR #6 合并后若触及同文件，rebase 时逐个调和（两改动正交：sync 不改这 13 个测试文件的 `/usr/bin/env` 行，本 RFC 不改 sync 的生产代码）。
