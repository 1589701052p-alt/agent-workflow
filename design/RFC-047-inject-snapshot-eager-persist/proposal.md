# RFC-047 — 注入记忆快照在 inject 阶段就落库（不再等到 run 结束）

## 1. 背景

RFC-046 已经把"本次 run 注入的 memory 集合"以快照形式落到 `node_runs.injected_memories_json`，但**写入时机**绑死在 run 结束的总 UPDATE 上（`packages/backend/src/services/runner.ts:772-792` 那条把 `status / finishedAt / inventorySnapshotJson / injectedMemoriesJson / tokInput …` 一并写出的语句）。

实际上 `injectedSnapshot` 早在 opencode 子进程**启动前**就已经决出了：

- `runner.ts:330-355` 走 `injectMemoryForRun` 完成 budget 裁剪后得到 `snapshot`。
- `runner.ts:356-392` 的 envelope-followup 分支走 `loadInjectedSnapshotFromFirstAttempt` 也已经拿到 `snapshot`。

之后 inject 路径在内存里持有这个对象不动，直到 opencode 退出、`inventorySnapshotJson` 也读完才统一写出。

带来的实际问题：**任务详情 → agent 节点 drawer → Session 页签** 里 RFC-046 的 `Injected memories (N)` 卡片在 run 还在跑（`status = running`）时一直显示"未捕获 / 0 条"——admin 必须等 session 结束才能确认"本次 inject 到底放了哪几条进来"，而这正是 RFC-046 §S1 的目标：批完一条记忆立刻去 task 里核对。runtime inventory 卡片同样要等到结束才出（这块由 dump 插件落盘时机决定，**不在本 RFC 范围**，留作单独 caveat）。

## 2. 目标

把 `injected_memories_json` 的写入时机从"run 结束的总 UPDATE"前置到 "inject 解析完成之后、spawn opencode 之前"，让前端 Session 页签在 run 进行中就能看到注入快照。

### 2.1 必须做到

- **早写**：在 `runner.runNode` 的 inject 阶段结束、并且即将构造 `OPENCODE_CONFIG_CONTENT` 之前，立即对当前 `node_runs.id` 做一次只更新 `injectedMemoriesJson` 单列的 UPDATE；正常路径与 envelope-followup 路径走同一处。
- **最终 UPDATE 不变**：run 结束时那条总 UPDATE 仍然写出 `injectedMemoriesJson`（值与早写一致）。早写只是把列**提前填上**，不是搬走总 UPDATE 的写入；保留总 UPDATE 的写法保证一旦早写崩了（DB 临时不可写），run 结束仍能补落，行为字节级兼容 RFC-046。
- **失败降级**：早写自身失败（DB 异常）→ warn log + 继续 run，不让 inject 视察体验把 run 拖崩。
- **WS 通知**：早写落库后，emit 一次现有的 `node.status`（status 仍是 `running`）或新走一次 `node.event` 触发前端 `useTaskSync` 的 `['tasks', taskId, 'node-runs']` invalidate，让 Session 页签自动刷出注入快照，admin 不必手动刷页面。
- **NULL 语义不变**：inject 返回 `null`（block 未拼出来 / 失败降级 / followup 拿不到 attempt 0）时早写也写 NULL，与 RFC-046 §3.2 「未注入 vs 空集合 vs pre-RFC」三态规则一致。
- **范围只动 inject 一列**：本 RFC **不**触碰 `inventory_snapshot_json` / `tokInput / status / finishedAt` 等其它列，这些保持 run 结束总 UPDATE 处理。

### 2.2 非目标（v1 不做）

- **不**早写 runtime inventory（`inventory_snapshot_json`）——它依赖 dump 插件在 opencode 退出时落盘的 JSON 文件，结构性必须等结束。本 RFC 不修改这块的 UX，但前端可以独立加一句运行时提示文案（不属于本 RFC 验收）。
- **不**改 inject 行为本身（不改预算 / 不改 scope 选择 / 不改 `formatMemoryBlock` 文本）。
- **不**回填历史 node_runs（pre-RFC-046 行仍 NULL，RFC-046 §S3 老 task 文案不变）。
- **不**引入新 WS 消息类型；复用现有 `node.status` / `node.event` 触发的 invalidate 路径。
- **不**改 schema / migration / shared 类型（已有 `injected_memories_json` 列 + `InjectedMemorySnapshot` 类型即可）。

## 3. 用户故事

### S1：admin 在 run 进行中就核对 inject

admin 在 `/memory` 批了一条新记忆，回到 `/tasks/<id>` 等待新任务。agent 节点切到 `running` 后 5 秒，她开 drawer → Session 页签，attempts 切换器下方的 `Injected memories (3)` 卡片**已经**填好了：scope chip / version / preview 都在，能直接展开看 body_md。不再需要等节点 done 才看见。

### S2：inject 失败也立即可见

inject 在 budget clip 阶段抛错（罕见，比如 memory body 含损坏的 UTF-8）→ runner 的 `try/catch` warn 之后 `injectedSnapshot` 留 null，早写也写 null，Session 页签卡片立即显示 "Inject record not captured" —— admin 不必等 run 结束去判断"这是 pre-RFC-046 老行还是本次 inject 出问题"，可以直接结合事件流定位。

### S3：envelope-followup 同样早写

agent 第一次 envelope 解析失败，RFC-042 拉回 followup attempt 1。runner 进入 followup 分支后从 attempt 0 copy 出 snapshot，早写到当前行；Session 页签切到 attempt 1 立刻看到 `Inherited from attempt 0` chip + 完整列表，不必等 followup 跑完。

### S4：早写崩了不影响 run

DB 偶然繁忙、早写 UPDATE 抛 SQLite busy → runner warn 一行 `inject-snapshot-eager-write-failed` 继续往下跑；run 结束总 UPDATE 仍写出 `injectedMemoriesJson`。admin 看不到中途快照，但 run 完成那一瞬间和今天 RFC-046 行为相同——零退化。

## 4. 验收标准

- **行为**：任意 agent-kind node_run 从插入起到 inject 完成之间，`injected_memories_json` 列从 NULL 翻到最终值；spawn opencode 之前列已落库；run 结束总 UPDATE 写入同一值。
- **代码层 grep 守卫**：`runner.ts` 必须出现且仅出现一次形如 `inject-snapshot-eager-write` 标识的早写调用点；总 UPDATE 那条 `injectedMemoriesJson:` 行保留。
- **WS**：早写后触发的 invalidate 在前端 `useTaskSync` 里命中 `['tasks', taskId, 'node-runs']` —— 复用现有 `node.status` running 广播或新增一次 `node.event` 即可。
- **失败降级**：早写 SQL throw 时 runner 不抛、log warn、run 继续；总 UPDATE 兜底写入。
- **followup 路径**：`opts.envelopeFollowup === true` 同样早写（snapshot 来自 attempt 0 copy）。
- **测试**（详见 design.md §测试策略）：
  - 单元：runner 在 inject 完成后即写 column（mock spawn → 断言此时 SELECT 该 column 不为 NULL）。
  - 单元：早写抛错 → runner 继续 + 总 UPDATE 仍落 column。
  - 单元：followup 路径早写 copy 自 attempt 0。
  - 单元：WS broadcaster 至少触发一次 invalidate 等价的 `node.status running` 或 `node.event`。
  - 回归：RFC-046 既有 92 个测试零退化。
- **零 schema/migration 改动**；**零前端代码改动**（卡片本身已实现，只是更早看到数据）；可选前端只补一行 `Live` 状态提示，但不作硬验收。
- **三件套全绿**：`bun run typecheck && bun run test && bun run format:check`；GitHub Actions 六 job 全绿。

## 5. 与既有 RFC 的关系

- **RFC-046**（落 Done）：本 RFC 是 RFC-046 的直接 follow-up，复用其 schema / column / 前端卡片。RFC-046 §3.2 「inject 解析完成后顺手落库」的措辞在本 RFC 里**严格执行**——RFC-046 实现选择了"跟总 UPDATE 一起落"作为最小侵入版，本 RFC 把它拆出来让 UX 真正可见。
- **RFC-042**（envelope followup）：followup 路径走 `loadInjectedSnapshotFromFirstAttempt`，本 RFC 同样早写。
- **RFC-041**（memory inject）：不动 inject 行为，仅在已有 snapshot 上多走一次 UPDATE。
- **RFC-045**（manual memory edit）：RFC-045 PATCH 后 `node_runs.injected_memories_json` 的 byte-equal 不变量本 RFC 同样满足（早写值与总 UPDATE 值字节相等）。
- **runtime inventory**（RFC-029）：本 RFC **不**改其落盘时机，[[design-rfc047]] §6 留作 caveat。
