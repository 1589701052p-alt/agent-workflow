# RFC-014 Proposal — Iterate 多文档节点：兄弟产物同步重生 + Prompt 引导

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：[RFC-005](../RFC-005-human-review/proposal.md) §2.1 #8 / A3 / L2

## 1. 背景

RFC-005 把"返回修改"（iterate）实现成了**单 port 局部更新**：

> A3（iterate 部分接受）：designer 输出 portA + portB；iterate 只评 portA；agent 重跑输出 portA' + portB'；框架 doc_versions 落库时 portA 写新值、portB 沿用 v1；review 仅对 portA。

这套规则是为"提意见微调 portA 不要副作用打到 portB"设计的——但实际跑设计评审场景半年后暴露了一个反向问题：**一个 agent 产出多个互相强耦合的文档时（典型：`proposal.md` / `design.md` / `plan.md`），用户对 design.md 提了意见、框架却让 proposal/plan 沿用上一版本，结果三份文档在事实层面就开始打架——design 改了接口、proposal 里的用户故事没跟进、plan 里的子任务编号还在指着旧接口**。用户的真实诉求是"以 design 的修订为锚，把 proposal 和 plan 一起拉到新版本"，而不是"只动 design"。

更糟的是，RFC-005 的 prompt 注入只告诉 agent "用户对 portA 提了意见、target_port=portA"，没有任何信号告诉 agent "你还产出了 portB 和 portC，请保持一致"。agent 在 iterate 重跑时倾向于把 portB / portC 原样复述（甚至直接照搬上一版），等于把"局部更新"的合并规则反向印证为"局部更新"的生成规则——人和模型一起把这条路径锁死了。

### 1.1 为什么要现在做

- RFC-005 已 Done（5 PR 全部落地，534/534 backend + 681/681 frontend 绿），iterate 是已上线行为；继续放任会让"用平台跑多文档评审循环"的产品愿景持续掉真。
- 修复面集中：prompt token + 决策合并 + sibling cascade 三处，**不动** envelope / anchor / doc_versions schema / UI 决策三按钮 等已稳定契约。
- 不动 reject 路径——reject 的"全 port 重生 + sibling cascade"语义本身已经符合"以一份文档为锚带动其它文档"的直觉，这次只把 iterate 对齐到同一行为模型上（差异保留在"是否回滚 worktree 文件"和"prompt 注入哪种 review context"两点）。

### 1.2 本 RFC 不动哪些地方

- **不动** approve / reject 两条决策路径的语义与 UI。
- **不动** `doc_versions` / `review_comments` / `node_runs` 表结构；新行为只改写入策略不改 schema。
- **不动** envelope `<workflow-output>` 解析与 `outputs[i].kind` 字段。
- **不动** RFC-005 既有 builtin token（`__review_rejection__` / `__review_comments__` / `__iterate_target_port__`）的语义；本 RFC **新增**一个 `__sibling_outputs__`。
- **不动** 单 markdown 输出节点的 iterate 行为——节点只有一个 `markdown[_file]` port 时新规则**完全不触发**，老路径原样跑。
- **不动** `kind=string` 的机器路由 port——它们是数据流，不是给人看的文档，不进 sibling 同步集合。
- **不动** multi-process review fanout（RFC-005 B-T14 follow-up）与 wrapper-loop 内嵌 review（B-T15）——它们仍在 RFC-005 范围外。

## 2. 目标

### 2.1 做

1. **iterate 决策：合并策略反转为"全 markdown[_file] port 重生"**（受 agent 开关 + markdown 数量双重守卫）。
   - 触发条件 **AND**：
     - **agent 配置开关** `syncOutputsOnIterate: true`（默认 `true`，见 #6）。
     - 被 iterate 的 review 节点的**上游 agent 节点**声明的 `outputs` 中，`kind ∈ { 'markdown', 'markdown_file' }` 的 port 数量 ≥ 2。
   - 行为：上游 agent 重跑后，**每一个** markdown[_file] port 都落 `doc_versions` v(n+1) 新行；不再做"只接受 target port 的变动、其它沿用 v1"的局部合并。
   - 反例（不触发）：agent 显式 `syncOutputsOnIterate: false` / 上游只有 1 个 markdown 输出 / 上游所有非 target 输出都是 `kind=string` → 行为完全等同 RFC-005 现行 iterate，包括 doc_versions 仅落 target port 的 v(n+1)。

2. **新 builtin token `{{__sibling_outputs__}}`**。
   - 仅在 iterate 路径且上游有 ≥ 2 个 markdown[_file] 输出时填充；其它情况空串。
   - 内容形态：每个非 target sibling port 渲染成 `### {port_name}\n{当前版本正文}\n` 的 markdown 段，前置一行英文指令 `You also produced the following sibling documents. They are tightly coupled with the document being revised; rewrite them coherently so the whole set stays consistent.`。
   - 模板未引用时框架自动追加到 user prompt 末尾，机制与 `__review_comments__` / `__review_rejection__` 一致（RFC-005 §7.2）。
   - 命名稳定契约：测试以源码文本断言保留 `__sibling_outputs__` 字面量（同 RFC-005 C4 兜底模式）。

3. **Sibling review 节点级联重审**。
   - 当 iterate 在多 markdown 上游触发时，**所有挂在该上游节点其它 markdown[_file] port 上的 review 节点**——无论当前状态是 `awaiting_review` / `done(approved)` / `done(iterated)`——一律回退为 `awaiting_review` 并 `reviewIteration += 1`。
   - 与 RFC-005 reject 的 sibling cascade 语义对齐（A2 的 sibling 作废重审），把 iterate 也接进同一条 cascade 函数。
   - 已 approved 的 sibling 也会被冲刷——这是预期行为：用户既然让 portA 重生且 portB 强耦合，旧 portB 的 approve 决策对新内容不成立。UI 上以 toast / banner 明确告知"M 条已通过的兄弟评审已被打回，原因：portA 触发同步重生"。

4. **同一次 iterate 共享 `reviewIteration` 编号**。
   - 上游重跑产出的每一个 markdown[_file] port 的新 `doc_versions` 行，使用**同一个** `reviewIteration` 值（target port 的 next iteration）。横向比"这是哪一次评审带出的同批快照"时可以直接按 reviewIteration 对齐。
   - 不引入新列；复用现有 `doc_versions.reviewIteration` 字段。

5. **决策路径的 worktree 行为保持 RFC-005 §2.1 #8 的现行约定**。
   - iterate 默认**不**回滚 worktree 文件（仅按 `rerunnable_on_iterate` 重置 node_run 状态），sibling port 也不动文件——与 reject 的"还原文件"是不同的。本 RFC 只改 doc_versions 合并和 prompt 注入，不改回滚集合。

6. **agent 配置新增 `syncOutputsOnIterate: boolean`（默认 `true`）**。
   - 字段位置：agent.md frontmatter 顶层布尔，与 `readonly` 同级；DB `agents` 表对应列由现有 frontmatter pass-through 通道承载（在 `AgentSchema` 中显式建模、不靠 `frontmatterExtra` 泄漏）。
   - 默认 `true` 的产品语义："多文档评审默认应同步刷新"是本 RFC 的核心直觉；要求 agent 作者**显式 opt-out**（写 `syncOutputsOnIterate: false`）才能保留 RFC-005 现行的"单 port 局部合并"行为。
   - 兼容性：DB 已有的 agent 行（迁移前）在 schema migrator 中读取时默认填 `true`；YAML 导入未指定字段同样 `true`；前端 Add/Edit Agent 表单 UI 上以 toggle 显式呈现，**label 文案为「文档迭代期间是否同步刷新本代理生成的其他文档」**，helper 文案点明"仅当 outputs 含 ≥ 2 个 markdown / markdown_file 时实际生效；关闭则在用户点'返回修改'时只重生被评审的那一份"。
   - schema_version：本 RFC **不 bump** workflow `$schema_version`（workflow 层零变化）；agent 表新增列由 drizzle migration 单独承载（见 design.md §1）。

### 2.2 不做

- **不做** reject 路径的 prompt 增强——reject 已经"全 port 重生 + sibling 重审"，不需要 sibling_outputs token 增援；保持 reject 表面一致，避免横向语义漂移。
- **不做** 让用户在评审决策面选"我只想改这一份、不带兄弟"——选择权下沉到 **agent 配置层**（`syncOutputsOnIterate`），不在决策面再加一个 per-decision toggle；同一 agent 同一工作流内"忽偶尔同步、忽偶尔不同步"不符合产品直觉。
- **不做** 自动判别"哪些 sibling 真的需要同步" / 嵌入 diff 摘要——交给 agent 用 prompt 上下文判断，框架只负责把全文给到，不做语义裁剪。
- **不做** `kind=string` 输出进入 sibling 同步集合——它们走机器路由（下游节点端口），不是人评审的文档面。
- **不做** schema bump——`doc_versions` / `node_runs` 列复用现有；RFC-005 仍是 `$schema_version: 2`。
- **不做** YAML 导入兼容性桥——iterate 行为在 workflow definition 层零字段变化（agent.md 的 `outputs[i].kind` 已存在）；老 YAML 直接享受新行为，无需 migrator。

## 3. 用户故事

**S1（多文档 happy path：iterate 拉动同步重生）**
用户拼工作流：`input(requirement) → designer(agent-single, outputs: [{name:'proposal', kind:'markdown'}, {name:'design', kind:'markdown'}, {name:'plan', kind:'markdown'}]) → reviewProposal(review, source=proposal) / reviewDesign(review, source=design) / reviewPlan(review, source=plan)`。
跑完一轮 → 三个 review 都 awaiting_review v1。用户先 approve proposal、approve plan，**对 design 用 iterate 决策**（写：在"## 接口设计"段评论"`POST /api/orders/cancel` 缺 idempotency_key"）→ daemon：
- 把这条 comment 渲染到 `{{__review_comments__}}`、target_port='design' 渲染到 `{{__iterate_target_port__}}`。
- 新行为：从 designer.outputs 取出 `kind=markdown` 的兄弟 port `proposal` / `plan`，读它们当前 doc_version body，拼成 `{{__sibling_outputs__}}` 注入。
- designer 重跑产出 proposal' / design' / plan' → 三份各自落 doc_versions v2、共享 `reviewIteration=1`。
- reviewProposal / reviewPlan 即便 v1 已 approved，仍被 cascade 回到 awaiting_review v2；UI 弹 toast "2 条已通过的兄弟评审被同步重审：design.md 的修订带动了 proposal.md / plan.md 的新版本"。
- reviewDesign 自动回到 awaiting_review v2。
用户复审三份 v2，分别 approve → 三个 review 全 done → task 收尾。

**S2（单 markdown 节点：行为不变）**
工作流：`input → designer(outputs: [{name:'design', kind:'markdown'}]) → reviewDesign`。
designer 只有一个 markdown 输出。iterate 路径完全跑 RFC-005 现行老逻辑：仅 design.md 落 doc_versions v2、`{{__sibling_outputs__}}` 空串、无 sibling cascade（也没有 sibling 可 cascade）。

**S3（混合 kind：machine port 不进同步集合）**
工作流：`designer(outputs: [{name:'design', kind:'markdown'}, {name:'metadata', kind:'string'}, {name:'plan', kind:'markdown'}]) → reviewDesign(source=design) / reviewPlan(source=plan)`。`metadata` 是给下游 dataLoader 节点的机器 JSON 串，不是文档。用户对 design iterate → `{{__sibling_outputs__}}` 只渲染 `plan`（kind=markdown），不含 metadata；doc_versions 也只对 design + plan 落 v2，metadata 没有 doc_version（它本来就不走文档面），reviewPlan cascade 回 awaiting_review。

**S4（兄弟评审历史可追溯）**
S1 之后用户回看 reviewProposal 详情，发现它有 v1 (approved) / v2 (approved)；点 v1（RFC-013 历史版本浏览）能看到 v1 是首次通过、v2 标注 "因 reviewDesign 的 iterate 决策同步重生" —— 不是因为有人对 reviewProposal 直接发起评审。本 RFC 提供 `doc_versions.cascadeSourceReviewId` 这个语义信息（不新增列，复用现有 source 字段在 design.md §5.2 中定义存放策略）让 UI 标注得出。

**S5（embedded loop 内部的 iterate）**
工作流嵌在 `wrapper-loop[ designer → review ]` 里，iterate 触发 loop 当次 iteration 内 sibling 重生，loop 控制流不变。与 RFC-005 S6 描述兼容；本 RFC 不引入 loop 专属规则。

## 4. 验收标准

### 功能

- **A1（多文档 iterate 全 port 重生）**：designer 三 markdown 输出 + 三 review；对 portA iterate → 重跑后 doc_versions 表中 portA / portB / portC 各有新 v(n+1) 行；三者 `reviewIteration` 相等。
- **A2（sibling review cascade）**：A1 场景下 portB / portC 上的 review 节点即便此前 status=`done(approved)` 也被回退为 `awaiting_review`，`reviewIteration` 各自 +1，对应 WS 事件 `review.created` 发出。
- **A3（prompt 注入 `__sibling_outputs__`）**：A1 场景下上游 agent 收到的 user prompt 末尾出现 `## Sibling Outputs` 段（模板未引用 token 时）或 token 被替换为非空字符串（引用时）；段内含 portB / portC 全文 + 英文一致性指令前缀。
- **A4（单 port 节点行为兜底不变）**：designer 只声明 1 个 markdown 输出 → iterate 路径 doc_versions 只落 target port v(n+1)；`{{__sibling_outputs__}}` 替换为空串；不发 sibling cascade WS 事件。
- **A5（kind=string 不进 sibling 集合）**：designer outputs 含 1 个 markdown + 1 个 string；iterate target 是 markdown → `{{__sibling_outputs__}}` 空串、doc_versions 仅落 target port v(n+1)、无 cascade。
- **A6（reject 路径零回归）**：reject 决策在 ≥ 2 markdown 输出节点上仍按 RFC-005 原行为执行（全 port 重生 + sibling cascade + 文件回滚 + `__review_rejection__` 注入），**不**注入 `__sibling_outputs__`。
- **A7（reviewIteration 共享）**：A1 场景下 portA' / portB' / portC' 的 doc_versions 行 `reviewIteration` 三者严格相等。
- **A8（agent 开关默认值与 opt-out）**：
  - A8a：新建 agent 不写 `syncOutputsOnIterate` 字段 → POST /api/agents 返回的 agent 实体含 `syncOutputsOnIterate: true`；frontend 表单 toggle 显示打开。
  - A8b：DB 中现有 agent 行（migration 前的旧数据）migrator 后读 GET /api/agents/:name → `syncOutputsOnIterate: true`。
  - A8c：agent 显式设 `syncOutputsOnIterate: false` + 3 markdown 输出 → iterate 决策走 RFC-005 老语义（仅 target port v(n+1)、不注入 sibling_outputs、不 cascade），等价于 A4 单 port 行为。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** 不退化既有测试集——尤其 RFC-005 的 `review-state-machine` / `review-prompt-injection` / `reviews-iterate-mints-new-run` 套件；其中 `review-iterate-partial-merge.test.ts`（RFC-005 C2 回归防护）需要按新合并语义改写，**并在文件顶部注释说明"RFC-014 反转了 iterate 的合并策略；本测试现在锁'多 markdown 全 port 重生'，不再锁'单 port 部分合并'"**，commit hash 链回本 RFC。
- **B3** backend tests 至少 +15（多 port 上游识别 3 + sibling cascade on iterate 3 + sibling_outputs prompt 渲染 3 + reviewIteration 一致性 1 + kind=string 排除 1 + 单 port 兜底 1 + **agent 开关默认 true + opt-out 路径 + migrator 兜底 3**）。
- **B4** frontend tests 至少 +8（NodeInspector preview 含 sibling_outputs 渲染 2 + toast/banner 提示已被 cascade 的兄弟数 2 + reviews.detail 历史标记"因兄弟 iterate 同步重生" 2 + **Add/Edit Agent 表单 toggle 默认开 / 提交 false 时正确序列化 2**）。
- **B5** Playwright e2e：扩 `e2e/review.spec.ts` 新增一段三 markdown 输出 + 对中间 port iterate → 验三个 review 全 awaiting_review v2 的全链路；fixture 用 stub-opencode 多 envelope 应答。
- **B6** 单二进制构建包体积 / 启动时间不退化（纯逻辑改动 + 一个 builtin token，新 deps = 0）。

### 回归防护

- **C1** `tests/review-iterate-sibling-cascade.test.ts` 顶部注释链回本 RFC：「locks RFC-014 §2.1 #1 + #3 — 多 markdown 上游 iterate 必须 (a) 让所有 markdown[_file] sibling port 各自落新 doc_version v(n+1)、reviewIteration 相等；(b) 把所有 sibling review 拉回 awaiting_review（包括 already approved）。红了说明合并策略或 cascade 函数被改回单 port 局部更新，违反产品语义」。
- **C2** `tests/review-sibling-outputs-prompt.test.ts` 顶部注释链回 §2.1 #2：「locks `__sibling_outputs__` token 命名 + 英文一致性指令前缀字面量；token 名是用户期望的 stable contract，重命名会破坏老 workflow 的 prompt 模板」。
- **C3** 源代码层兜底断言：`grep -q "{{__sibling_outputs__}}" packages/shared/src/prompt.ts` 在测试中以 fs 读 + 正则保留——参照 RFC-005 C4 与 RFC-006 `canvas-port-label-not-floating.test.ts` 的源代码层兜底模式。
- **C4** `tests/review-iterate-single-port-baseline.test.ts`：明确锁定"单 markdown 输出节点的 iterate 完全不触发新逻辑"——doc_versions 不会无故膨胀、cascade 不会无故触发、`__sibling_outputs__` 必须是空串。防止后续优化把"≥ 2 markdown"这个守卫拆掉。
- **C5** `tests/agent-sync-outputs-opt-out.test.ts`：锁定"agent `syncOutputsOnIterate: false` + 多 markdown 输出 → 完全退化到 RFC-005 老语义"。顶部注释说明：「红了说明 opt-out 通路被错误绕过；用户的 agent 配置选择必须严格生效，不允许框架在'我觉得应该同步'的判断下覆盖」。
