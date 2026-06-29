# RFC-127 — 反问问题统一可指派 + 借壳顶替（每个问题都能换处理 agent）

> 状态：Draft（待用户批准进入实现）
> 触发：2026-06-29 用户「**每个待指派的问题都应该可以更换处理 agent**，不分 self / questioner / designer」+ 用户给出底层模型：「分配给谁处理，底层就是把问题塞给哪个 agent 的反问队列——可以让问题**先进一个公共问题队列**（不预绑 agent），**人选定某个 agent 下发后，再把问题注入给那个 agent**」。
> 调研：两路并行回源——① 产出归属 / 下游消费 / freshness 级联；② `node_run` 与「用哪个 agent 跑」的解耦度 / 借壳可行性。证据 file:line 见 `design.md §1`。
> 关系：**supersede RFC-120 的 D4（仅修订型可改派）+ 非目标 §2.2（阻塞-产出型不可改派）**。RFC-120 的问题清单 / 看板 / 确认 / 打回 / 历史回填 / prompt-isolation 一律继承不变；本 RFC 只把「可改派的角色」从 `designer` 扩到全部，并把改派的底层机制从「换节点」统一成「借壳顶替」。

## 1. 背景

### 1.1 现状：只有「修订型」问题能换处理 agent

RFC-120 给了任务级问题清单 + 「改派处理 agent」能力，但**只对 `cross 设计者域（designer）`条目开放**（`canReassign` 限定 `roleKind==='designer'`，`shared/task-questions.ts:178-184`）。另外两类——`self`（同节点反问的提问节点）、`questioner`（跨节点反问的反问者）——前后端都锁成只读，不可改派。

RFC-120 当初这么定（决策 D4 + 非目标 §2.2），是因为这两类是**「阻塞-产出型」**：它们那一次运行**用「提问」代替了「产出」**（吐 `<workflow-clarify>` 而非 `<workflow-output>`），下游正等它们的 output；必须由它们**自己**重跑产出，否则下游永久阻塞。当时判定「把它们改派给别的节点 = 原节点永不产出 = 结构性死锁」，故按设计禁止。

### 1.2 用户诉求：所有问题一视同仁，都能换处理 agent

用户在 2026-06-29 明确：清单里**每个**问题都应该能更换处理 agent，不应该按类型区分谁能改谁不能改。用户的心智模型是「问题先进公共队列、人给它选一个 agent、下发时注入给那个 agent」——即把「分配处理方」当作一个统一动作，与问题是哪种反问无关。

### 1.3 核心洞察：「借壳顶替」可以安全打破 §1.1 的死锁

调研发现 RFC-120 当年的死锁判定有一个**未被探索的出口**：死锁的根源是「原节点 P 不产出 → P 的下游饿死」，而**下游消费完全是按「源节点 id + 端口名」定位的**（`resolveUpstreamInputs` 取入边 → `WHERE node_runs.nodeId === edge.source.nodeId` → 取 freshest done → 按 port 名读，`scheduler.ts:4834-4888`）。也就是说：**只要在 P 名下出现一条 fresh 的 `done` 顶层 run、带着 P 声明的端口产出，P 的下游就天然放行**——下游根本不关心「这次产出实际是哪个 agent 跑出来的」。

同时，`node_runs` 表**没有任何 agent 字段**，agent 是每次调度时按 `node.agentName` 现解析（`scheduler.ts:1772`），`runNode` 早已把 agent 当入参、与 `nodeId`/`nodeRunId` 解耦（`runner.ts` agent 与 node_id 不绑定）。

两者合起来 →「**借壳**」：mint 一条**归属原节点 P**（`node_id=P`）的 run，但**用人选的 agent X 的定义（body/model）来跑**，沿用 P 的 prompt 模板 + **P 的输出端口契约**。X 的产出落在 P 名下、走 P 的下游、freshness/级联零改。这就是用户「注入给选定 agent」模型在阻塞-产出型问题上的正确底层实现：**注入对象 = 你选的 X；产出归属 = 原节点 P 的位置**。

## 2. 目标 / 非目标

### 2.1 目标（v1）

1. **全类型可指派**：问题清单里 `self` / `questioner` / `designer` / `manual` **全部**条目都能把处理 agent 改派到本工作流里任意 `kind=agent` 的节点；不再按角色限制改派权（取代 RFC-120 D4）。
2. **借壳顶替为统一底层机制**：改派后下发 = mint 一条 `node_id=原节点` 的 run、用选定 agent X 的定义跑、按**原节点的输出端口契约**产出，产出归原节点、走原节点下游、解除原节点的 `awaiting_human` park。
3. **统一取代现状 designer「换节点」**：designer 改派也并入借壳（产出归原 designer 节点、走其下游），不再是「换到 X 节点、走 X 下游」（supersede RFC-120 designer 改派实现 + 其测试）。
4. **下发触发借壳**：改派后「下发」动作 = mint 借壳 rerun 执行。注意「下发前怎么回答 / 入队列」（公共队列 + 任务级集中回答界面 + 待下发答案 gate + 两入口 + per-question 逐题答/下发）的交互层归 **RFC-128**；本 RFC 只管「下发被触发后如何借壳执行」。两者合起来才是用户「公共队列 + 选 agent + 注入下发」模型的完整落地。
5. **`readonly` 随借用 agent**：借壳那一跑的 `readonly` 取自 X（P readonly 借 X writer → 这次占写锁、与其他写串行；反之并行）。这是有意的——「换个会改文件的 agent 来干」正是诉求之一。
6. **归属隔离不变**：谁改派 / 谁确认等归属记录只入审计列与 UI，**绝不进任何 agent prompt**（沿用 RFC-099 / RFC-120 D8 铁律）。
7. **权限不变**：可见 / 改派 / 确认 / 打回 = 任务成员（owner+collaborator）+ admin（沿用 RFC-120 D7）。
8. **复用公共原语**：UI 仅放开既有改派下拉的角色限制 + 必要提示，无新原生 chrome。

### 2.2 非目标

- **不引入 DAG 外的临时执行原语**：借壳只能借**本工作流里已有节点**的 agent，不凭空起一个脱离图的 agent（沿用 RFC-120 §2.2）。
- **不改反问 envelope / scope / 注入协议本身**：scope 仍是回答期逐题选择（RFC-059 不变）。
- **不做跨任务全局问题队列**：仍按任务归属（留后续）。
- **不做改派目标的智能推荐 / 胜任度校验**：只给「从工作流节点里选」，由人判断 X 是否能产出 P 的端口契约（端口不匹配的处理见 §5 开放问题）。
- **不改 RFC-120 的确认 / 打回 / 历史回填 / 看板列**：全部继承。

## 3. 用户故事

1. **作为审计闭环负责人（self 场景）**：代码节点 P 跑到一半向人反问。我在清单里看到这条 `self` 问题，觉得 P 那个 agent 不擅长收尾，于是把它改派给「资深实现」节点 X、回答问题、下发。X 带着「P 的输入 + 我的答案 + P 留在 worktree 的中间状态」接着干，**产出落在 P 的位置、P 的下游照常拿到产出**——P 不再卡住。
2. **作为审计闭环负责人（questioner 场景）**：审计节点 Q 跨节点反问后要自己续跑产出审计结论。我把这条 `questioner` 问题改派给另一个更细致的审计 agent X，下发后 X 顶替 Q 产出、Q 的下游接得到。
3. **作为修订把关者（designer 场景，行为微调）**：设计者 D 被反问，我把 designer 域条目改派给「安全修复」节点 X。X 用我的答案做修订，**产出落在 D 的位置、走 D 的下游**（与 RFC-120 旧版「走 X 的下游」不同——见 §4 决策 D3 的行为变更说明）。
4. **作为统一队列的使用者**：不管问题是哪种反问，我看到的都是同一套「选一个 agent → 下发」的操作，不需要记「这类能改、那类不能」。
5. **作为追踪进度 / 质量把关 / 协作 / 合规视角**：与 RFC-120 用户故事 2–6 完全一致（相位、确认、打回、成员可见、归属不入 prompt）。

## 4. 决策登记

- **D1（改派权）= 全类型可改派**：取代 RFC-120 D4「仅 designer」。`self`/`questioner`/`designer`/`manual` 条目都可写 `override_target_node_id`，目标须是工作流 `kind=agent` 节点。
- **D2（机制）= 借壳顶替**：改派+下发 → mint `node_id=原节点` 的 run、agent=X、按原节点端口契约产出、产出归原节点、走原下游、解除原节点 park。`node_runs` 加一列记借用的 agent（审计 + 跨 tick 重派可见）。
- **D3（统一）= designer 也并入借壳（行为变更）**：现状 designer 改派是「换到 X 节点、X 以自身产出、走 X 下游」；本 RFC 改为「借壳：X 干 D 的活、产出归 D、走 D 下游」。**这是一个对既有 designer 改派用户可见的行为变更**——修订产出从「流向 X 的下游」改为「流向 D 的下游」，更贴「修订 D 的产出」的直觉。supersede RFC-120 相关实现与测试。
- **D4（readonly）= 随借用 agent**：借壳那一跑的 readonly 取自 X，写串行 / worktree 回滚自动跟随 X。形式上仍「readonly 从 agent 继承」（只是从 X 继承），但语义上类别可能翻转——明确允许。
- **D5（默认 handler）= 原节点**：不改派时默认承接 = 原节点（保持现状自动续跑作为默认），人改派后才借壳。
- **D6（隔离 / 权限 / 确认 / 打回 / 回填）= 沿用 RFC-120**：D7/D8 + 看板 + 确认 + 打回 + 历史回填规则不变。

## 5. 开放问题（design.md 收口，部分需你拍板）

1. **self 顶替的 worktree 中间状态语义**：self 问题里 P 提问前可能已改了 worktree（半成品）。借壳 X 是全新进程，看到的是 P 留下的 worktree 现状 + 注入的「问题+答案+P 的输入」。要不要把「P 此前的产出过程/思路」也喂给 X？v1 倾向：只喂 P 的输入模板 + 问题 + 答案 + worktree 现状（X 凭这些接手），不重建 P 的内部对话。
2. **端口契约不匹配**：X 的 agent 在 frontmatter 里声明的 outputs 可能不含 P 需要的端口。借壳强制按 **P 的 outputs 契约** 注入输出协议块（要求 X 吐 P 的端口）；若 X 实际没吐 → 沿用现有 envelope 校验失败 → run `failed`（相位仍「处理中」，等人重选/重跑）。是否在改派 UI 上提示「X 需能产出 端口 a/b/c」留 design 定。
3. **readonly 翻转的写串行影响**：P readonly 借 X writer 会让这一跑占写锁 → 可能与同任务其他写节点串行、降低并行度；需确认无死锁/饥饿。
4. **默认是否全任务走 deferred（公共队列）**：用户模型「先进队列再分配」对应 RFC-120 的 `deferredQuestionDispatch`（目前任务级开关）。是否把它变成默认/常开，还是保持开关，需你定。
5. **RFC-120 相位 / lineage 调和**：`resolveHandlerRun` 现按 `effectiveTarget` 的 nodeId 框 lineage；借壳后承接 run 在原节点名下，相位派生与消费戳记账要改按原节点框（design.md 给契约 + 回归锁）。

## 6. 验收标准（每条先红后绿；门槛 typecheck + test + format:check 全绿 + CI + Codex 双 gate）

- **AC-1**：`canReassign` 放开到全角色（`self`/`questioner`/`designer`/`manual`），仅校验「目标是工作流 agent 节点」；给非 agent 节点 / 非工作流节点仍 422。锁「全角色可改派」回归。
- **AC-2**：前端改派下拉对全角色非终态条目开放（取代 RFC-127 前置修复里「仅 designer + pending」的 `reassignable`），已下发态仍只读（走打回）。
- **AC-3（借壳 mint）**：纯函数 + service——改派下发对 `self`/`questioner` mint `node_id=原节点` 的 run、`agent_override=X`、cause 同各自原 cause；`done` 后产出落在原节点名下。
- **AC-4（下游接线）**：集成断言——self/questioner 借壳 run `done`+输出后，**原节点的下游节点被调度并消费到该产出**（不死锁）；原节点 `awaiting_human` park 被解除。
- **AC-5（端口契约）**：借壳注入用**原节点的 outputs 协议块**；X 未吐齐 → envelope 校验 `failed`、不落部分端口、相位回「处理中」。
- **AC-6（designer 行为变更）**：designer 改派改为借壳（产出归 D、走 D 下游）；更新/替换 RFC-120 旧「走 X 下游」测试，注释标明行为变更来源。
- **AC-7（readonly 随 X）**：借壳跑的写锁 / 回滚按 X.readonly；P readonly 借 X writer → 占写锁、串行；P writer 借 X readonly → 不占写锁。
- **AC-8（相位 / lineage）**：`resolveHandlerRun` 按原节点框 lineage，借壳承接 run 正确派生「处理中 / 已处理待确认」；后续不相关新轮不误拉相位。
- **AC-9（prompt-isolation）**：借壳 run 的 promptText 永不含改派人 / 归属字段（双层断言，仿 RFC-099/120 AC-13）。
- **AC-10（权限）**：改派 / 下发经 `requireTaskMember`；非成员 404/403。
