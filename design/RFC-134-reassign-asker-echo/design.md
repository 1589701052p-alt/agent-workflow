# RFC-134 技术设计：改派回执（asker echo）

## §0 一句话

在唯一下发通道 `dispatchTaskQuestions` 的事务里，为「有效承接 ≠ 提问节点」的 self / questioner 条目补插一行 `roleKind='echo'` 的 `task_questions`（生来已下发、`trigger_run_id=NULL` 排队），复用既有机器：统一注入器按 effectiveTarget 投影选取 → 平铺渲染 → `bindTriggerRun` 承接 → 派生老化 → 相位派生 → 看板渲染。**新代码 ≈ 一个纯函数 + 一个 tx 内 insert + 注入层一处角色无关的同题同目标渲染去重（Codex R2-F3，顺带修 pre-existing 双渲染 bug）+ stage 一处服务端守卫（Codex R2-F4，顺带补现状缺口）+ confirm guard 微调**。注入层对 echo **无任何特判**（无 `'echo'` 字面量）。

## §1 契约与证据（回源核读，2026-07-02）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 条目 identity = (origin_node_run_id, question_id, role_kind) 唯一索引；self 轮 reconcile 恒产 1 条 role='self' | `db/schema.ts:1866-1870`；`shared/task-questions.ts:99-108` |
| 2 | 注入选取 = dispatched ∧ (sealed ∨ manual) ∧ effectiveTarget(override ?? default)==consumer ∧ 未老化，所有角色一条查询 | `services/clarifyQueue.ts:90-107` |
| 3 | queued（trigger NULL）**永不预老化**：`isTargetNodeConsumed(sinceRunId===null) → false` | `services/clarifyRerunLedger.ts:428` |
| 4 | 绑定发生在目标节点真正运行时（`bindTriggerRun`），非下发时 | `services/clarifyQueue.ts:219-241`（文件头 :6-8） |
| 5 | 相位：dispatched + trigger NULL → processing；绑定后走 `resolveHandlerRun` lineage | `services/taskQuestions.ts:318-323, 335-354` |
| 6 | 看板批量下发与反问页自动下发**同走** `dispatchTaskQuestions`（"a single delivery path, two triggers"）→ 回执写入点唯一 | `services/clarifyAutoDispatch.ts:43, 492-513` |
| 7 | reconcile append-only；唯一清理分支限定 `role='designer' ∧ dispatched_at IS NULL ∧ roundAnswered` → 不触碰 echo | `services/taskQuestions.ts:196-268` |
| 8 | 改派 CAS：`dispatched_at IS NULL` 才可改派；「post-dispatch retargeting is reopen's job」 | `services/taskQuestions.ts:984, 1012` |
| 9 | `role_kind` 列 text NOT NULL、**无 CHECK**（drizzle enum 纯类型层）→ 枚举扩宽零 migration | `db/migrations/0060_rfc120_task_questions.sql:23` |
| 10 | cause class 单一定义 `causeClassForEntry(roleKind)`：self→clarify-answer、questioner→cross-clarify-questioner-rerun、designer(含 manual)→cross-clarify-answer；RFC-133 queued 守卫按「run 义务 + cause 同类」放行/阻塞 | `services/clarifyRerunLedger.ts:30-41, 264-298` |
| 11 | move 改派：rerun mint 在目标节点、目标跑自己（RFC-131 T4 + RFC-132 §7 变更③ borrow→move） | `design/plan.md` RFC-131/132 行；`services/clarifyQueue.ts:87-89` 注释 |
| 12 | `'echo'` 字面量全仓未占用 | grep 2026-07-02 |
| 13 | **守卫投影是三角色白名单**：dispatch in-tx 复检与 auto-dispatch 预检读 dispatched 台账时均 `inArray(roleKind, ['self','questioner','designer'])` → echo 行天然不进守卫（本 RFC 定为**有意豁免**，见 §4） | `services/taskQuestionDispatch.ts:627`（in-tx 复检）、`services/clarifyAutoDispatch.ts:177`（quick 预检）；Codex 设计 gate F1 |
| 14 | **reopen（打回）未实现**：`reopenTaskQuestion` 全仓零命中；`routes/taskQuestions.ts` 仅 list/manual/confirm/reassign/stage/dispatch；`taskQuestions.ts:1012` 的 "use reopen to re-target after dispatch" 指向的是 RFC-120 AC-11 的**期货**——下发后答案与目标当前均不可变 | grep 2026-07-02；Codex 设计 gate F2 |
| 15 | **stage 无 dispatched/roleKind 检查**：`stageTaskQuestion` 只 gate seal 状态，直接按 id update `staged_at`——已下发行（含未来的 echo）可被直连 API stage 成脏数据（相位派生不读它、纯脏戳，但「CAS 天然拒 stage」的说法不成立） | `services/taskQuestions.ts:1039-1064`（seal gate :1050）；Codex R2-F4 |
| 16 | **同题同目标双行在现状已可构造**（非 echo 引入）：cross designer 域 = questioner + designer 双条目；designer 条目可被改派到 questioner **节点**（`canReassign` 只验 agent 节点）→ 两行 effectiveTarget 同为 questioner 节点，`selectAgentQueue` 全选、平铺**双渲染**同一 Q&A | 契约 #1（D2 双条目）+ `shared/task-questions.ts:189-191` + `clarifyQueue.ts:90-107`；Codex R2-F3 |
| 17 | **「已下发」≠「可渲染」**：dispatch 的 seal 判据接受「行 sealed_at 非空 **或** 源轮已 answered」（`assertRequestedEntriesSealed`，`taskQuestionDispatch.ts:163-186`），而 `selectAgentQueue` 渲染过滤只认**行级** `sealed_at !== null ∨ manual`——answered 轮上懒建的行 sealedAt 可为 NULL（reconcile 仅在 !roundAnswered 时回填继承 `taskQuestions.ts:170-182,213`；0068 无历史回填 `db/schema.ts:1826-1828`）→ 这类行可**已下发但永不入队渲染**（承接投递也中招，不只 echo——本 RFC 在 §3.1 于 stamp 时归一化补行戳收敛此分歧，Codex R5-F9） | `clarifyQueue.ts:106`；Codex R4-F8 / R5-F9 |

> 协作提示：`services/clarify.ts / crossClarify.ts / clarifyRerunLedger.ts / shared/schemas/ws.ts / frontend hooks/useClarifyWs.ts` 当前工作树有并行未提交改动（疑似 RFC-132 后续）。上表行号以当前 HEAD 为准，**实现期先 rebase 到协作者提交后的最新状态再落点**；若发生同函数真冲突，停下问用户（多人协作原则）。

## §2 数据模型

### 2.1 roleKind 枚举扩宽（零 migration）

`TaskQuestionRoleKind`（`shared/task-questions.ts:33`）与 `db/schema.ts:1794` 的 `{ enum: [...] }` 各 +`'echo'`。语义：**回执 / 知会型**条目——目标恒为提问节点，只读（不可改派 / stage / reopen），投递由队列机制完成。

### 2.2 echo 行字段（全部现有列，无新列）

| 列 | 值 | 说明 |
| --- | --- | --- |
| id | 新 ULID | |
| task_id / origin_node_run_id / question_id / question_title | 复制源条目 | 与源条目同轮同题 → 注入渲染直接经 origin 轮 answers_json 取**live** Q&A（`clarifyQueue.ts:139-190`），reopen 就地改答后自动是新值 |
| source_kind | 复制源条目（self / cross） | cause 映射（§4）与看板来源标签用；**恒非 manual**（manual 不产 echo） |
| role_kind | `'echo'` | identity 去重锚 |
| iteration / loop_iter | 复制源条目 | 提问节点续跑 lineage 与源轮同帧 |
| default_target_node_id | 复制源条目 default（= 提问节点） | echo 的 effectiveTarget；恒非空（规则前置条件） |
| override_target_node_id | NULL | echo 永不改派 |
| dispatched_at / dispatched_by | 本批次时间戳 / actor | **生来已下发** → 不进 pending/staged、不触发 D10 awaiting_human gate、天然被改派/stage/再下发 CAS 拒 |
| trigger_run_id | NULL | queued，提问节点下次运行 bindTriggerRun（契约 #3/#4） |
| staged_at/by、sealed_by | NULL / NULL | 未经历 stage；seal 归属留在源条目 |
| sealed_at | 继承源条目 sealed_at ?? 批次时间戳 | 满足选取的 sealed 过滤（契约 #2）；`??` 兜底**不是装饰**——源条目可能是「answered 轮上 sealedAt NULL 的懒建行」（契约 #17），若直接继承 NULL，echo 自己也会被 `clarifyQueue.ts:106` 过滤成永不渲染 |
| confirmation | 'open' | |
| manual_* / prior_answer_snapshot_json / reopen_count | NULL / NULL / 0 | |

### 2.3 纯函数 `planEchoEntries`（shared/task-questions.ts）

```
interface SiblingSnapshot {   // 该任务同 (originNodeRunId, questionId) 的兄弟条目（任意角色）
  id                                                    // 与 stampedIds 求交（R6-F11）
  roleKind; defaultTargetNodeId; overrideTargetNodeId   // effectiveTarget = override ?? default
  dispatchedAt; sealedAt; sourceKind                    // 交付感知(R3-F6) + 可渲染性(R4-F8) 判据
}
planEchoEntries(input: {
  batch: Array<Pick<Row, 'id'|'roleKind'|'sourceKind'|'questionId'|'questionTitle'|
    'originNodeRunId'|'iteration'|'loopIter'|'defaultTargetNodeId'|'overrideTargetNodeId'|'sealedAt'>>,
  siblingsByQuestion: Map<originNodeRunId + '\x1f' + questionId, SiblingSnapshot[]>,  // 同题全部条目；判定时排除候选行自身、可含同批其他行
  stampedIds: ReadonlySet<string>,   // 本批 stamp 成功的 task_questions.id（同批交付判据，R3-F6）
  batchTimestamp: number,            // 本批 stamp 时间戳（调用方传入——纯 oracle 不取 Date.now，R7-F12）
}) → EchoPlan[]   // 应插回执的身份 + 字段快照；EchoPlan.sealedAt = 源 sealedAt ?? batchTimestamp（在纯函数内定值）
```

（Codex R5-F10：签名与跳过判定所需入参对齐——兄弟快照与本批 stamp 集是判定的必要输入，不能只收 batch。R6-F11：谓词对快照取值**单值化**——不依赖调用时序，见跳过判定 ③ 的「∨ ∈ stampedIds」分支。）

规则（即通用不变量的判定式）：`roleKind ∈ {'self','questioner'} ∧ overrideTargetNodeId ≠ null ∧ overrideTargetNodeId ≠ defaultTargetNodeId ∧ defaultTargetNodeId ≠ null`。

- effective ≠ default ⟺ override 非空且 ≠ default（override == default 视同未改派，不产 echo——黄金锁）。
- designer / manual / echo 输入恒不产出（echo 不自繁殖）。
- 同批同 (origin, question) 只产一条（self 与 questioner 不会同轮同题并存——self 轮无 questioner 条目、cross 轮无 self 条目，reconcile 保证；防御性去重仍做）。
- **同题兄弟「已交付指向」提问节点则跳过**（Codex R2-F3 批内分支 + R3-F6 交付感知 + R4-F8 可渲染性收紧）：入参附带该任务同 (origin, question) 的**全部**兄弟条目（任意角色）快照（含 `dispatchedAt`、`sealedAt`、`sourceKind`）+ **本批 stamp 集**。跳过判定 = 存在任一兄弟**同时**满足三条：① effectiveTarget == 提问节点；② `dispatched_at` 非空 **或** 该兄弟 ∈ stampedIds（已下发/同批下发——承诺不算交付，R3-F6）；③ **可渲染**：`sealed_at` 非空 **∨ 该兄弟 ∈ stampedIds**（R4-F8 + R6-F11 单值化：本批 stamp 的行经 §3.1 归一化**必然** sealed——谓词直接以 stampedIds 认定可渲染，不依赖快照取值时序；`sealed_at` 分支只裁决**历史已下发**的兄弟——升级前下发的 sealedAt NULL 懒建行永不入队（契约 #17，无追溯归一化），不构成交付。manual 分支按构造不可达：manual origin 是合成唯一 ULID，不可能与 clarify 行同 (origin, question)）。不满足即产 echo；由此产生的「echo + 兄弟后到同指提问节点」组合由 §5 渲染去重兜底（单渲染、双绑定）。

## §3 写入点（唯一）：`dispatchTaskQuestions` in-tx

在既有事务内、CAS 复检 + `dispatched_at` stamp + frontier mint **之后**追加以下步骤（R6-F11：归一化排第一步，后续步骤读到的即终态）：

1. **seal 行戳归一化**（Codex R5-F9）：对本批 stamp 成功且 `sealed_at IS NULL` 的 clarify 行（它们能过 `assertRequestedEntriesSealed` 只因源轮已 answered，契约 #17）同事务补 `sealed_at = 本批时间戳`、`sealed_by` 保持 NULL（NULL sealed_by + 非空 sealed_at = 「answered 轮证据落戳」的审计语义，非人工 seal）。效果：**凡下发出去的行必可渲染**——在唯一 choke point 收敛契约 #17 的分歧，顺带修复 pre-existing「懒建行下发给承接方后永不注入」的投递洞；不追溯历史已下发行（forward-only，D6 同口径）。选此而非改 `selectAgentQueue` 判据：后者要在选取层引入 round 状态查询、扩大读面，且改变所有既有队列语义；归一化是写侧单点、语义保持（这些行本就被当作 sealed 接受）；
2. 对本批 stamp 成功的条目跑 `planEchoEntries`（跳过判定以 stampedIds 单值化，与本步先后无关，§2.3）；
3. `insert … onConflictDoNothing`（identity 索引）逐条落 echo 行（`dispatched_at` = 本批 stamp 同值）；
4. **不**把 echo 的目标（提问节点）加入受影响 handler / frontier / mint 分组集合——提问节点在本批**零 mint**（D1）；
5. echo 行**不进入任何 cause 序列化守卫**（本批与后续批次均豁免，机制与论证见 §4——这是有意决策，不是遗漏）；
6. log 一行（taskId / question / askerNode）便于审计。

自动下发（反问页答完）与看板批量下发共享此函数（契约 #6）→ 两个触发面自动同享不变量，无第二挂点。**反问页快路径答非改派问题（override 空）时 `planEchoEntries` 产出为空 → 行为逐字节不变（黄金锁）。**

## §4 与 cause 序列化 / RFC-133 queued 守卫的关系：**显式豁免**（Codex 设计 gate F1 fold）

> Codex 设计 gate 指出初稿两处错误：① 初稿称「后续批次由 RFC-133 queued 语义评估」——实际守卫投影是三角色白名单（契约 #13），echo 根本不会被看见；② 同批「P 的问题改派给 X（回执回 P）+ 异类 designer/manual 下发到 P」时，P 的异类 rerun 会注入并绑定刚插入的回执。Codex 建议把 echo **纳入**序列化（回执参与分组/守卫、投影扩宽）。**本设计采取相反处置：把 echo 定为序列化的显式豁免项**，理由如下。

**豁免的语义论证**：「一 run 一 cause」（RFC-128 §5.2.12）序列化的对象是**拥有 rerun 的条目**——cause 决定被 mint 的 run 怎么构建（self/questioner 类 isClarifyRerun=TRUE：inline session 续接 + directive 门控；designer 类 update 模式，契约 #10 / `clarifyRerunLedger.ts:26-29`）。echo **从不 mint、不拥有 rerun_cause**：它是纯载荷（已答 Q&A），搭**任何** cause 的顺风车运达都成立——平铺注入本就无差别混装所有角色（RFC-132 §5；`clarifyQueue.ts:78-80`），run 的构建方式由**拥有**该 run 的条目决定，与随车的 echo 无关。

**豁免 vs 纳入的产品后果**（决定性）：若按 Codex 建议纳入守卫，一条尚未被提问节点消费的回执（class=提问者续跑类）会让后续**任何异类下发**（给该节点派 manual 修复任务、designer 反馈）撞 409——而提问节点可能很久不运行。这等于让一张知会卡阻塞真实工作的调度，重蹈 RFC-133 刚修掉的「queued 假阳性 409」死锁类。豁免则零新增阻塞面。

**落点（全部零守卫改动）**：

- 守卫投影**保持**三角色白名单不动（契约 #13）——从「隐式遗漏」升级为「显式决策」：两处白名单加注释指向本节；**源码文本断言锁**：两个白名单数组不得包含 `'echo'`（防未来"顺手"扩入，测试 §8.9b）。
- 同批异类绑定（Codex 场景）= **有意行为**：P 的异类 rerun 提前把回执送达提问节点——交付更早、老化正确（绑定即锚），测试锁定其结果正确性（§8.9a）而非禁止它。
- `mintCauseByTarget` / 分组 / auto-split 无需感知 echo（§3.3-3.4）。
- `causeClassForEntry`：roleKind 枚举扩宽后为保 TS 穷尽性仍须处理 `'echo'`——**防御性**按 sourceKind 映射（self→`clarify-answer`、cross→`cross-clarify-questioner-rerun`）并注释「echo 已在守卫入口被白名单排除，此映射不作序列化判据」；签名扩 `Pick<Row,'roleKind'|'sourceKind'>`。
- 相位/老化不受 cause 影响：`resolveHandlerRun` 的窗口上界只用 `NEW_CLARIFY_TRIGGER_CAUSES` 判定，与绑定 run 自身 cause 无关；`isTargetNodeConsumed` 只看 done+output（契约 #3）。

**已知让步**（记录，不阻塞）：sessionMode=inline 的提问节点若经异类 update-run 提前消费回执，该 Q&A 进入的是那次 update 运行的上下文而非其 inline 续接会话记忆——回执仍算送达（进过它的 prompt），接受为 v1 语义。

## §5 生命周期与 guard 微调

| 动作 | echo 行为 | 实现 |
| --- | --- | --- |
| 注入 / 绑定 / 老化 | 复用；提问节点任意 cause 的下一次运行即消费 | 唯一改动 = 角色无关的同题同目标渲染去重（本节下文）；**无 echo 特判**——AC-2 源码断言 `clarifyQueue.ts` 无 `'echo'` 字面量 |
| 相位 | processing（queued）→ awaiting_confirm（绑定 + done+output）→ done（confirm） | 复用 `resolveDispatchedEntryHandler` + `deriveQuestionPhase`，零改动 |
| reassign / 再下发 | 天然被 `dispatched_at IS NULL` CAS 拒（契约 #8 / dispatch CAS） | 零新守卫，测试锁定 |
| stage | **现状无守卫**（契约 #15，Codex R2-F4）——直连 API 可把已下发行 stage 成脏戳。**新增原子 CAS 守卫**（R3-F7 收紧——「先查后改」在并发 dispatch 间隙可被盖戳，须结构性免疫竞态）：`staged=true` 的写法改为条件更新 `UPDATE task_questions SET staged_at=… WHERE id=? AND dispatched_at IS NULL`，受影响行数为 0 → ConflictError（语义同 reassign 的 :1012；与 dispatch 的 stamp 天然串行化，无 check-then-act 窗口）——通用规则、非 echo 特判，顺带补上所有已下发行的现状缺口；un-stage 方向不动 | `stageTaskQuestion` 条件更新 + 0 行判定 + 测试（含并发 dispatch-vs-stage 回归） |
| confirm | **放宽：任意相位可 confirm**（知会卡「已知悉」收卡）；confirm 不撤销投递（选取层不读 confirmation，契约 #2） | `confirmTaskQuestion` guard 对 `roleKind==='echo'` 跳过 awaiting_confirm 限制 |

**答案不可变（现状，Codex 设计 gate F2 fold）**：reopen（打回）在当前代码**不存在**（契约 #14）——下发后答案与承接目标均不可变，因此**不存在「回执携带陈旧答案」问题**（echo 经 origin 轮 `answers_json` live 读取，而该 JSON 下发后无人能改）。初稿的「reopen 联动（重排队 / 改回即删）」整体移出本 RFC scope，登记为**未来耦合点**（§7 末行）：任何后续实现打回的 RFC **必须**同时规定 echo 的重排队与删除规则，否则回执会静默送旧答案 / 双渲染。

**同题同目标去重（Codex R2-F3 fold；取代初稿的「结构性不可能」论证——该论证只覆盖 echo vs 其源条目，漏了跨角色兄弟）**：

- **风险面**：同一 (origin, question) 的两行有效指向同一节点是**现状已可构造**的（契约 #16：designer 条目改派到 questioner 节点），echo 再加一种组合（echo 落队后、同题 designer 兄弟在后续批次被改派到提问节点）。后果都是 `selectAgentQueue` 全选 → 平铺**双渲染**同一 Q&A。
- **修复（角色无关，一处）**：`buildClarifyQueueContext` 渲染前按 (originNodeRunId, questionId) 去重——同题多行**渲染一次**（取 dispatched_at 最早者，内容本就逐字相同：同轮 answers_json 同 qid），`bindTriggerRun` 仍**全量绑定**所有选中行（每行独立老化 / 相位推进，看板不受影响）。manual 条目 origin 是合成唯一 ULID，永不参与去重（黄金锁）。`AgentQueueEntry` 补投影 `questionId` 字段。
- 该去重**不含任何 echo 特判**（`'echo'` 字面量锁存活），并顺带修复契约 #16 的 pre-existing 双渲染 bug——designer→questioner 节点改派场景单独加回归（§8.9c），含 Codex 指出的「questioner run done-无-output 后再下发 designer」时序。
- 批内冗余卡由 `planEchoEntries` 的兄弟跳过分支（§2.3）预防；跨批组合由本去重兜底。

## §6 前端（复用为主）

- `TaskQuestionList.tsx`：roleKind 增加 `'echo'` 渲染分支——role 标签「回执」（en: Receipt）、动作区仅 confirm + 既有跳转；改派 `Select`、stage、下发勾选对 echo 不渲染（born-dispatched 本就不进 staged 列）。
- 类型 / DTO：shared 枚举扩宽自然传导；WS 失效复用既有 `['task-questions', taskId]` invalidation（dispatch tx 已触发）。
- i18n 中英对称；`StatusChip` 等既有原语，无新 chrome。

## §7 失败模式

| 模式 | 处置 |
| --- | --- |
| 提问节点因图拓扑永不再运行 | 回执长期 processing——接受（非目标③）；看板可见 + 任意相位 confirm 收卡（D3） |
| 提问节点在下发与回执落库间隙恰好在跑 | 本次 run 的注入查询已过（不含 echo）；echo 留队列等**再下一次** run——最终一致，无丢失（老化以绑定为锚，契约 #3） |
| crash / 重放 | echo 与 stamp/mint 同 tx 原子；重放 `onConflictDoNothing` 幂等（AC-4） |
| 提问节点被删出图（工作流编辑） | 与所有 dispatched 条目同待遇：队列条目留存、不再有 run 匹配 → 长期 processing，可 confirm 收卡；不新增守卫 |
| 升级窗口在飞任务 | 零 migration、规则只作用于**新** dispatch 批次；旧 queued/dispatched 条目不受影响（D6 不回填） |
| **未来 reopen（打回）RFC 落地** | **强制耦合点**（Codex F2）：打回若就地改 `answers_json` / 改承接目标，必须同步规定 echo 的重排队（trigger 置 NULL）与「改回提问节点即删 echo」规则，否则回执静默送旧答案 / 同题双渲染。本 RFC 在此登记，实现打回者须引用本行 |

## §8 测试策略（Test-with-every-change）

**shared 纯函数（先红后绿）**
1. `planEchoEntries`：self+override→1；questioner+override→1；override==default→0；override 空→0；designer/manual/echo→0；default 空→0；同批去重；**兄弟跳过（交付感知 R3-F6 + 可渲染性 R4-F8）**——兄弟指向提问节点且已下发且 sealed→0；兄弟在本批 stamp 集且 sealed→0；兄弟指向提问节点但**未下发且不在本批**→仍产 echo（承诺≠交付）；**历史已下发**（∉ stampedIds）且 sealed_at NULL 的兄弟（升级前 answered 轮懒建行、无追溯归一化）→**仍产 echo**（已下发≠可渲染）；**同批 stamped** 且 sealed_at NULL（answered 轮）的兄弟→**跳过**（§3.1 归一化后必可渲染，R6-F11——两分支必须分开锁，不得合并）；兄弟 override 指向 / default 即提问节点两种形态各覆盖。**sealedAt 定值在纯函数内断言**（R7-F12）：源条目 sealedAt 非空 → EchoPlan.sealedAt 继承之；NULL → 取入参 batchTimestamp（保可渲染，不在 oracle 外二次填充）。
2. `causeClassForEntry` echo×{self,cross} 映射 + 既有三角色黄金锁。

**backend 集成**
3. dispatch（看板路径）改派 self 条目 → echo 行字段全断言（§2.2）+ 提问节点 run 计数不变（不 mint）+ 同批重放幂等。
4. auto-dispatch（反问页路径，`autoDispatchClarifyRound`）先改派后答 → 同样产 echo（单通道验证）；未改派答题 → 零 echo（黄金锁）。
5. 端到端：改派→下发→修改方 done+output→级联到提问节点→其 rerun prompt 平铺含该 Q&A（`buildClarifyQueueContext` 选中 echo）→ 绑定 → 提问节点 done+output 后老化不再注入。
5b. **seal 归一化回归**（R5-F9）：answered 轮上 sealedAt NULL 的 self/questioner 源条目被改派并下发 → stamp 后该行 `sealed_at` 已补（`sealed_by` NULL）；**承接方** rerun 渲染该 Q&A（修 pre-existing「已下发永不渲染」投递洞）+ **提问节点** echo 同样渲染（双投递齐活）；manual 行不补戳；已有 sealed_at 的行不被改写（黄金锁）；历史已下发行不追溯（forward-only）。
6. **豁免非阻塞锁**（§4）：queued echo 挂在提问节点 P 上时，后续对 P 的**同类与异类**下发均放行（守卫白名单不见 echo、无 409）；有 run 义务时仍按 RFC-133 既有语义阻塞（与 echo 无关，回归锁）。
7. reconcile 安全：落 echo 后对源轮反复 reconcile（含 stop-finalize 清理分支）→ echo 不增不改不删。
8. 生命周期：echo 相位三跳；reassign / 再下发被既有 CAS 拒；**stage 原子 CAS**——已下发行（echo 及任意角色）staged=true → 条件更新 0 行 → ConflictError，un-stage 不受影响；**并发 dispatch-vs-stage 回归**（R3-F7：条件更新结构性免疫盖戳竞态——单测锁 0 行路径 + 交错时序用例）；confirm 任意相位可调且不影响后续注入。
9. **豁免行为锁**（§4，Codex F1 场景转正）：同批「P 的问题改派给 X + 异类 designer/manual 下发到 P」→ P 的异类 rerun 平铺注入并绑定回执、提问节点提前收到 Q&A、老化以该 run 为锚正确定型——以「结果正确」形式锁定，而非禁止。
9c. **同题同目标去重回归**（§5，Codex R2-F3）：① pre-existing 场景——cross designer 条目改派到 questioner 节点（含「questioner run done-无-output 后再下发 designer」时序）→ 下一次 rerun prompt 该 Q&A 仅出现一次、两行均绑定并正确老化；② echo 跨批场景——echo 落队后同题 designer 兄弟改派到提问节点 → 同样单次渲染双绑定；③ manual 条目不被去重（黄金锁）。
10. RFC-099：echo 渲染块无 dispatched_by 等归属字段（并入既有 prompt-isolation 双层锁用例）。

**源码层文本断言（兜底锁）**
11. `services/clarifyQueue.ts` 不含 `'echo'` 字面量（注入层零特判，AC-2）。
11b. 两处守卫白名单数组（`taskQuestionDispatch.ts` in-tx 复检、`clarifyAutoDispatch.ts` 预检）保持 `['self','questioner','designer']`、不得包含 `'echo'`（豁免不被未来「顺手扩入」破坏，§4）。

**frontend vitest**
12. 回执卡：role 标签、仅 confirm 动作、无改派下拉；节点过滤含 echo；i18n key 中英存在。

**门禁**：`bun run typecheck && bun run test && bun run format:check` + frontend vitest + 单二进制 smoke + CI 全绿；Codex 设计 gate（落码前）+ 实现 gate（声明完成前）。
