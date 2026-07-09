# RFC-161 任务画布反问节点点击直达反问页 — proposal

状态：Draft（研究 → AskUserQuestion 一问拍板「待答+已回答，与评审完全对齐」→ 落档；待设计门 Codex + 用户批准）
提出：用户 2026-07-09「和点击评审节点跳转评审一样，给反问节点增加点击跳转能力，点击跳转到反问页面」

## 1. 背景

RFC-158 刚把任务详情画布（`/tasks/$id` 「工作流状态」页签）上的 **review 节点**点击从「打开近乎全空的
`NodeDetailDrawer`」改为「直达评审页 `/reviews/$nodeRunId`」，按当前评审状态三态分（未产生/awaiting/
decided）。RFC-158 明确把 **clarify / cross-clarify 节点列为非目标**（proposal §3：「不动 clarify /
cross-clarify 节点：它们点击仍走 drawer，如需同等待遇另立 RFC」）。本 RFC 即那个「另立 RFC」。

反问节点同样是人工在环（human-in-the-loop）的 leaf 节点，点它打开的 `NodeDetailDrawer` 四页签
（Session / Events / Output / Stats）对反问几乎全空——反问的真正内容（提问、可选项、我的答案、
提交归属、历史轮）全在专门的反问页 `/clarify/$nodeRunId`（`routes/clarify.detail.tsx`）。今天从任务
详情到反问页只有两条迂回路径：「节点运行」表格里 `awaiting_human` 行的「去回答」按钮
（`tasks.detail.tsx:929-940`，`shouldShowClarifyJump`），或顶部导航去 `/clarify` 收件箱再找回来。
画布上那个醒目的琥珀色呼吸灯反问节点反而点不出任何有用的东西。

反问节点有两种 kind，都跳同一个反问页：
- `clarify`（RFC-023 自反问）—— agent 向人发问，人答完 agent 带答案重跑（`ClarifyNode`）。
- `clarify-cross-agent`（RFC-056 跨代理反问）—— 下游提问者经人工闸门反向喂上游设计者（`CrossClarifyNode`）。

## 2. 目标

把任务详情画布上 **clarify / cross-clarify 节点的点击动作从「打开 NodeDetailDrawer」改为「直达反问页」**，
按节点当前反问状态三分（与 RFC-158 评审节点 awaiting/decided/null 完全对齐）：

裸链 `/clarify/{intermediaryNodeRunId}` 渲染的是该 node_run 的**最新一轮** clarify_round
（`getClarifyRoundDetail` 按 `intermediaryNodeRunId` 取 `createdAt` 最新，`clarifyRounds.ts:199-204`），
`awaiting_human` 渲染可交互表单、`answered` 渲染只读回显、无 round 则 404。所以判据的关键是
「**裸链会渲染的那一轮**」的状态，服务端把每个 clarify run 派生成
`clarifyNavKind: 'awaiting' | 'answered' | null`——一处算全「有可渲染当前轮（不 404）+ awaiting/answered
分类」，前端只挑节点当前态：

| 节点当前态（= 该 nodeId 的 freshest run 的最新轮状态） | `clarifyNavKind` | 点击行为 |
|---|---|---|
| 还没产生反问 / pending / 无 round（含 cross-clarify persistent-stop 透传、missing-questioner guard 等无 session 行）/ **round 为 `canceled`（任务取消）/ `abandoned`（cross 父任务失败）/ canceled·failed 任务上的孤儿 awaiting** | `null` | 无法点击（无 drawer、无跳转） |
| 正在等待回答（最新轮 `awaiting_human`，且任务非 canceled/failed） | `awaiting` | 打开该轮可交互反问页 `/clarify/{该 node_run id}`（作答 + 提交，分片自反问由页内 shard switcher 切换兄弟分片） |
| 已经回答（最新轮 `answered`，node_run 已封存 `done`） | `answered` | 打开该行 `/clarify/{该 node_run id}`，页面按既有形态呈现只读回显（题目 + 我当时的答案 + 提交归属，`readonly = status !== 'awaiting_human'`） |

前端 `deriveClarifyNodeNav` **纯 freshest-run**（与评审 `deriveReviewNodeNav` 同形）：节点当前态 = 该 nodeId
的 ULID/startedAt 最新 run，读它一行 stamp——不做「awaiting 优先」（那会伸手到当前态之外抓可能 stale 的
awaiting、被设计门两轮否决，见 design §2.3）。「点即可渲染，无空视图无 404」：`clarifyNavKind !== null` ⟹
该 run 最新轮存在（有 clarify_round、`getClarifyRoundDetail` 不 404）∧ 状态为 awaiting_human/answered；判据由
与 `getClarifyRoundDetail` **同源**的选行逻辑（最新轮 by createdAt）派生。

## 3. 非目标

- **不动「节点运行」表格的「去回答」按钮**（`shouldShowClarifyJump` = awaiting_human）——保留为补充入口，
  与 RFC-158 保留表格「评审」按钮一致。
- **不动反问页本身**（`/clarify/$nodeRunId` 的 awaiting / answered / abandoned 视图逻辑；`getClarifyRoundDetail`
  取数 / 排序也不动——判据 stamp 用同选法 createdAt-max、best-effort 对齐标签）。
- **不碰 clarify「选哪一轮」的一致性**（读 `getClarifyRoundDetail` / 写 `sealRoundQuestions`·
  `autoDispatchClarifyRound` 各按 run 无 tie-break 取轮是**先于本 RFC 的子系统属性**）：RFC-161 只新增一个读
  stamp、不改写路径。极窄的同-createdAt 并发幂等重放竞态下三处可能选到不同的等价重复轮——**RFC-161 的 nav
  仍安全**（stamp 非空 ⟹ 有 round ⟹ 不 404，裸链实时渲染当前轮），不放大它。统一 run-keyed 选轮 / 提交 pin
  roundId 是更大的 clarify 一致性课题，**另立 RFC**（设计门 Codex ⑥ 登记为后续项）。
- **`canceled` / `abandoned` 轮有意判 `null`（不可点）**：它们是取消 / 失败态（反问节点分别显灰 / 红），
  非「结论」，与 RFC-158 只让 awaiting + 人工 decided 可点、不让 canceled/failed 评审可点对齐。反问页虽能
  只读渲染 abandoned（带 abandoned chip），但把它标为「answered」会误导；首类化留作后续 RFC。
- **后端判据集中一处，不碰调度 / 决策流 / clarify 写服务 / ACL / migration**：`getTaskNodeRuns` 在既有 node_run
  投影栈点为每行 stamp `clarifyNavKind`（判据唯一事实源，含 canceled/failed 任务孤儿 awaiting 抑制 gate）。反问的
  round↔node_run 是 **1:N，取 createdAt-max 轮**（与 `getClarifyRoundDetail` 同选法；多轮仅源于幂等重放，
  `clarify.ts:115-118`），远比评审的多版本 / 多文档 / superseded 简单——**无需** RFC-158 那种共享泛型选择器，
  一个纯映射 `roundStatus → clarifyNavKind` 即够。安全属性只需「有 round ⟹ 不 404」（与选轮无关，见 design §4.5）。
- **两处 WS 刷新配套（让 cross↔self、quick↔defer 通道的画布可点性都随反问推进即时刷新）**：①`useTaskSync` 补
  `cross-clarify.created`/`answered`/`rejected` 三规则 invalidate node-runs（设计门 Codex ③①，保留既有
  RFC-123 directives）；②`routes/clarify.ts` defer 全量封存后补一个既有 `node.status` 事件的 emit（设计门 Codex
  ④②，不改封存事务），集中作答面板本地也失效 node-runs。**即便 stamp 暂陈旧，点击仍安全**（裸链渲染当前状态、
  不 404）。
- **工作流编辑器画布零变化**：新 prop 不传即字节不变（golden-lock，与 `reviewNavs` / `questionCounts` /
  `clarifyDirectives` 同款约定）。
- **不新增视觉基线**：8 张截图页均不含任务详情画布。
- **无 migration**：`clarifyNavKind` 读时派生，不落列（同 `reviewNavKind`）。

## 4. 用户故事

1. 我在看一个停在反问上的任务（反问节点琥珀色呼吸），直接点那个节点 → 进入反问页开始作答；不再先弹一个
   空 drawer 再去表格里找按钮。
2. 反问我昨天已回答，今天回看任务时点反问节点 → 直接只读回显那一轮（题目 + 我当时选/填的答案 + 谁提交的）。
3. 反问节点是分片自反问（agent-multi 上游），三个分片同时等我回答；点这个节点 → 进入其中一个分片的反问页，
   页内的分片切换器让我在三个分片间切换（画布节点只有一个，点它总能进得去）。
4. 任务刚启动、反问节点还是灰色（还没产生反问）→ 点它没有任何反应（也不会弹空 drawer）；节点上没有
   「可点击」暗示。
5. 我先点了灰色反问节点（无反应），几秒后 agent 发问、它变琥珀了，我再点 → 正常进反问页（点击不因先前
   选中被吞掉）。
6. cross-clarify 因父任务失败被置 `abandoned`（红色）→ 点它没有反应（不假装「有答案可看」）。
7. loop 里的反问：上一轮我已回答（绿色），这一轮 agent 又发问（琥珀）；点它进入的是**这一轮**的作答页，
   不是上一轮的历史（画布节点当前态 = 最新一轮）。

## 5. 验收标准

1. 任务详情画布点击 clarify / cross-clarify 节点**永不**打开 `NodeDetailDrawer`（含 drawer 已开时点击反问
   节点：drawer 关闭且不重开）。
2. 节点当前态（freshest run）`clarifyNavKind='awaiting'` 时点击 → 路由跳到 `/clarify/{该 run id}`（可交互）。
3. 节点当前态（freshest run）`clarifyNavKind='answered'` 时点击 → 跳 `/clarify/{该 run id}`（只读回显）；
   freshest run 为 null/其它 → 不可点（纯 freshest-run，见 design §2.3）。
4. 点击零动作（不可点），涵盖：freshest run 为——无 round 的反问 run（cross persistent-stop 透传 /
   missing-questioner guard）、`canceled` 轮、`abandoned` 轮、pending、canceled/failed 任务上的孤儿 awaiting
   （后端 gate）、旧 daemon 未派生该字段（严判 `=== 'awaiting'/'answered'`）。**因 freshest-run 只认当前 run，
   一条更新的 null/guard run 恒遮蔽同节点更旧的 answered/stale-awaiting 行**（设计门 Codex 两轮修：停/守卫节点
   与被取消任务不误标可点、不开陈旧历史，见 design §2.3）。
5. 可点击的反问节点有可见提示：`awaiting` →「点击回答反问」、`answered` →「点击查看反问记录」（i18n 双语），
   并呈 pointer 光标；不可点击时无提示、默认光标。clarify 与 cross-clarify 两个渲染器都要有。
6. 反问节点点击后 xyflow 选中态被立即释放（`clearSelection`），同一节点的连续点击每次都生效（防「已选中节点
   再点被吞」的 wedge，机制同 RFC-158 review 分支 / tasks-detail-drawer-close-reclick 锁定的回归）。
7. **点即可渲染，无空视图无 404**：可点击（`clarifyNavKind !== null`）⟹ 该 run 最新轮存在且（awaiting_human
   或 answered），判据由与 `getClarifyRoundDetail` 同源的「最新轮 by createdAt」派生（孤儿 awaiting gate 使其
   为单向蕴含——见 design §2.2）。
8. **分片自反问**：clarify 节点点击落到其 freshest run。多分片全 awaiting → 落某待答分片，页内 shard switcher
   覆盖其余；若 freshest 分片恰已 answered、另有分片待答 → 落只读页，到待答分片走 shard switcher（≥2 awaiting）
   或「节点运行」表格该分片的「去回答」按钮。此少见退化换取「零 stale-navigation + 与评审完全同构」，为文档化
   的可接受 v1 行为（见 design §2.3；不用「awaiting 优先」的理由：它被设计门两轮证伪）。
9. 工作流编辑器（`/workflows/$id`）画布行为与像素不变；任务详情画布对非反问节点行为不变；`/clarify` 列表页
   行为不变。
10. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；既有锁测试按盘点迁移
    （见 design §6）。
