# RFC-023 Proposal — 反问澄清节点（Clarify）：Agent 主动反问用户、人填表回答、回答动态注入

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

v1 + RFC-005（review）打通的是 "agent 出 → 人审 → agent 改" 这条**事后审批**链路：人在 agent 输出落地后给意见、按"通过/返回/重生"决策。它处理不了的是**事前澄清**——agent 在还没动手前发现自己缺关键信息（业务约束没说清、目标用户群没定、技术栈偏好不明），需要先把不确定性收敛、再开始正经输出。

真实场景里这是高频需求：

- 用户起一个工作流写 PRD/技术设计，agent 拿到的输入只有"做个内部工具帮 PM 跟踪需求"——缺目标用户规模、数据敏感度、已有系统集成边界、首要交付时间窗等关键变量。
- 用户跑 code-generator agent 让它实现某 service，提示词里只说"加缓存"——缺缓存类型偏好（Redis vs in-memory）、TTL 策略、key 命名规范、是否需要 stampede 防御等。
- 用户拿一个 fix-bug agent 修一段代码，提示词描述了症状但没说允许的破坏性（API 兼容性约束？数据迁移可不可以？）。

这些场景今天**只能**让用户在 prompt 里写得无比详尽、或者跑完发现方向错了再走 review reject 重跑（贵且慢）。

更深一层痛点：用户希望让 agent **结构化地**反问——"这有 5 个我需要你拍板的点，按推荐度排序、单选/多选各自带候选项"——而不是开放式问答。结构化能让用户秒答（点选 + 偶尔补一句），不必反复让 agent 转述需求。

## 1.1 为什么要现在做

- RFC-005 review 节点把"task 暂停 → 等人 → 注入回 agent → 重跑"的状态机 + UI 范式落地了；同样基建反问只是加一种暂停形态，复用 60% 以上代码量（`awaiting_human` 状态、prompt 注入、WS 同步、节点回滚）。
- 用户已经准备把 Agent Workflow 用到设计评审 / 代码生成 / bug 修复三条线，每条线落到样例工作流都遇到"agent 一上来就跑偏"问题；目前的解决方案——用户先在 prompt 里手写每个潜在不确定项——既耗时又容易漏。
- 未来在 wrapper-loop 里嵌 `agent → clarify` 实现"最多 N 轮反问"是高确定性收益的能力，本 RFC 把基础原语铺好。

## 1.2 本 RFC 不动哪些地方

- **不动** review 节点的全部已有运行时（doc_versions / review_comments / reject·iterate·approve 三出口 / sibling cascade / markdown_file resolve / DiffView）。clarify 与 review 在 DB / 协议 / UI 上**完全并列**两套，互不依赖。
- **不动**现有 6 类节点（agent-single / agent-multi / input / output / wrapper-git / wrapper-loop）的语义；review 已是第 7 类，clarify 是新增的**第 8 类**叶子节点。
- **不动**现有 `<workflow-output><port name="">…</port></workflow-output>` envelope 解析（K1）；clarify 引入**并列**的 `<workflow-clarify>` envelope，两者在同一回复中**互斥**（agent 二选一）。
- **不动**现有 protocol block（`renderUserPrompt` 末尾追加的 `<workflow-output>` 说明）；对带反问能力的 agent 在 protocol block 末尾**追加一段**反问说明（"二选一"规则 + JSON schema），不改原有指令。
- **不动** retry / pre_snapshot / `retry_index`：clarify 重跑 agent 走**新字段** `clarify_iteration`（与 review 的 `review_iteration` 同等级别），技术失败 retry 仍走 `retry_index`。
- **不动** worktree GC / events archive / task lifecycle：clarify_session 记录绑 task，task 删时级联清。
- **不动** YAML 导入导出契约层格式约定；只在 schema v2→v3 bump 时加 clarify 节点定义；老 workflow 上提不带 clarify 节点零风险。

## 2. 目标

### 2.1 做

1. **新 NodeKind `clarify`**：叶子节点，**只**有 1 个 input 端口（`questions`）+ 1 个 output 端口（`answers`），canvas 上不允许用户增减端口（区别于 agent / review）。Palette 在已有 "Human" 分类下与 review 并列。

2. **反问出口反向拖动建立**：用户从 clarify 节点 input handle（左侧 target）反向拖到任意 **agent-single 或 agent-multi** 节点 → 框架在该 agent 上**动态注册系统级出端口** `__clarify__`（不进入 agent.outputs，不写 DB，纯 workflow.definition 内表达）。RFC-007 已经在 review/output 节点支持反向拖动，本 RFC 把同一机制扩到 clarify，行为完全对齐（鼠标手势、连线动画、对端 handle 高亮均与 RFC-007 一致）。agent-multi（fan-out）上挂 clarify 时，runtime 在每个 shard 子 node_run 上独立判断 envelope kind、每个反问 shard 单独建一条 clarify_session，UI 在同一 clarify 节点下分组列出 N 个 awaiting_human 实例（按 shard_key 字典序）。

3. **配套反问回环（自动建第二条边）**：反向拖完成后框架**同时**自动建第二条 edge `clarify.answers → agent.__clarify_response__`（同一 agent 的系统级 target 端口），让画布上"反问环"自然可见。该 edge 不写 DB（运行期通过 clarify_session 关联），但出现在 `definition.edges[]` 中以保持 canvas 单一真值源。用户可以手动删除 answers→agent 这条边（少数派场景，例如把 answers 接到下游别的节点做后处理），框架在执行期仍按 clarify_session 把回答注入回上游 agent。

4. **agent protocol block 扩展**：runner 在拼 user prompt 时，如果当前 agent 节点在 workflow.definition 里有出边走 `__clarify__` 系统端口，则在原本的 `<workflow-output>` 协议块**之后**追加一段 `<workflow-clarify>` 协议（详见 §3 design.md）。两段协议在同一 prompt 里同时存在，agent 自行选择回复哪一个 envelope。

5. **`<workflow-clarify>` envelope（JSON body）**：agent 反问时输出的 envelope 形态：
   ```xml
   <workflow-clarify>
   {
     "questions": [
       {
         "id": "q1",
         "title": "你想用哪个数据库？",
         "kind": "single",
         "recommended": true,
         "options": ["PostgreSQL", "MySQL", "SQLite"]
       },
       {
         "id": "q2",
         "title": "需要支持哪些客户端语言？",
         "kind": "multi",
         "recommended": false,
         "options": ["Python", "TypeScript", "Go", "Rust"]
       }
     ]
   }
   </workflow-clarify>
   ```
   选 JSON 而不是 XML：嵌套结构（多题 × 多选项 + 推荐 + 单/多选 kind）扁平 XML 表达冗长易错；JSON 解析后是直接可用的对象、前端渲染零额外胶水代码。`<workflow-clarify>` 外壳保留 XML 是为了沿用现有 envelope tail-wins 解析逻辑（`extractLastEnvelope` 已稳定）。

6. **互斥校验**：agent 一回复里**要么** `<workflow-output>` **要么** `<workflow-clarify>`，**绝不允许并存**。runner 的 envelope 解析器在同回复里检出两种 envelope → fail 该 node_run（`code: clarify-and-output-both-present`），落 retry path（同 agent retries 配置）。protocol block 文本里用粗体加多次强调，业务上以"agent 选择反问 = 主动放弃本轮输出"这条单义规则实现。

7. **反问问题约束（schema 校验）**：
   - 至多 **5** 个 question，按 array 顺序即推荐优先级（agent 自行排序，前列优先）。
   - 每个 question：
     - `id`：稳定字符串（agent 自己起，跨轮可重复）。
     - `title`：题面，纯文本。
     - `kind`：`single` | `multi`，二选一。
     - `recommended`：bool，true 时前端**渲染 "(推荐)" 标记**，agent 用它强调"这一问比其它更需要回答"。
     - `options`：候选项数组。**至少 2，至多 4**。框架在 UI 上自动追加第 5 行人工输入框（与候选项**互斥** for single、**并存** for multi）—— agent 自己**不要**也**不应该**塞 "其它/自定义" 候选项。
   - 解析器对超出约束的输入：**部分宽容**——超 5 题取前 5、options 超 4 取前 4 + 给 node_run_events 加 warning；options 少于 2 / kind 不合法 / title 空 → fail 该回合（同 6）。

8. **`awaiting_human` 状态（与 review `awaiting_review` 并列）**：
   - `tasks.status` 加 `'awaiting_human'`。
   - `node_runs.status` 加 `'awaiting_human'`。
   - 与 review 一样：处于 awaiting_human 的 task 不占并发名额（idle）。task 顶层只要任一 node 处于 awaiting_human **或** awaiting_review，就显示对应状态；同时存在时优先显示 `awaiting_human`（更主动语义；UI 标签可同时显示两类待办数）。

9. **`clarify_sessions` 表**（new）+ clarify 节点的 node_run 复用既有表：每次 agent 输出 `<workflow-clarify>` envelope 都建一个 clarify_session，挂 task / 上游 agent node_run / clarify 节点的 node_run，落 questions JSON、answers JSON（NULL 直到提交）、iteration 索引。详见 design.md §3。

10. **clarify_iteration 字段**（node_runs 新列）：与 review_iteration、retry_index 三者**正交**——技术 retry 走 retry_index、review 反审走 review_iteration、agent 反问走 clarify_iteration。每次同一 agent 节点的"上一轮反问 → 用户答完 → 触发该 agent 重跑"产生一条新 node_run，`clarify_iteration = 上一轮 + 1`。retry_index 在新 clarify_iteration 下重置为 0。v1 不设 clarify_iteration 上限（约束未来交给 wrapper-loop 节点的 `max_iterations`；裸 clarify 节点单独使用时用户自负其责）。

11. **答案注入 → 触发 agent 重跑**：用户提交答案 → clarify_session.answers_json 落库 → clarify 节点 node_run 标 done → 框架按 clarify_session 上记的"发起反问的上游 agent node_run"找到该 agent 节点，**回滚到 pre_snapshot**（沿用 review reject 路径已有的 `rollbackBeforeRetry` 助手）→ 新建 agent node_run（clarify_iteration+1）→ 把 questions + answers + framework 补充内容塞进 `ClarifyPromptContext`（与 ReviewPromptContext 并列）→ 走 `renderUserPrompt`（新增 4 个 builtin token，见 §2.1.13）→ agent 重跑。

12. **回答数据载荷（注入给 agent 的内容）**：
    - 原始问题：每个 question 完整体（id / title / kind / recommended / options）。
    - 用户回答：每个 question 的 `selected_option_ids` 数组（指向 options 索引）+ `selected_option_labels` 字符串数组（直接拿 option 字符串便于 agent 阅读）+ `custom_text` 字符串（人工输入框内容，未填时为空字符串）。
    - **框架补充**：每个 question 自动附"answer_synthesis"段——一行简短英文摘要总结用户实际表达（例如 single+互斥 custom 时是 `User chose to bypass all candidates and provided custom answer: "<text>"`；multi+所有候选选中时是 `User confirmed all 4 candidates apply: "...", "..."`）。这段由 backend `summariseClarifyAnswer()` 纯函数生成，**确定性 / 不调 LLM**，避免每次反问额外费用 + 让 agent 在 prompt 里看到一致的"语义层摘要"。
    - 这三段合起来在下一轮 prompt 里以 markdown 形态注入（`renderClarifyAnswersBlock`），并附**协议提醒**："用户已对你的上一轮反问做出选择，本轮请直接产出 `<workflow-output>` 或继续 `<workflow-clarify>`（如仍有阻塞）；二者择一。"

13. **Prompt 模板新增 4 个 builtin token**（与 review 5 token 同地位）：
    - `{{__clarify_questions__}}` — 渲染所有 question 题面 + kind + options 的 markdown 块（agent 用它对照"自己当时问了什么"）。
    - `{{__clarify_answers__}}` — 渲染所有 question 的用户选择 + custom_text + 框架摘要的 markdown 块。
    - `{{__clarify_iteration__}}` — 当前 clarify_iteration（0 = 首次跑还没反问过 / 1 = 已反问过 1 次此轮是答完后第一次重跑 / 2 = ...）。
    - `{{__clarify_remaining__}}` — 当 agent 节点在 wrapper-loop 内时是 `max_iterations - clarify_iteration`；不在 loop 内时是空字符串。Agent 据此判断"是否还有反问机会"。

   未引用时框架自动追加 `## Clarify Q&A` 章节（与 review context auto-append 同套机制）。

14. **clarify 节点 UI（人工反馈页）**：
    - **路由**：`/clarify/:nodeRunId`（与 `/reviews/:nodeRunId` 并列），左栏 Reviews tab 之外新增 **Clarify tab**（segmented filter "待回答 / 已回答 / 全部"，默认"待回答"；未读 badge）。task 详情页同款 panel。
    - **顶部**：题目列表（按推荐度排序，推荐题在题面前加蓝色 chip "推荐"）；上下文卡片显示"由 agent `{agentName}` 发起 / 第 N 轮反问 / 触发节点：`{nodeId}`"。
    - **单选题**：4 个 radio（选项不足 4 时按实际个数）+ 第 5 个 radio "其他（自定义）"。选中第 5 个 → 下方 textarea 启用、其他 radio 自动取消选中（互斥）。
    - **多选题**：4 个 checkbox（不足 4 时按实际个数）+ 第 5 个独立 textarea（默认 disabled，旁边 checkbox "也包含以下补充" 勾上才启用；勾上后其余 checkbox 仍可勾，**不互斥**）。
    - **整页"全部提交"按钮**：所有 required 题答完才启用（required 默认 = 推荐题，非推荐题可跳过；跳过题 selected 为空数组、custom_text 为空）。提交后立刻不可改（与 review decision 同模式）。
    - **键盘**：Tab 在题间切，单题内 1-5 数字键直接选第 N 选项；Ctrl+Enter 提交（与 review hotkeys 风格对齐，复用 `useReviewHotkeys` 同一 hook 类型抽象）。

15. **多 tab WS 同步**：`/ws/workflows` 加 `clarify.created` / `clarify.answered` 两 event（不需要 question_added 因为 questions 一次性提交），让多 tab 实时看到对方答完或新一轮反问出现。

16. **schema bump v2 → v3 + 自动 migrator**：`$schema_version: 3`。v1（pre-RFC-005）与 v2（post-RFC-005）的 workflow 上提到 v3 都零风险（纯字段追加 / 不带 clarify 节点）。GET 路径透明上提；新写入永远落 v3。

17. **i18n + 错误码全集**：所有 clarify UI 文案 zh-CN + en-US；错误码加 `clarify-and-output-both-present` / `clarify-questions-malformed` / `clarify-questions-too-many` (warning) / `clarify-options-too-many` (warning) / `clarify-options-too-few` / `clarify-target-agent-missing` 等。

18. **Workflow validator 5 项静态校验扩展**（沿用 RFC-005 风格）：
    - `clarify-input-source-missing` — clarify 节点 `__clarify__` 入边对端必须是存在的 agent-single 节点。
    - `clarify-target-not-agent` — 入边对端节点 kind 必须是 `agent-single`（v1 不支持 agent-multi → clarify，原因见 §2.2）。
    - `clarify-loop-only-iteration-cap` — clarify 节点在 wrapper-loop 内是 OK 的；不在 wrapper-loop 内时给 warning：`clarify-no-iteration-cap`，提示"裸 clarify 节点单次使用可，但 agent 主动反问轮次无上限，建议套在 loop 内"。
    - `clarify-answers-port-disconnected` — clarify.answers 没出边时 warning（非阻塞，因为答案通过 clarify_session 隐式注入，但视觉提示用户"画布上没看到答案落点会困惑"）。
    - `clarify-self-reference-loop` — clarify.answers 不能连到 input handle 自身（防自环边）。

### 2.2 不做

- **不做**反问轮次 cap：v1 不在 clarify 节点本身设上限，靠 wrapper-loop 的 `max_iterations` 来约束。需求 #7 已明示"未来 agent 和反问会承载在一个 loop 节点内"，本 RFC 落基础原语、不抢 loop 范围内的事。裸用 clarify 节点时 validator 给 warning `clarify-no-iteration-cap` 引导用户套 loop。
- **不做**反问问题的**部分提交**：5 题要么一起提交、要么作为一组草稿（IndexedDB 持久化，关 tab 不丢），不允许"先答 3 题，后答 2 题"。简化状态机。
- **不做** clarify_session 历史 diff：clarify_session 是一次性事件，没有"上一版 questions"的概念（每轮反问就是新一组 questions + 新一组 answers）。task 详情画布上点 clarify 节点能看到所有历史 session 列表（按 iteration 序），但不做 diff。
- **不做**用户单独**追加自由问题**：用户在 UI 上**只能**回答 agent 提出的问题（含可选 custom_text）；不能"我顺便也问你一句"。如果用户想加约束，用 review iterate 写文档评论那条路径（已有）。
- **不做** clarify 节点的"跳过这次反问 = 让 agent 装作没问，强制走 output 端"按钮。这种语义会让 agent 协议被破坏（agent 自己选择反问 = 已经决定不输出），强制忽略只会让 agent 重跑后再反问、循环死锁。
- **不做** review reject/iterate 与 clarify 跨形态级联：clarify 重跑 agent 是 clarify 自己的事，不触发下游 review 实例作废；review reject/iterate 也不影响上游 clarify_session 历史（clarify_session 永远只读归档）。两套机制并列，**不**互相穿透。
- **不做** YAML 导入路径下的 clarify 节点向后兼容：schema v3 要求严格匹配，v2 YAML 含 clarify 节点拒导（v2 本来就没这个节点）。
- **不做** clarify 节点在 wrapper-git 内的特殊语义：把它放进 git wrapper 是允许的，但 clarify 节点本身不写文件、git_diff 影响为零，框架不做特别提示。

## 3. 用户故事

**S1（happy path：一轮反问后 approve）**
用户工作流：`input(requirement) → designer(agent-single) → reviewDesign(review)`。在 designer 节点上从一个新拖来的 clarify 节点的 input handle 反向拖向 designer → 框架自动建 `designer.__clarify__ → clarify.questions` + `clarify.answers → designer.__clarify_response__` 两条边。Launch task → designer 第一轮跑（clarify_iteration=0）→ envelope 是 `<workflow-clarify>`：
```json
{
  "questions": [
    { "id": "scope", "title": "目标用户是 B2B 还是 B2C？", "kind": "single", "recommended": true, "options": ["纯 B2B", "纯 B2C", "B2B + B2C 混合"] },
    { "id": "scale", "title": "预期同时在线用户量是多少？", "kind": "single", "recommended": true, "options": ["<100", "100~1000", "1000~10000", ">10000"] },
    { "id": "lang", "title": "客户端 SDK 需要支持哪些语言？", "kind": "multi", "recommended": false, "options": ["Python", "TypeScript", "Go", "Java"] }
  ]
}
```
clarify 节点状态 → awaiting_human，task 顶层 → awaiting_human。左栏 Clarify tab 出现待回答项。用户进 `/clarify/{nodeRunId}` 页：3 题渲染，前 2 题前面有蓝色"推荐"chip。用户选 q1 第 1 项（纯 B2B）、q2 第 3 项（1000~10000）、q3 勾 Python + TypeScript + 勾上"补充"checkbox 在 textarea 里写"还想兼容现有的 Java SDK，但优先级低"。点提交。
clarify 节点 done、designer 回滚 pre_snapshot、clarify_iteration=1 的 designer node_run pending → running，prompt 里 `## Clarify Q&A` 自动注入（包含 questions + answers + framework synthesis "用户优先 B2B，规模 1000~10000，客户端 SDK 主选 Python + TypeScript，备选 Java"）。designer 第二轮跑，这次 envelope 是 `<workflow-output>`：完整 design.md，reviewDesign 进 awaiting_review → 用户 approve → task done。

**S2（连续两轮反问）**
同 S1，但 designer 第二轮还是觉得不够清楚，再吐 `<workflow-clarify>` 2 题（譬如缓存策略 + 事务边界）。clarify 节点 status 重回 awaiting_human、第 2 个 clarify_session 落库（iteration=1）。task 详情画布上 clarify 节点 hover 显示"2 轮反问 / 最近一轮 2 题待回答"。用户进答 → designer 第三轮跑（clarify_iteration=2）→ 这次出 `<workflow-output>` → 进 review → approve → done。

**S3（wrapper-loop 内的 clarify，max 5 轮）**
工作流：`input → wrapper-loop[ designer → clarify ](max_iterations=5, exit_condition=port-empty on designer.__clarify__)`。每次 designer 跑出 `<workflow-clarify>` → clarify awaiting_human → 用户答 → designer 重跑 →（若仍反问）下一轮 → 直到某轮 designer 出 `<workflow-output>` 而非 `<workflow-clarify>`，exit_condition `port-empty on __clarify__` 命中（该 port 这一轮没产数据）→ loop 退出，下游继续。若到第 5 轮还在反问 → loop status=exhausted、task=failed。Agent prompt 看到 `{{__clarify_remaining__}}` = 5 / 4 / 3 / 2 / 1 / 0，可自行调整反问强度。

**S4（agent 既反问又输出 → reject）**
不规矩的 agent 在一回复里同时打了 `<workflow-clarify>` 和 `<workflow-output>` 两段。runner envelope 解析器命中两段 → 该 node_run failed + errorMessage `clarify-and-output-both-present: agent must choose exactly one`。retries 配 > 0 时新建 retry_index+1 的 node_run 重跑；retries=0 则 task=failed，UI 顶部错误条 + "跳到失败节点"。

**S5（agent 给的问题超 5 题）**
agent 不守规给了 7 题。runner 取前 5 题入 clarify_session、丢后 2 题 + 在 node_run_events 加 `warning: clarify-questions-too-many (got 7, truncated to 5)`。UI 在 clarify 页顶部 hint bar 显示该 warning。用户答前 5 题正常推进；agent 下轮 prompt 收到 framework 摘要 "你上轮提了 7 题但本框架仅允许 5 题，已截到前 5 题处理"，让 agent 调整下轮策略。

**S6（用户全跳过非推荐题，仅答推荐题）**
3 题中 2 题推荐 / 1 题非推荐。用户只答了 2 题推荐的、第 3 题 radio 全没选。提交后非推荐题的 answers 落 `selected: []`、custom_text 空字符串。framework synthesis 段写 "User did not answer this question." agent 下轮 prompt 知道这点，可继续基于已有信息推进、或再次反问该题。

**S7（custom 互斥单选）**
q2 单选 4 候选，用户全不满意 → 选第 5 个 "其他（自定义）" → 上方 4 个 radio 自动取消选中、textarea 启用，用户输入"实际我们要用 Redis Cluster + Lettuce client"。提交后 answers 落 `selected: []`、custom_text = 上述字符串、framework synthesis = "User chose custom answer: 'Redis Cluster + Lettuce client'"。

**S8（多 tab 同步）**
开两个 tab 都看 `/clarify/{nodeRunId}`。tab A 用户答完点提交 → tab B 立刻 WS 收到 `clarify.answered` event → 页面切到只读 + 顶部 toast "另一处已提交答案"。tab A 同时跳到 designer 节点详情看 clarify_iteration=1 的 node_run 状态。

**S9（裸 clarify 节点 + validator warning）**
用户拼工作流时把 clarify 节点直接放在编辑器里、没套在 loop 内。validator 给 `warning: clarify-no-iteration-cap`，编辑器 ValidationPanel 显示黄色提示"裸 clarify 节点不限制反问轮次，建议套在 wrapper-loop 内以加 max_iterations 上限"。用户可选择忽略或加 loop。

**S10（agent 反问问题不合规 → 重试）**
agent 给的 `<workflow-clarify>` JSON 里某题 `options` 只有 1 个 → 解析器 fail + errorMessage `clarify-options-too-few: question "q1" has 1 option, minimum is 2`。retries 配 > 0 时新建 retry，prompt 末尾 framework 自动追加纠错段 "Your previous reply had a malformed clarify envelope: ...; please re-issue valid `<workflow-clarify>` or proceed to `<workflow-output>`."

**S11（agent-multi fan-out 各 shard 反问）**
工作流：`input → git-wrapper[ worker(agent-single) → auditor(agent-multi, sourcePort='git_diff') → clarifyAudit(clarify) ]`。auditor 按 per-file 分片产 3 个 shard，每个 shard 跑出自己的 envelope。shard A 出 `<workflow-output>` 正常完成；shard B、shard C 出 `<workflow-clarify>` 各 2 题——runtime 给 shard B / shard C 各建一条 clarify_session，shard A 直接进入下游聚合等待。clarify 节点 status=awaiting_human、task 顶层 awaiting_human，左栏 Clarify tab 列 2 个 awaiting 项（按 shard_key = 文件路径排序）。用户进 detail 页时看到顶部"分组：clarify 节点 clarifyAudit · 2 个待回答 shard"切换器（shard B / shard C），逐个答完。每个 shard 答完后**只重跑该 shard**（auditor 的对应 shard 子 node_run 回滚 pre_snapshot、新 shard node_run clarify_iteration=1），不影响 shard A。所有 shard 跑完 → 父 multi-process 节点聚合 outputs（按 shard_key 字典序拼接）→ 下游继续。

## 4. 验收标准

### 功能

- **A1（S1 happy path e2e）**：input + designer + clarify + reviewDesign 四节点工作流，从 launcher 启动 → 看到 awaiting_human → 进 /clarify 页答 3 题 → designer 重跑 → 拿到 markdown → review approve → task done，全程 e2e 通过。
- **A2（answer injection）**：clarify_session 提交后下一轮 designer 的 prompt 文本含完整 `## Clarify Q&A` 段（questions + selected_labels + custom_text + framework synthesis），断言级覆盖单选/多选/custom 三种 case。
- **A3（agent-multi → clarify fan-out 反问）**：auditor agent-multi 节点 + per-file 分片 3 个 shard，shard B/C 出 clarify envelope → 2 个 clarify_session 落库 + clarify 节点 awaiting_human + 仅这两个 shard 子 node_run 进 awaiting；shard A 不受影响。逐 shard 答完后仅对应 shard 子 node_run 重跑（clarify_iteration+1），父 multi 节点等所有 shard 完成后再聚合。
- **A4（互斥 envelope）**：runner envelope 解析器同时命中 `<workflow-output>` + `<workflow-clarify>` → node_run failed + `clarify-and-output-both-present`；retries 配 > 0 → 新 retry。
- **A5（问题数 / 选项数宽容截断）**：agent 给 7 题 / 单题 5 option → 截到 5 题 / 4 option + node_run_events 加 warning + UI 顶部 hint。
- **A6（schema 校验：options < 2）**：agent 给 options=1 → node_run failed + `clarify-options-too-few`。
- **A7（loop in clarify）**：wrapper-loop 内 designer→clarify 跑 3 轮反问后 designer 出 `<workflow-output>` → loop exit_condition `port-empty on __clarify__` 命中 → loop done。
- **A8（loop 反问轮数上限）**：max_iterations=5 但 agent 跑到第 6 轮仍 `<workflow-clarify>` → loop status=exhausted、task=failed。
- **A9（反问 UI：单选互斥 + 多选不互斥）**：单选第 5 行 textarea 启用时上方 radio 强制清空；多选第 5 行 textarea 启用与上方 checkbox 独立。
- **A10（推荐 chip）**：question.recommended=true 在 UI 上正确渲染 "(推荐)"；keyboard 数字键 1-5 选第 N 选项。
- **A11（draft IndexedDB）**：填了 3 题中的 2 题 → 关 tab → 重开 → 草稿恢复 + 提交按钮仍 disabled（required 题未答完）。
- **A12（WS clarify.* event）**：两 tab 一处提交后另一处实时切到只读状态 + 顶部 toast。
- **A13（answers→agent reverse edge）**：从 clarify input 拖到 agent 后画布上有两条边 + agent 节点上动态出现 `__clarify__` / `__clarify_response__` 系统端口；用户手动删 answers→agent 边后再启动 task 不影响 clarify 注入路径（注入走 clarify_session 隐式关联）。
- **A14（schema v2 → v3 上提）**：DB 里有 v2 workflow（无 clarify 节点）+ 新启 daemon，GET 返 `$schema_version: 3` + 字段无丢失。
- **A15（clarify_iteration 与 review_iteration 正交）**：同一节点同时被 review 反审 + clarify 反问（理论场景虽少）时两个 iteration 字段独立递增。
- **A16（task 顶层状态优先级）**：task 同时有 awaiting_review + awaiting_human 节点 → 顶层显示 awaiting_human，但状态 chip 同时显示两个数字 badge。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-005（review）、RFC-014（sibling cascade）、RFC-007（review/output drag）的既有测试**零退化**——本 RFC 仅增加新文件 / 新函数 / 新分支，不改既有 review 流程；尤其 `services/review.ts` 的 reject/iterate 路径在本 RFC PR 里 diff = 0。
- **B3** backend tests **≥ +32**：
  - shared schemas 5（clarify node + clarify_session + workflow $schema v3 migrate + protocol envelope clarify + answers JSON shape）
  - envelope 解析 6（happy + 互斥拒绝 + 超 5 题截断 + 超 4 选项截断 + options 不足 + JSON 形态错误）
  - clarify service 8（createClarifySession + commitAnswers + 触发 agent re-run + framework synthesis 3 形态 + 不影响 review 状态）
  - scheduler 7（awaiting_human dispatch + clarify_iteration 递增 + 不重置 retry_index 边界 + agent-single happy path + agent-multi fan-out 部分 shard 反问 + 答完单 shard 仅触发该 shard 重跑 + 全部 shard 都反问后逐个答完）
  - REST + WS 6（GET list + GET detail + POST answers + 多 shard 列表分组 + clarify.created broadcast + clarify.answered broadcast）
- **B4** frontend tests **≥ +26**：
  - `/clarify` 路由 6（list filter + 进入 detail + 推荐 chip 顺序 + 多 tab WS 同步 + 草稿恢复 + agent-multi 多 shard 分组切换器）
  - ClarifyForm 组件 8（单选互斥 + 多选不互斥 + 数字键 1-5 + 必答题判定 + custom textarea 启用 / disabled / draft / submit disabled state）
  - canvas drag 5（反向拖动建两条边 agent-single + 反向拖动建两条边 agent-multi + 删 answers 边后注入仍正常的源码层断言 + 同一 agent 二次拖入拒绝 + clarify 端口固定 1 进 1 出）
  - shared utils 7（buildClarifyPromptBlock / summariseClarifyAnswer single+custom / multi+custom / multi+pure / 跳过题 / 推荐题排序 / answer schema 解析）
- **B5** Playwright e2e 增 1 个新文件 `e2e/clarify.spec.ts`（fixture stub-opencode 第一轮输出 clarify envelope、第二轮输出 output envelope），覆盖 A1。
- **B6** 单二进制构建包体积 / 启动时间不退化（纯新增前后端代码 + 1 个 DB 列 + 1 个表，估算 < 30KB 体积增量）。
- **B7** RFC-021（task-detail-tabs）和 RFC-022（agent dependsOn）若先于本 RFC 落地，则在本 RFC PR rebase 主干后跑一遍它们的 spec 也全绿（cross-RFC 兼容性回归）。

### 回归防护

- **C1** `tests/clarify-envelope-exclusive.test.ts` 顶部注释：锁定"agent 同回复不允许同时存在 `<workflow-output>` + `<workflow-clarify>`"硬约束；红了立刻去检查 envelope 解析器。
- **C2** `tests/clarify-prompt-injection.test.ts`：源代码层兜底 grep `{{__clarify_questions__}}` + `{{__clarify_answers__}}` + `{{__clarify_iteration__}}` + `{{__clarify_remaining__}}` 在 `packages/shared/src/prompt.ts`，防 token rename 静默破坏。
- **C3** `tests/clarify-options-cap.test.ts`：锁定 4 option / 5 question 硬上限——若有人后续放宽（譬如改成 10 题）必须主动改这条测试，迫使讨论而不是悄悄漂移。
- **C4** `tests/clarify-no-cross-review-interference.test.ts`：构造一个同 task 同 agent 同时被 clarify 反问 + review 反审的场景，断言 clarify 答完只触发 clarify_iteration+1、不动 review 状态；review iterate 也不动 clarify_session 状态。
- **C5** `tests/clarify-target-validator.test.ts`：锁 validator 接受 agent-single / agent-multi 作为 clarify 上游，拒 wrapper / review / output / input / clarify 自身；防止哪天某次 refactor 不小心又把 agent-multi 排除掉。
- **C6** `tests/clarify-reverse-drag-two-edges.test.ts`：源代码层 + DOM 断言反向拖动同时建两条 edge（`canvas.handleConnect` 分支必须显式覆盖 clarify 节点 + RFC-007 review/output drag 的 helper 复用同一签名）。

## 5. 关键技术选型理由（"我作为专业 agent 的补充"）

按用户需求 #6 "你可以自己定，你来选择最好的格式选型"，本节交代我做的几个关键判断与理由，便于评审：

1. **JSON 嵌在 XML envelope 内 vs 全 XML / 全 JSON / 多个 XML 子标签**
   - 全 XML（`<workflow-clarify><question kind="single" recommended="true"><title>…</title><options><option>…</option></options></question></workflow-clarify>`）：5 题 × 4 option × 5+ 字段 = ≥ 100 行 XML，agent 写错的概率大、解析器要写 ad-hoc XML parser。
   - 全 JSON 不包 envelope：和现有 `<workflow-output>` 风格脱节，runner 要为 clarify 加新的 envelope 探测路径（"看到行首 `{`" → 启发式不稳）。
   - JSON 嵌在 `<workflow-clarify>` 外壳：复用 `extractLastEnvelope`，agent 写 JSON 比写嵌套 XML 错误率低 5-10×（公开数据），前端 `JSON.parse` 后直接拿对象渲染。**选这个**。

2. **反问回环用一条边 vs 两条边**
   - 一条边（只 agent→clarify，answers 隐式注入）：画布上看不出反问环，新用户困惑。
   - 两条边（agent→clarify→agent）：直观、与 RFC-007 review/output drag 风格自洽、wrapper-loop 内的反问环自然映射为"loop body 内的有向环"。**选这个**；少数派"想拿 answers 接别处"的场景允许用户手删 answers→agent 边、把 answers 接其它节点（注入路径仍走 clarify_session 不变）。

3. **答案 schema 用 selected_option_ids 还是 selected_option_labels**
   - 都给：id 是"agent 给的稳定 id"，label 是 option 字符串。两者并存让 agent 后续 prompt 解析时既能精确对照 id 又能拿 human-readable string；冗余成本 < 100 bytes/题，可接受。

4. **framework synthesis 是否调 LLM**
   - 选**否**。每次反问跑一次额外 LLM call 增 token + 延迟 + 不确定性。改纯函数 `summariseClarifyAnswer` 按规则拼一句话（"User chose ... and provided custom answer ..."），确定性 + 零成本 + 单测可严格断言。

5. **clarify_iteration / review_iteration / retry_index 三路独立 vs 复用一个 counter**
   - 复用就会丢失"为什么这次重跑"语义——retry 是技术失败、review 是人不满意、clarify 是 agent 主动反问，三类原因放一个 counter 里查 prompt 历史会非常乱。**选独立**。Stats tab 上分三栏显示。

6. **clarify 节点是否要 sub-port 模型**（譬如对每个 question 一个出端口）
   - 选**否**。1 进 1 出最简单 + 用户需求明确要求。如果未来要"按 question 路由到不同下游"再开 RFC。

7. **裸 clarify 节点 vs 强制 loop 包裹**
   - 选**允许裸用** + warning。强制 loop 会让单轮反问场景（用户就想问 1 次）也得套 loop，过度。warning 引导用户在多轮场景下用 loop。

## 6. 与其它 in-flight RFC 的关系

- **RFC-021 task-detail-tabs**（任务详情页 Tab 化）：clarify 节点的 node_run 应该在 task 详情页"节点运行"tab 里和 review 同样呈现 awaiting_human 状态色；本 RFC 不抢 RFC-021 的 UI 范围，仅在 RFC-021 收到合并后做一次 visual smoke。
- **RFC-022 agent dependsOn**（agent 闭包注入 inline JSON）：clarify 反问场景与 dependsOn 是正交关系——反问发起方仍是单个 agent；本 RFC 不需要等 RFC-022，反之亦然。
- **RFC-005 review** + **RFC-014 sibling cascade** + **RFC-007 review/output drag**：本 RFC 复用三者的运行时 / UI / drag 机制但**不修改**它们的代码（diff = 0 in 这些文件），仅在并列处加 clarify 自己的等价路径。

## 7. 风险

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| agent 学不会 "二选一" envelope，频繁混发 | 中：本身规则简单，protocol block 反复强调即可；初期靠 retry 路径兜底 | C1 测试 + retries 配置默认 ≥ 2 |
| 用户答完后 designer 一直反问停不下来（裸 clarify 无 cap） | 中：靠 wrapper-loop 兜底 + S9 validator warning 提示 | 文档教育 + warning UI |
| 多 tab 同时答同一题导致 race | 低：clarify_session 单写者；后写者收到 409 conflict + 回到只读 | REST 端点 If-Match: clarify_iteration 乐观锁 |
| clarify_session JSON 太大（5 题 × 4 option × 长 label）撑大 DB | 极低：典型一条 < 4KB；上限即便满载也 < 64KB | 不做特别处理 |
| 第 5 个 "其他" 输入框被滥用塞超长 markdown | 低：单输入 textarea 限 2000 字（前端 maxLength 校验 + 后端 zod 兜底） | schema 字符数限 |

## 8. 后续可能的延展（v1 不做）

- clarify_session 历史 diff 视图：让用户看历史 N 轮反问问题对比变化。
- 反问目标支持 review 节点（让 review 给意见时也能反问）。
- LLM 生成更智能的 framework synthesis（v1 是确定性纯函数）。
- 自由问答模式（用户额外提自己的问题给 agent）。
- agent-multi fan-out 反问的"批量答题"模式：当多 shard 提的题部分重叠时，让用户一次答覆盖所有 shard（v1 是逐 shard 独立答）。
