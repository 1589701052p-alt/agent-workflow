# RFC-134 产品提案：改派回执——处理节点被修改时，问题同步下发给提问节点

> 状态：Draft（待用户批准进入实现）
> 触发：2026-07-02 用户「如果一个节点的处理节点被修改了，也要把问题同步下发给提问题的节点」。同日 4 项拍板：① 回执入队等提问节点自然重跑（不 mint）② 物化第二条条目 ③ 通用不变量（凡有效承接 ≠ 提问节点）④ 本 RFC 只做回执，「去掉跨节点反问」缓议、等看板改派流程实际用一段时间再评估。
> 调研：三路回源（反问节点 RFC-023/063/064/100 机制、跨节点反问 RFC-056/059 机制、问题中心 RFC-120→133 演化线）+ 契约层核读（reconcile / dispatch / 统一注入 / 派生老化四层）。证据 file:line 见 `design.md §1`。

## 1. 背景

### 1.1 现状缺口：move 改派后，提问节点永远看不到答案

RFC-127 放开「任意问题可改派」、RFC-131 T4 + RFC-132 把改派统一为 **move 语义**（rerun mint 在目标节点、目标节点跑自己的 agent）之后，一条 self / questioner 问题被改派到别的节点 X 时：

1. 该问题在 `task_questions` 只有**一条**条目（identity = origin × question × role，`db/schema.ts:1866-1870`；self 轮 reconcile 恒产一条 `shared/task-questions.ts:99-108`）。设 `override_target_node_id = X` 后，注入投影整个移到 X——统一注入器按 effectiveTarget（override ?? default）选取（`services/clarifyQueue.ts:97-104`）。
2. 提问节点的 agent 队列里**再也没有这题**。它之后经级联重跑时，prompt 里只有修订后的上游产物，没有「人类当时的回答」。
3. 后果：若答案语义是「不改 / 忽略这点」，提问节点下一轮很可能**把同一个问题再问一遍**（重问循环）；即便答案已体现在产物里，它也无从把「人类决定」与「产物变化」对齐。

对照：跨节点反问（cross）的 designer 域问题天然是**双条目**（questioner + designer，RFC-120 D2）——修改方拿反馈去修，**反问者永远收全量 Q&A**（RFC-059 的单向标记设计，`design/RFC-059-cross-clarify-question-scope/proposal.md` §5.0）。move 改派丢掉的正是这层保障。

### 1.2 用户诉求

「如果一个节点的处理节点被修改了，也要把问题同步下发给提问题的节点」——把 cross 专属的「反问者必收全量 Q&A」提升为问题中心的**通用不变量**：

> **凡一条问题的有效承接节点 ≠ 提问节点，下发时同步把该题 Q&A 送进提问节点的队列。**

## 2. 目标 / 非目标

### 2.1 目标（v1）

1. **回执条目（roleKind=`echo`）**：下发（dispatch）时，对本批中 roleKind ∈ {self, questioner} 且有效承接 ≠ 默认承接（提问节点，非空）的每条条目，**同事务**物化一条 `roleKind='echo'` 回执条目：目标 = 提问节点（default_target 复制、override 恒 NULL）、**生来已下发**（`dispatched_at` = 批次时间戳）、继承 seal、`trigger_run_id = NULL` 排队。
2. **入队等自然重跑、不 mint**（拍板①）：回执不给提问节点铸 rerun。提问节点下一次运行（通常是修改方产出后的级联重跑）时，由既有统一注入器平铺注入该 Q&A、绑定承接、正常派生老化——注入层对 echo **无任何特判**；唯一注入层改动是一处**角色无关**的同题同目标渲染去重（Codex R2-F3——同时修复现状已存在的「designer 条目改派到 questioner 节点 → 同一 Q&A 双渲染」bug，见 design §5）。
3. **通用不变量**（拍板③）：self 改派、cross questioner 条目改派全覆盖；cross designer 域由既有 questioner 条目天然满足（不重复产回执）；manual 问题无提问节点、不适用。
4. **生命周期完整**：回执条目走既有相位派生（processing → awaiting_confirm → done）；**只读知会**——不可改派 / 不可重复下发（生来已下发，既有 CAS 天然拒）、不可 stage（**新增原子 CAS 守卫**：staged=true 改为 `WHERE dispatched_at IS NULL` 条件更新、0 行即 Conflict——现状 `stageTaskQuestion` 只查 seal 无 dispatched 检查（Codex R2-F4），且必须是条件更新而非先查后改（R3-F7 并发盖戳竞态）；通用于所有已下发行）；confirm 放宽为**任意相位可关闭**看板卡（关闭只收卡、不撤销投递，见 D3）。
5. **cause 序列化显式豁免**（Codex 设计 gate F1 fold，见 design §4）：回执不 mint、不拥有 rerun_cause，**不进入**任何 cause 序列化守卫（两处三角色白名单保持不动并加源码锁）——一条未消费的回执**绝不** 409 阻塞对提问节点的后续任何下发；它可以搭提问节点**任意 cause** 的下一次运行送达（含同批异类 mint 的 run——提前送达，测试锁定为有意行为）。
6. **零 migration、零 API 破坏**：`role_kind` 列无 CHECK 约束（`db/migrations/0060_rfc120_task_questions.sql:23`），枚举纯应用层扩宽；DTO / WS 纯增量（新增枚举值）。

### 2.2 非目标

- **不回填历史**：升级前已下发的改派条目不补回执——老任务的提问节点多半不会再运行，回填只会在看板挂一批永久 processing 的噪音卡。不变量自升级后的新下发生效（forward-only，D6）。
- **不改 move 改派语义**：改派仍是「目标节点跑自己」；回执是知会，不是把问题「还给」提问节点，也不改变承接义务归属。
- **不做「修改方跑完后补 mint 提问节点」**（拍板①否决的第三选项）：若图上无通路导致提问节点不再重跑，回执留在队列里、看板可见、可人工 confirm 收卡，不强制执行。
- **不动跨节点反问节点**（拍板④）：cross 节点的去留另行评估；本 RFC 与其并存且不改其行为。
- **不加通知 / 推送**：回执只是队列条目 + 看板卡，不进 inbox、不发通知。
- **不改 agent 怎么提问**：`<workflow-clarify>` envelope、mandatory ask-back、节点反问状态（directive）均不动（延续 RFC-132 非目标）。
- **不实现 reopen（打回）、不做 reopen 联动**（Codex 设计 gate F2 fold）：打回在当前代码**并不存在**（`reopenTaskQuestion` 全仓零命中，`taskQuestions.ts:1012` 的 "use reopen" 提示指向 RFC-120 AC-11 的期货）——下发后答案与承接目标均不可变，因此现状**不存在**「回执送旧答案」问题。初稿设想的「打回→回执重排队 / 改回即删」整体移出 scope，登记为未来 reopen RFC 的**强制耦合点**（design §7 末行）。

## 3. 用户故事

1. **审计→编码改派闭环**：审计 agent（self 反问）问「缓存失效策略要不要兼容旧版本？」。我认为该由「编码」节点顺手落实，于是在看板把承接改派给编码节点、回答「不兼容，按新版实现」并下发。编码节点重跑落实；**审计 agent 之后级联重跑时，prompt 里平铺着这条 Q&A**——它知道人类拍了「不兼容」，不再重问，并能按此校验产物。
2. **看板双卡**：那条问题在看板上有两张卡——编码节点的承接卡（处理中→已处理待确认）和审计节点的**回执卡**（标「回执」，处理中）；审计节点重跑产出后回执卡变已处理待确认，我点确认收尾；若审计节点因图拓扑不再重跑，我也可以直接确认收掉回执卡。
3. **回执不挡路**：审计节点挂着一条未消费的回执，我随后往它头上派了一条 manual 修复指令——下发**不被 409 拦**（回执豁免于 cause 序列化）；审计节点为这条 manual 起的重跑顺带把回执 Q&A 一起注入送达（提前送达，一次运行两事全办）。
4. **不双渲染**：同一题即便因跨角色改派出现「两行同指一个节点」（如 designer 条目被改派到 questioner 节点，或回执与后到的兄弟同指提问节点），渲染层按 (origin, question) 去重——prompt 里该 Q&A 只出现一次，且两行都正常绑定、老化（design §5）。

## 4. 验收标准

> 每条带测试（先红后绿）；门槛 `bun run typecheck && bun run test && bun run format:check` 全绿 + CI（lint + test×2OS + binary smoke×2OS + Playwright e2e + 静态扫描）；按 [feedback_post_commit_ci_check] push 后查 CI；按 [feedback_codex_review_after_changes] 设计 gate + 实现 gate 各过 Codex。

**不变量与写入**

- AC-1：`dispatchTaskQuestions` 同事务内，对本批 roleKind∈{self,questioner} ∧ override 非空 ∧ override ≠ default ∧ default 非空的条目，恰插一条 echo 行（字段见 design §2）；**不**把提问节点加入 mint / frontier 集合（提问节点 run 计数不因回执改变）；default 为空跳过 + log。
- AC-1b：**seal 行戳归一化**（Codex R5-F9）——同事务对本批 stamp 成功且 `sealed_at IS NULL` 的 clarify 行补 `sealed_at`（`sealed_by` 留 NULL 作「answered 轮证据落戳」审计语义）：凡下发出去的行必可渲染（收敛「dispatch 收轮级证据、`selectAgentQueue` 只认行级戳」的分歧，`taskQuestionDispatch.ts:163-186` vs `clarifyQueue.ts:106`），顺带修 pre-existing「懒建行下发给承接方后永不注入」投递洞；manual 不补、已 sealed 不改写、历史已下发行不追溯（黄金锁 + forward-only）。回归：answered 轮 sealedAt NULL 源条目改派下发 → 承接方与提问节点**双投递均渲染**。
- AC-2：注入无 echo 特判——提问节点下一次运行时 `selectAgentQueue` 选中回执、`renderFlatClarifyQueue` 平铺渲染、`bindTriggerRun` 绑定、done+output 后 `isTargetNodeConsumed` 老化，全为既有代码路径；唯一注入层改动 = **角色无关**的 (origin, question) 渲染去重（同题多行渲染一次、绑定全量，design §5）；**源码层断言 `services/clarifyQueue.ts` 不含 `'echo'` 字面量**（兜底锁）。
- AC-2b：同题同目标双渲染回归（Codex R2-F3）——① pre-existing：cross designer 条目改派到 questioner 节点（含 done-无-output 后再下发时序）→ 该 Q&A 在下次 rerun prompt 仅现一次、两行均绑定老化；② echo 跨批与 designer 兄弟同指提问节点 → 同样单渲染双绑定；③ manual 不参与去重；④ `planEchoEntries` 兄弟跳过为**交付感知 + 可渲染性**（R3-F6 + R4-F8 + R6-F11 单值化）：跳过 = 兄弟指向提问节点 ∧（已下发 ∨ ∈ 本批 stamp 集）∧（行级 sealed_at 非空 ∨ ∈ 本批 stamp 集——同批行经 seal 归一化必可渲染）；未下发兄弟 → 仍产 echo（承诺≠交付）；**历史已下发**且 sealed_at NULL 的兄弟（升级前 answered 轮懒建行，无追溯归一化）→ **仍产 echo**（已下发≠可渲染，`clarifyQueue.ts:106`）；**同批** sealed_at NULL 兄弟 → 跳过（归一化后必可渲染）——两分支分开锁；echo 自身 sealedAt 由纯函数按「源 sealedAt ?? batchTimestamp（显式入参，R7-F12）」定值，恒可渲染。
- AC-3：**序列化豁免**——两处守卫白名单（`taskQuestionDispatch.ts:627`、`clarifyAutoDispatch.ts:177`）保持 `['self','questioner','designer']` 不动 + 源码文本锁（不得含 `'echo'`）；测试：queued 回执挂在提问节点上时，后续对该节点的**同类与异类**下发均放行、零 409；同批「改派 + 异类下发到提问节点」→ 异类 rerun 注入并绑定回执、老化正确（Codex F1 场景以结果正确锁定）。`causeClassForEntry` 对 `'echo'` 保持全函数性（按 sourceKind 防御映射：self→`clarify-answer`、cross→`cross-clarify-questioner-rerun`），注释声明不作守卫判据。
- AC-4：幂等 / 唯一——identity (origin, question, 'echo') 唯一索引兜底；同批重放 / crash-retry `onConflictDoNothing` 不重不改；reconcile 对 echo 行不增、不改、不删（其 designer 清理分支 `taskQuestions.ts:256-267` 触碰不到 echo，测试锁定）。
- AC-5：cross designer 域条目被改派**不**产回执（questioner 条目已在）；manual 条目不产回执；未改派（override 空或 == default）不产回执（黄金锁：无改派批次的 dispatch 行为逐字节不变）。

**生命周期**

- AC-6：相位派生复用——回执 queued → processing（`resolveDispatchedEntryHandler` dispatched+trigger NULL 分支 `taskQuestions.ts:318-323`）；绑定 + done+output → awaiting_confirm；confirm → done。
- AC-7：只读知会——reassign / 重复 dispatch 被既有 `dispatched_at IS NULL` CAS 拒（`taskQuestions.ts:1012`、dispatch in-tx CAS），测试锁定；**stage 新增原子 CAS 守卫**：staged=true 改为 `WHERE id=? AND dispatched_at IS NULL` 条件更新、受影响 0 行 → ConflictError（现状只查 seal，`taskQuestions.ts:1050`；R3-F7 指出先查后改有并发盖戳竞态，故必须条件更新），un-stage 不动，含并发 dispatch-vs-stage 回归；confirm 对 echo 放宽为任意相位可调（其余角色 guard 不变），confirm 不影响注入选取（选取层无 confirmation 过滤，`clarifyQueue.ts:90-106`）。
- AC-8：**未来耦合登记**——reopen（打回）当前不存在（非目标⑦）；design §7 末行登记「实现打回的 RFC 必须联动 echo（重排队 / 改回即删）」；本 RFC 交付物中该登记行存在即验收（文档断言）。

**隔离 / 前端 / 门禁**

- AC-9：RFC-099 prompt-isolation 延续——echo 行的 dispatched_by 等归属列绝不入 prompt（复用既有双层锁 + 回执渲染断言）；零 DB migration（无新列、无 CHECK，`db/migrations/0060_rfc120_task_questions.sql:23` 佐证）。
- AC-10：前端——看板回执卡：role 标签「回执」（i18n 中英对称）、动作仅 confirm + 跳转、无改派下拉 / 无 stage；节点过滤兼容；全部复用既有公共组件（StatusChip / Select / ConfirmButton / .data-table），vitest 覆盖；视觉对齐自查。

## 5. 决策登记

- **D1（时机）= 入队等自然重跑、不 mint**：用户 2026-07-02 拍板；否决「下发时同步 mint」（并行跑、读旧上游、多烧一次运行）与「修改方跑完后补 mint」（需新增消费后触发机制）。
- **D2（形态）= 物化第二条条目 roleKind='echo'**：identity (origin, question, 'echo') 天然去重；trigger_run_id / 老化 / 相位每条目单值语义零改动；看板可见。否决「单条目双队列投影」（要动 clarifyRerunLedger 单值契约，风险高）。
- **D3（confirm 语义）= 任意相位可 confirm、confirm 不撤销投递**：回执是知会卡，人随时可「已知悉」收卡；投递撤销语义在任何条目上都不存在（选取层从不读 confirmation），老化是唯一出队方式——回执不例外，保持全链路一致。
- **D4（序列化豁免）**：echo **不进入** cause 序列化守卫（白名单保持三角色 + 源码锁），可搭任意 cause 的运行送达。语义依据：「一 run 一 cause」约束的是**拥有 rerun** 的条目（cause 决定 run 的构建模式），echo 不 mint、无 rerun_cause，是纯载荷；平铺注入本就无差别混装所有角色。产品依据：若按 Codex F1 原建议把 echo 纳入守卫，一条未消费的回执会 409 阻塞对提问节点的一切异类下发（manual 修复 / designer 反馈）——让知会卡挡真实工作，重蹈 RFC-133 刚修掉的 queued 假阳性死锁类。`causeClassForEntry` 仅为 TS 穷尽性做防御映射，不作判据。取代初稿的「cause 同质」方案（该方案与三角色白名单现实不符，Codex F1 揪出）。
- **D5（范围）= 通用不变量**：self / questioner 改派全覆盖；designer / manual 不产回执（前者由 questioner 条目天然满足、后者无提问节点）。用户 2026-07-02 拍板。
- **D6（不回填）= forward-only**：避免老任务看板噪音；与 RFC-132 forward-only 口径一致。
- **D7（排期）= 只做回执，cross 缓议**：用户 2026-07-02 拍板——「去掉跨节点反问」等看板改派流程用出手感后再评估（回执正是其前置补丁之一）。
- **D8（reopen 出 scope）**：打回从未实现（RFC-120 AC-11 期货，Codex F2 揪出）——初稿的 reopen 联动全部移出，改为 design §7 的强制耦合登记；现状答案下发后不可变 → 无陈旧回执问题。
- **D9（同题同目标渲染去重，角色无关）**：初稿「双渲染结构性不可能」论证只覆盖 echo vs 源条目，漏了跨角色兄弟（designer 条目可改派到 questioner 节点——现状已可双渲染，Codex R2-F3）。修复放在渲染层按 (origin, question) 去重、绑定仍全量——一处角色无关代码同时治 pre-existing bug 与 echo 新组合；`planEchoEntries` 兄弟跳过防冗余卡，跳过判定为**交付感知 + 可渲染性**（R3-F6：兄弟已下发或同批 stamp 才算交付、承诺不抑制回执；R4-F8：已下发但行级 sealed_at NULL 的兄弟永不入队渲染、同样不算交付）。
- **D10（stage 原子 CAS 守卫）**：「stage 被 CAS 天然拒」的初稿断言不成立（`stageTaskQuestion` 只查 seal，Codex R2-F4）；且守卫必须是**条件更新**而非先查后改（R3-F7：并发 dispatch 可在检查与更新间隙盖 `dispatched_at` 戳）——staged=true 走 `WHERE dispatched_at IS NULL`、0 行即 Conflict，通用于所有已下发行，非 echo 特判。
- **D11（dispatch 即 seal 落行戳）**：dispatch 接受「轮已 answered」当 seal 证据、注入选取只认行级 `sealed_at`（R5-F9 揪出的分歧，殃及承接方与 echo 双侧投递）——在唯一 choke point（stamp 同事务）对 sealedAt NULL 的 clarify 行补行戳。选写侧单点归一化而非改 `selectAgentQueue` 读判据：后者要在选取层引入 round 查询、改动所有既有队列语义；归一化语义保持（这些行本就被当 sealed 接受）且顺带修 pre-existing 承接投递洞。

> **Codex 设计 gate fold（2026-07-02，落码前，共 8 轮——R1-R7 产 12 findings 全 fold，R8 approve 无发现）**：R1 2 findings（2 high）+ R2 3 findings（1 high 2 medium）+ R3 2 findings（1 high 1 medium）+ R4 1 finding（1 high）**全采纳**——F1（cause 同质方案与三角色白名单现实不符 + 同批异类绑定路径）折为 **D4 序列化豁免**（处置方向与 Codex 原建议相反，理由见 D4）；F2（reopen 不存在）折为 **D8 出 scope + 耦合登记**；R2-F3（双渲染论证漏跨角色兄弟）折为 **D9 渲染去重**；R2-F4（stage 无守卫）折为 **D10**；R2-F5（顶层 RFC 索引行残留 R1 旧方案表述）已改写索引行；R3-F6（兄弟跳过误把承诺当交付）折为 **D9 交付感知收紧**；R3-F7（stage 先查后改竞态）折为 **D10 原子 CAS 收紧**；R4-F8（已下发但行级 sealed_at NULL 的兄弟永不可渲染、不构成交付）折为 **D9 可渲染性收紧 + echo sealedAt 兜底非装饰**；R5-F9（sealedAt 兜底只救 echo、源条目下发给承接方仍可永不渲染）折为 **D11 dispatch 即 seal 落行戳**（顺带修 pre-existing 承接投递洞）；R5-F10（planEchoEntries 签名漏判定入参）已把签名改为 batch + 兄弟快照 + 本批 stamp 集的真实形态；R6-F11（同批 sealedAt NULL 兄弟被 D11 归一化后仍被当不可渲染——谓词与归一化时序矛盾、SiblingSnapshot 漏 id、测试锁错分支）折为**谓词 stampedIds 单值化 + 归一化提为 §3 第一步 + 测试两分支分开锁**；R7-F12（纯函数缺 batchTimestamp 入参、sealedAt 兜底无从定值）折为**签名补 batchTimestamp、EchoPlan.sealedAt 在 oracle 内定值**。共 7 轮 12 findings 全 fold。折叠详情见 `design.md §2.2 / §2.3 / §3 / §4 / §5 / §7`。

> 详见 `design.md`（契约证据、数据模型、写入点、序列化豁免论证、失败模式、测试策略）与 `plan.md`（任务分解、依赖、验收清单）。
