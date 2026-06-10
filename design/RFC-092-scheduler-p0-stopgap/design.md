# RFC-092 — 技术设计

行号基线：`b934a01`（2026-06-10）。实现前按惯例重新核对。

## 1. S-1 — deriveFrontier 对 pending 锚点行放行

### 1.1 现状机制（为什么会卡死）

`runScope`（scheduler.ts:551-727）每 tick 重读 node_runs 重推导 frontier。`dispatchedThisInvocation`
（:606 声明、:636 add、**整个调用期内从不删除**）的本意是 N3 busy-loop 防护：纯状态读无法区分
「failed 行已在本调用重派过」与「failed 行等待新一轮 resume」，所以记住派过谁。但 ready 判定
（:1120-1124）把它用成了**无条件**排除：

```
areTransitiveUpstreamsCompleted && !inFlight.has && !dispatchedThisInvocation.has && isDispatchable
```

`submitClarifyAnswers`（clarify.ts:441-461）/ `submitReviewDecision` iterate/reject
（review.ts:1742-1757、:1792-1797）在任务运行中为已派过的节点铸出 **pending** rerun 行后：
`isDispatchable(pending)=true`（dispatchFrontier.ts:137）但去重集排除 → 不 ready；分桶循环
（:1129-1132）只收 awaiting_review/awaiting_human/failed → pending 也不入桶 → sibling 跑完后
quiescent 块（:643-678）四个出口全不命中 → `'scheduler stalled'` 假失败。

### 1.2 修法：pending 锚点按【行 id】一次性豁免（对抗检视后修订）

> 初版「按 nodeId 对 pending 行整体放行」被对抗检视攻破（设计检视 2026-06-10）：runOneNode 在
> pendingExisting 复用点（:1438-1440）**之前**存在不消费 pending 行的早期失败 return（agent 缺失
> :1332-1337 / agent 被删 :1340-1341 / 注入失败 :1364-1365），nodeId 级放行会形成确定性零铸行
> 热循环（每 tick ready→失败→pending 仍在→又 ready），scope 永不 quiescent。故豁免必须**一行
> 一次**。

`runScope` 在 `dispatchedThisInvocation`（:606）旁新增 `dispatchedPendingRowIds: Set<string>`；
派发任何节点时若其 latest 行为 pending，记录 `latest.id`。deriveFrontier 增收该集合（或合并进
现有参数对象），dispatchable 判定改为：

```ts
const pendingAnchorReleasable =
  latest !== undefined &&
  latest.status === 'pending' &&
  !dispatchedPendingRowIds.has(latest.id) &&
  !openAskingNodeIds.has(n.id) // §1.2b 竞态守卫
const dispatchable =
  areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed) &&
  !inFlight.has(n.id) &&
  (pendingAnchorReleasable || !dispatchedThisInvocation.has(n.id)) &&
  isDispatchable(latest, n.kind, freshestDone, rows, definition)
```

- out-of-band 新铸行（clarify 答复 clarify.ts:443 / review iterate-reject review.ts:1742-1757、
  :1792-1797 / sibling cascade）拥有新 ULID → 不在集合内 → 放行恰好一次。
- 泄漏的 pending 行（早期 return / mark-running 前 throw 留下的行）至多被重派一次，之后回到
  现行 stall 语义——**有界退化**，不是死循环、不是无界铸行。
- runOneNode 的 dispatch 头部复用已存在 pending 行（:1404-1419 `sameNodeIterRuns` →
  pendingExisting :1438-1440），bypass 派发不会重复铸行。

### 1.2b 答复竞态守卫：openAskingNodeIds

`submitClarifyAnswers` 的写序是**先铸 rerun 行（clarify.ts:443-461）、后写答案并翻 session 为
answered（:466-475）**，且 bun:sqlite 下 `db.transaction` 无原子性（:385-387 注释自证，调研
S-10）。旧的无条件去重恰好封死了「rerun 已铸、答案未写」窗口；bypass 会重新打开它（sibling 恰在
窗口内完成触发 tick → rerun 无答案起跑，:1116 的 `askingRunIds` 守卫只匹配 latest.id 为 asking
done 行的形态，不命中 rerun-latest 形态）。

修法：`loadOpenClarify`（:770-816）增补返回 open（未 answered）session 的**源 agent 节点 id 集**
`openAskingNodeIds`；pendingAnchorReleasable 要求节点不在该集合。session 翻 answered 后下一 tick
自然放行。cross-clarify 同口径（crossClarify.ts:817/:933 的铸行同样先于 session 状态翻转）。

### 1.3 busy-loop 安全论证（N3 为什么不被破坏）

- **同 tick 重复派发**：ready 后立即 `inFlight.set`（:637），下一 tick 被 `!inFlight.has` 排除。
- **派发后窗口（leaf agent）**：runOneNode 复用/铸行后很快翻 running，完成后 latest 为终态。
- **派发后窗口（wrapper）**：fresh wrapper 行 DB 全程停留 pending（loop :2248-2250、git
  :3230-3232、fanout :2430-2432——调研 S-28），但 wrapper 的**所有 return 路径都先 await 终态/
  parked 行写入再返回**（loop :2266/:2271/:2295/:2322/:2329 等），而 inFlight 从 :636 set 覆盖到
  :681-682 promise settle——settle 时刻 DB 已非 pending，无窗口。（初版设计误写「起跑即翻
  running」，对 wrapper 不成立；结论不变、论据以此为准。）
- **非 pending 行为零变化**：failed/done/awaiting\_\* 的去重语义原样。已核实
  `derive-frontier.test.ts:230` N3 用例 fixture 为 `failed`，**不受本改动影响、无需调整**。
- **病理兜底**：行 id 一次性豁免保证任何不被消费的 pending 行至多多派一次（见 §1.2）。

### 1.4 与周边机制的交互

- **asking 节点答后**：session 已 answered → `loadOpenClarify` 不再返回该 askingRunId /
  openAskingNodeId → S12 停泊解除，rerun pending 行走 bypass 正常派发。
- **daemon 重启**：孤儿 pending 行被 boot 收割翻 interrupted（orphans.ts:30-35，
  调研缺口 5 已锁现状），interrupted 本就 dispatchable（N1）——bypass 不参与、不冲突。
  注意：**不要**把缺口 5 的修复（收割按任务状态过滤）混进本 RFC。
- **任务已停泊（无 sibling in-flight）时答题**：scope 早已 quiescent 返回、任务 awaiting\_\*，
  走 resumeTask 新调用（去重集为空）——本就正常，不受影响。routes/clarify.ts:269-276 对
  task-not-resumable 的吞错在修复后语义变为「任务仍 running = 活调度器会自取，无需 resume」，
  对应注释修正见 §3。
- **已知限制（明示，不在本 RFC 修）**：clarify 在 **wrapper 内部**且 wrapper 本调用已 parked
  （latest 为 awaiting*\*，∈ dedup 集）时 mid-run 答题——bypass 只豁免 pending 行，不豁免
  wrapper awaiting*_ 行；`wrapperHasFreshInnerWork` 判 true 仍被去重挡下 → 任务停泊
  awaiting*human（inbox 已空），需手动 resume 解锁。比 S-1 的假 failed 温和（状态真实、resume
  可解），扩 bypass 到 wrapper awaiting*_（锚点 = 窗口内 inner pending 行 id）的修法归
  WP-6c（wrapper 复活语义与 S-3 一并处理）。`scheduler-audit-s03` 的锁定不受本 RFC 影响。

## 2. S-2 — 抽共享回滚 + 重试路径接线

### 2.1 新共享函数

新文件 `packages/backend/src/services/nodeRollback.ts`：

```ts
export interface RollbackTarget {
  repoCount: number
  worktreePath: string // 单仓 worktree；多仓为容器目录（不直接回滚）
  repos: Array<{ worktreePath: string; worktreeDirName: string }>
}
export interface RollbackRunRow {
  id: string
  preSnapshot: string | null
  preSnapshotReposJson: string | null
}
export async function rollbackNodeRunWorktrees(
  target: RollbackTarget,
  run: RollbackRunRow,
  opts: { resetOnEmptySnapshot: boolean },
  log: Logger,
): Promise<void>
```

行为 = task.ts:870-915 现行逻辑提级，外加一个开关。**多仓硬闸**（对抗检视修订）：
`repoCount > 1` 时本函数**绝不**对 `target.worktreePath`（容器目录）执行任何 git 操作——这是
S-2 点名消灭的行为，任何 fallback 都不得绕回。

- 多仓（repoCount>1 ∧ repos 非空）：解析 reposJson 得 map；**parse 失败 / reposJson 为 NULL
  等价于空 map，继续走逐仓循环**（对抗检视确认：task.ts:878-886 catch 内注释写 "fall through
  to single-repo path" 但控制流实际继续进 :887-899 逐仓循环并 :900 return，单仓路径 :903-915
  对多仓**永不可达**——现行真实语义即「parse 失败 → 全部 sha='' → 逐仓 continue → no-op」。
  共享函数按真实控制流定义，顺带修正 task.ts:885 失真注释）。逐仓：
  `sha === ''`（快照失败/当时干净/缺 map）时 resume 跳过（`resetOnEmptySnapshot: false`），
  重试不跳（`true` → 以 `''` 调 `rollbackToSnapshot` 对**该子仓** reset+clean——单仓重试既有
  语义 scheduler.ts:1520-1525 / `scheduler-boundary-presnapshot-rollback-skip.test.ts` 推广到
  逐仓）。逐仓 warn-continue 维持。
- 单仓：`resetOnEmptySnapshot: false` 时保持 resume 现行守卫（preSnapshot 非空 ∧ worktreePath
  非空才回滚）；`true` 时只要 worktreePath 非空就回滚（snap 可为 `''`）。

`task.ts` 的 `rollbackNodeRunForResume` 改为薄壳委托（`{resetOnEmptySnapshot: false}`）。多仓
parse-fail 行为：现行 = no-op，委托后 = no-op（空 map 逐仓全跳）——outcome 等价；单仓行为逐
字节一致。`resume-multi-repo-rollback.test.ts` 等既有用例是回归网。注意源码守卫
`source-text-rfc066-pr-b-guards.test.ts` PB-G4（:67-74）要求 task.ts 保留字面
`async function rollbackNodeRunForResume(` 与 ≥2 处 `await rollbackNodeRunForResume(` 调用——
薄壳必须保持该函数形态（不得改 re-export / const 赋值）。

### 2.2 scheduler 重试路径接线（同时修 S-2b）

runOneNode 的 attempt 循环内：

1. 快照写入处（:1598-1636）把写进 DB 的值同步存进循环外局部变量
   `lastFreshSnapshot: RollbackRunRow | null`（单仓存 `{preSnapshot: sha, reposJson: null}`，
   多仓存 `{preSnapshot: null, reposJson: stringify(map)}`）。followup 尝试不写快照、**不覆盖**
   局部变量——于是它始终指向「最后一次 fresh-session 尝试」的基线。
2. 回滚处（:1512-1536）删除 `readSnapshotForLatestRun` 调用，改为：

```ts
if (!agent.readonly) {
  await rollbackNodeRunWorktrees(
    { repoCount: task.repoCount, worktreePath: task.worktreePath, repos: state.repos },
    lastFreshSnapshot ?? { id: nodeRunId, preSnapshot: '', preSnapshotReposJson: null },
    { resetOnEmptySnapshot: true },
    log,
  ) // 整体 try/catch warn-continue 维持现行容错
}
```

- 多仓：逐仓回滚（修 S-2 主体）；容器目录不再被当 git 仓操作（顺带消掉「祖先 git 仓被
  clean」的角落风险面）。
- 单仓 followup 链（fresh(snap=X) → followup(无快照) → 重试）：现行代码经
  `desc(retryIndex)` 选中 followup 行读到 NULL→`''`，把「回滚到 X」退化成「reset+clean」，
  丢失任务启动前就存在的脏基线；局部变量方案天然选 X（修 **S-2b**）。
- `lastFreshSnapshot` 为 null（含多仓快照 DB 写失败 :1630 catch 的场景）→ 兜底行传
  `{preSnapshot: '', preSnapshotReposJson: null}`；多仓硬闸（§2.1）保证此时**逐子仓**以
  `''` reset 而非触碰容器目录（对抗检视边角 1：初版兜底会落进单仓分支操作容器目录，已修订）。

3. 删除 `readSnapshotForLatestRun`（:3775-3794，唯一调用点即 :1519）——S-13 五处
   `desc(retryIndex)` fork 消掉一处。

**为什么局部变量而不是按行号读 DB**：rollback 只发生在 `attempt > retryIndex`，即同一
runOneNode 调用内的第 2+ 次尝试，前次尝试的快照必然在本调用内写入（resume/跨进程场景的回滚由
task.ts 在派发前完成，不走此分支）——内存值精确、无排序歧义、零额外 IO。

## 3. S-26（局部）— routes/clarify.ts 注释修正

:255-262 现行注释以「`rescanScopeForNewPendingRows` 会兜住 mid-run 行」论证吞掉 resume 失败的
安全性，而该机制已在 RFC-076 删除（S-1 正是论证失效的直接后果）。改写为指向真实机制：任务仍
running 时活调度循环经 deriveFrontier 的 pending-bypass（本 RFC §1.2）自取 rerun 行，resume 的
ConflictError 属预期；任务已停泊时 resumeTask 正常生效。纯注释改动，不改任何行为。
routes/reviews.ts:180-182 同型注释一并核对修正（同样纯注释；S-27 的退避重试不在本 RFC 范围）。

## 4. 失败模式

| 风险                                   | 缓解                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pending-bypass 引入忙循环 / 无界铸行   | 行 id 一次性豁免（§1.2）：泄漏 pending 行至多多派一次后回到现行 stall 语义；新增「泄漏 pending 行有界终结」用例（§5-10）                                |
| rerun 无答案起跑（铸行→写答案窗口）    | openAskingNodeIds 守卫（§1.2b）+ 竞态窗口用例（§5-11）                                                                                                  |
| 共享回滚改变 resume 行为               | task.ts 薄壳 + `{resetOnEmptySnapshot:false}`；多仓 parse-fail 现行真实语义=no-op、委托后 outcome 等价（§2.1）；既有 resume 测试网 + PB-G4 源码守卫回归 |
| 多仓重试回滚误碰容器目录               | repoCount>1 硬闸：共享函数对容器目录零 git 操作，缺 map 时逐子仓 `''` reset（§2.1/§2.2）                                                                |
| 多仓重试回滚把合法残留清掉             | 回滚仅 fresh-session 重试触发（followup 不回滚，现行条件 :1518 保留）；逐仓 `''` reset+clean 与单仓既有语义一致                                         |
| wrapper 内 clarify mid-run 答复仍停泊  | 明示为已知限制（§1.4），归 WP-6c；非回归（现状即如此）                                                                                                  |
| 删除 readSnapshotForLatestRun 影响他处 | 已确认唯一调用点 :1519；s13 源码守卫同步更新为「不得存在」                                                                                              |

## 5. 测试策略（随改动落地，全绿才 push）

翻转（按各文件头 FLIP 指引）：

1. `scheduler-audit-s01-pending-rerun-dispatch-dedup.test.ts` — pending rerun 放行、对照组不变。
2. `scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts` — attempt 2 两子仓干净；双轨写入
   证据断言保留。
3. `scheduler-audit-s12-status-bucket-universe.test.ts` — 全集表 pending(∈dedup) 行 → ready。
4. `scheduler-audit-s13-freshest-fork-source-guards.test.ts` — scheduler.ts 守卫翻为「函数已删、
   该 desc(retryIndex) 用法不存在」。

调整：5. ~~`derive-frontier.test.ts` N3~~ — 对抗检视已核实其 fixture 为 `failed`-latest，不受影响，
**无需调整**（保留此条记录核实结论）。

新增：6. `rfc092-node-rollback.test.ts` — 共享函数单测：单仓空/非空快照 × 两种开关、多仓逐仓回滚、
sha='' 的跳过 vs reset 分叉、reposJson parse 失败 = 空 map 逐仓处理（resume 全跳 / retry
逐子仓 reset）、**repoCount>1 时容器目录零 git 操作的硬闸断言**。7. `rfc092-midrun-clarify-dispatch.test.ts` — 集成：菱形 + 慢 sibling（mock opencode 延迟），
运行中 `submitClarifyAnswers` → 任务 done、rerun prompt 含答案、sibling 不受扰。8. `rfc092-midrun-review-iterate.test.ts` — 集成：运行中 iterate → 上游 pending 行被活调度循环
拾起重跑 → 任务 done。9. `rfc092-followup-chain-rollback.test.ts` — S-2b 回归：单仓 fresh(基线含预置脏文件) →
followup 失败 → fresh 重试，断言重试起点恢复到 X（预置脏文件还在、半成品消失）。10. `rfc092-leaked-pending-bounded.test.ts` — 对抗检视反例回归：人为留下不可消费的 pending 行
（如指向已删除 agent 的 rerun），断言任务在有限步内终结（failed/stalled 均可）而非无限循环
/ 无界铸行（断言 node_runs 行数有上界）。11. `rfc092-answer-race-window.test.ts` — §1.2b 竞态：rerun 已铸、session 未 answered 时驱动
tick（纯函数面：openAskingNodeIds 含该节点 → 不 ready；answered 后 → ready）。

回归网（不动但必须全绿）：`resume-multi-repo-rollback.test.ts`、
`scheduler-boundary-presnapshot-rollback-skip.test.ts`、`dispatch-frontier.test.ts`、
`clarify-review-combination-scenarios.test.ts`、`source-text-rfc066-pr-b-guards.test.ts`
（PB-G4 薄壳形态约束 / PB-G2 `repos: state.repos` 计数）、`scheduler-audit-s03`（wrapper 限制
不受本 RFC 影响）及全量套件。
