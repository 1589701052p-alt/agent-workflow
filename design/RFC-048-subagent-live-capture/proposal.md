# RFC-048 — Subagent 会话事件运行中实时回流（不再等到 child 退出）

## 1. 背景

RFC-027 T3 已经能在 agent 节点结束后把所有 subagent（opencode 的 child session）的对话搬进 `node_run_events`，前端 SessionTab 通过 `parseSessionTree` 递归渲染任意深度的子对话。但**实时性**目前为 0：subagent 整段对话只有在父 opencode 子进程退出后那一次 `captureChildSessions`（`runner.ts:727-742`）才被批量落库——用户在任务详情页看到的表现是「跑了 10 分钟，前 9 分 59 秒空白，最后一秒整段刷出来」。

根因有两条结构性约束：

1. **opencode `run` 子命令不暴露 HTTP 端口**：用的是 in-process server（`opencode/packages/opencode/src/cli/cmd/run.ts:806/838`），外部 runner 无法 subscribe child-session 事件。
2. **父 session 的 stdout 不携带 child 事件**：我们的 `stdoutPump`（`runner.ts:551`）只能拿到 root session 自己的 message/part。child session 的 message/part 全部只写进 opencode 自己的 XDG SQLite（`opencode/packages/opencode/src/storage/db.ts:33` → `~/.local/share/opencode/opencode.db`，xdg-basedir）。

因此即便 RFC-027 已经把 SQLite 回流路径接通，时机仍卡死在「子进程退出之后」，subagent 在运行中的进度对用户完全不可见——RFC-047 改完注入快照实时性之后，subagent 对话的实时性就成了 Session 页签可见性方面唯一剩下的大块短板。

## 2. 目标

把 `captureChildSessions` 从「post-run 一次性 BFS」改造成「**运行中按固定节拍轮询 + post-run 最后一次兜底**」，让任务详情 → agent 节点 drawer → Session 页签里 subagent 的对话**随着 child session 写盘逐步浮现**，频率与 opencode 自身写 SQLite 的延迟同量级（秒级）。

### 2.1 必须做到

- **运行中轮询**：runner spawn opencode 子进程之后、`await child.exited` 之前，并行启动一个 `subagentLivePoller`。固定节拍（默认 1500ms，下限 250ms，上限 60s，0 = 关）以**只读**方式打开 opencode SQLite，跑与 `captureChildSessions` 同样的 BFS，但只 INSERT **本 nodeRun 尚未写过**的 `(sessionId, partId)` 行。
- **内存级 dedupe**：每个 nodeRun 维护一份 `Map<sessionId, Set<partId>>`，每次 tick 增量 INSERT 后更新；进程退出时释放。沿用 RFC-027 §UX merge / RFC-026 inline-mode dedup 的 `loadSiblingsCapturedSessionIds` 兄弟 sessionId 排除（不在本 nodeRun 写过、但在同一 task 别的 nodeRun 已经写过的 child session 整体 skip）。
- **WS 通知**：每次 tick **真有新行**写入时，broadcast 一条 `node.event` 让前端 `useTaskSync` invalidate `['tasks', taskId, 'node-runs']` + `['tasks', taskId, 'node-runs', nodeRunId, 'session']` 触发 SessionTab 重拉 `/session` 接口。空轮询不广播。
- **失败降级**：任意一次 tick 抛错 / opencode DB schema 变化 / 文件缺失 → log warn + 跳过本 tick；**不**写 `subagent_capture_failed` marker（marker 只在 post-run 兜底处写一次，保持 RFC-027 既有语义）；连续失败 N 次（默认 5）→ 自动 disable 本 nodeRun 的 live poll，等 post-run 兜底走老路径。
- **Post-run 兜底**：runner 末段那条 `captureChildSessions` **保留**，跑最后一次完整 BFS 把 child 退出后才 flush 的尾部 part 行 catch 进来 + 若 live poll 全程 disable 时承担全部回流。Post-run capture 同样走 dedupe（既有逻辑：本 nodeRun 已经写过的 sessionId 不会重复 INSERT；本 RFC 新增 partId-level dedupe 让它在 live poll 写过一半时也能补尾）。
- **Config**：新加 `subagentLiveCapture: { pollMs: number; consecutiveFailureLimit: number }`，落 `packages/shared/src/schemas/config.ts`，默认 `pollMs=1500 / consecutiveFailureLimit=5`，`pollMs = 0` 表示完全关闭（行为退化到 RFC-027）。
- **零前端代码改动**：SessionTab 已经能渲染部分到位的 child（`SubagentBlock.tsx:19-20` `captureMissing` 分支已有 UI）；本 RFC 落地后 child 节点会随轮询逐步从「captureMissing + outputFallback」过渡到「captureComplete + 完整 ConversationFlow」。可选小补丁：在 `SubagentBlock` 头部 status chip 与 `captureMissing` 文案上加一句「Live · capturing…」提示（非硬验收）。
- **零 schema / migration 改动**：`node_run_events` 表结构不动，partId-level dedupe 走内存 Set；`(sessionId, parentSessionId)` 列由轮询写入时按 child sess 的 `parent_id` 填，与既有 capture 行同构。
- **opencode 源码不动**：本 RFC 全程只读 opencode SQLite。如果未来 opencode 升级改 `session / message / part` schema，本 RFC 同 RFC-027 一样退化到 `subagent_capture_failed` marker——这是已知 caveat，不在本 RFC 修复。

### 2.2 非目标（v1 不做）

- **不**修改 opencode 自身（不加 HTTP endpoint / 不改 storage schema）。
- **不**做 push-based 流式（基于 SQLite WAL 文件 inotify / `pragma wal_checkpoint` hook 之类）——poll 已经够用，复杂度不值得。
- **不**对 `node_run_events` 做唯一索引（partId 走内存 dedupe；如未来要做持久化 dedupe 另立 RFC）。
- **不**改 runtime inventory（RFC-029）落盘时机——dump plugin 在 opencode 退出时才能 flush，结构性约束。
- **不**改主 session（parent）的 stdout 事件回流路径——`stdoutPump` 不动。
- **不**回填 pre-RFC-048 已存的 task：这是纯运行时改造，历史 task 看到的依然是 RFC-027 post-run 一次性回流的形态。

## 3. 用户故事

### S1：长跑 subagent 的进度可见

agent 节点调用一个 `task` 工具跑代码审计子任务，整个 child session 跑 8 分钟、产出 30 条 message。用户开 task 详情 → Session 页签，看到 `🪆 subagent — running` 卡片 5 秒后里面已经出了 1-2 条消息，每隔 1.5 秒新行刷出，不必等 8 分钟后整段炸出来。

### S2：嵌套 subagent 也实时可见

subagent A 又调用 subagent B（深度=2）。SessionTab 的 ConversationFlow 递归渲染——B 的对话也按节拍刷新，A 卡片内部嵌套的 B 卡片同样从「captureMissing」过渡到完整 ConversationFlow。这条直接复用现有递归 BFS 与 `parseSessionTree`，零额外前端改动。

### S3：opencode DB 临时不可读

某次 tick 撞到 opencode 升级换 schema / 文件被 lock / 磁盘满 → log warn 一次，继续下一 tick；连续失败 5 次后本 nodeRun 自动停轮询，warn 一条 `subagent-live-poll-disabled`，等 post-run 兜底走 RFC-027 老路径写 `subagent_capture_failed` marker（如它也失败）或正常 BFS 回流。Run 本身不退化。

### S4：用户关掉实时同步

admin 在 `/settings` 把 `subagentLiveCapture.pollMs` 设成 `0`（或者发现某些环境下 SQLite 读取扰动写入），行为完全退化到 RFC-027：subagent 对话仍然会在 child 退出后批量出现，零回归。

### S5：inline-mode rerun

RFC-026 clarify inline session resume 让同一 opencode session 多轮跑：第一轮 round 0 subagent 跑完后 live poll + post-run 都写过 child events。round 1 的 nodeRun（同 session, 同 child sessionId）继续轮询时——`loadSiblingsCapturedSessionIds` 已经在兄弟 nodeRun 看见过这些 child sessionId，整段 skip——`node_run_events` 仍然由 round 0 nodeRun 持有，不会重复。前端切到 round 1 attempt 时 SessionTab 端的 `/session` 接口本身会按 `opencodeSessionId` 联合查询拿到完整树（RFC-027 已经做了；本 RFC 不动）。

## 4. 验收标准

- **行为**：spawn opencode 之后，subagent 的 message/part 写入 opencode SQLite 后**≤ `pollMs + 一次 BFS 耗时`** 内出现在 `node_run_events`，并通过 WS 触发前端刷新。`pollMs=1500` 默认下用户感受为 1-2 秒延迟。
- **零重复**：跨 tick / 跨 live↔post-run / 跨 inline rerun 的 message/part 行不会重复写入 `node_run_events`（按 partId 内存 Set + 兄弟 nodeRun 排除）。
- **post-run 兜底**：禁用 live poll（`pollMs=0`）时行为与 RFC-027 字节级一致；开启 live poll 时，post-run capture 仍跑一次但 INSERT 行数 = 仅 live poll 在最后一次 tick 之后 flush 的 part 行数。
- **失败语义**：tick 抛错 → warn `subagent-live-poll-error`；连续失败 ≥ `consecutiveFailureLimit` → warn `subagent-live-poll-disabled`；post-run 兜底仍按 RFC-027 跑。
- **WS**：tick 真有新行 INSERT 时 broadcast 一条 `node.event`，payload 形如 `{ type: 'node.event', nodeRunId, nodeId, kind: 'subagent.events.appended', insertedRows, sessionIds }`；空轮询不广播。复用 `useTaskSync.ts:31-35` 既有 invalidate 路径。
- **Config**：`subagentLiveCapture.pollMs ∈ [0, 60000]` 整数（0 = off），`consecutiveFailureLimit ∈ [1, 100]` 整数；越界由 zod 拒绝；`/api/config` PATCH 走既有路径。
- **代码层 grep 守卫**：runner.ts 出现 `'subagent-live-poll'` 字面恰好 1 次；sessionCapture.ts（或新 helper 文件）出现 `'subagent-live-poll-error'` / `'subagent-live-poll-disabled'` 各恰好 1 次；post-run `captureChildSessions` 调用点保留。
- **测试**（详见 design.md §测试策略）：
  - 单元（poller pure logic）：incremental dedupe 按 partId 工作；首 tick 全 INSERT，二次 tick 无新 part 时空跑。
  - 单元（连续失败 disable）：mock SQLite open throw 5 次 → 第 6 次起不再尝试，post-run 仍跑。
  - 集成（runner）：mock spawn 跑 N 秒、mock opencode db 文件分阶段 seed → tick 1 写 X 条，tick 2 增量写 Y 条，post-run 兜底写 Z 条（含 child 退出后才 flush 的最后一行）。
  - 集成（dedup）：sibling nodeRun 已经持有 child sessionId → 本 nodeRun 整段 skip，无重复行。
  - 集成（pollMs=0）：completely degrade to RFC-027；行字节级匹配 RFC-027 既有 fixture。
  - WS 断言：每次 tick 真有 INSERT 后 spy `taskBroadcaster.broadcast` 收到一条 `node.event`；空 tick 不广播。
  - 守卫：grep guard 锁三处 log tag + post-run capture 调用未删。
  - 回归：RFC-027 既有 `session-capture*.test.ts` / `parse-session-tree*.test.ts` / `session-view-parse*.test.ts` 全绿；RFC-026 inline rerun dedup 测试零退化。
- **三件套全绿**：`bun run typecheck && bun run test && bun run format:check`；GitHub Actions 六 job 全绿。

## 5. 与既有 RFC 的关系

- **RFC-027**（Done）：本 RFC 是 RFC-027 的直接后继。`captureChildSessions` 函数本身不动行为，只增加 partId-level dedupe；live poller 是新 helper（`liveSubagentCapture`），调用同一个 `transcodeOpencodeRowsToEvents` 纯函数。
- **RFC-026**（Done）：inline-mode rerun 的 sibling-skip 由现有 `loadSiblingsCapturedSessionIds` 保护，本 RFC 不动。
- **RFC-029**（Done）：runtime inventory dump 仍只在结束时落盘，不受影响。
- **RFC-031**（Done）：plugin-load-failed 走 stderr 检测，是父 session 的事件，不受影响。
- **RFC-043**（Done）：distill job 的 session capture 走 `captureDistillJobSession`，是另一条 post-run path，不在本 RFC 范围。
- **RFC-047**（Draft，本会话立项）：注入快照早写 + 本 RFC 实时 subagent 共同把 "Session 页签运行中可读性" 拼齐，二者正交（不同列 / 不同 WS payload kind），可独立合并。

## 6. 风险 / 已知 caveat

- **SQLite 并发读取**：opencode 子进程在写 `opencode.db` 的同时，本 RFC 用 readonly Database 句柄读。bun:sqlite 走 WAL 时多 reader 与 writer 并发安全；如果 opencode 未启用 WAL 则读者可能短暂被 writer 阻塞。Mitigation：tick 间隔默认 1.5s，且每个 tick 内 SELECT 时间是毫秒级；最坏情况是某次 tick 等 100-500ms，影响视感不影响正确性。落地前用本机 opencode 源码确认 storage 模式（`opencode/packages/opencode/src/storage/db.ts`）。
- **schema drift**：opencode 升级换列名 → BFS 抛错 → live poll 连续失败 disable + post-run 兜底也失败 → 行为退化到 RFC-027 既有 `subagent_capture_failed` marker。可见性 caveat 已在 RFC-027 design 记录。
- **磁盘 IO**：每个 active agent run 多一条 SQLite reader open + 几条 SELECT。压测：~30 个并发 agent run × 1.5s tick = ~20 readers/s。预计影响可忽略；如压测异常可把 `pollMs` 调高或关闭。
- **WS 风暴**：长跑 subagent 频繁产 part → 每 tick broadcast → 前端 invalidate `['tasks', taskId, 'node-runs', nodeRunId, 'session']`。已经在 RFC-027 / RFC-031 等场景下经历过类似量级，react-query 自带 dedupe + debounce 可吃；若实测仍嫌频繁，加客户端节流由后续 follow-up 单独立 RFC。
- **inventory 实时性仍未解**：与本 RFC 无关，留作未来 RFC（需 opencode 上游配合）。
