# RFC-157 — 提交推送内置 agent 输出语言可配置

状态：Draft

## 背景

内置 framework agent「提交推送」（commit-push，RFC-075）在自动提交时用一个 opencode/claude 会话
生成 git commit message，并在推送被拒时生成修复后的 message。目前这两段 prompt
（`buildCommitMessagePrompt` / `buildRepairPrompt`，`services/commitPush.ts`）**硬编码全英文、
没有任何语言开关**，因此中文团队即便把整站 UI 与记忆库都切成中文，自动提交仍产出英文 commit
message，风格割裂。

另一个内置 agent「记忆提炼」（distiller）在 RFC-050 已经解决了同类问题：`config.memoryDistillLang`
（两值枚举 `zh-CN`/`en-US`，`undefined ≡ en-US`）+ prompt 末尾追加一段语言指令 + RFC-156「系统
Agent」页签记忆卡里一个下拉框。用户希望**提交推送 agent 也拥有同款语言配置，且配置项与记忆提炼
保持一致**。

## 目标

1. 新增 `config.commitPushLang`，语义与 `config.memoryDistillLang` **完全一致**：两值枚举
   `zh-CN`/`en-US`，`undefined ≡ en-US`（保留 RFC-075 现有英文基线），仅 patch 层允许省略=默认。
2. commit message 与 push-repair message 两段 prompt 都在**末尾**追加一段语言指令：设为中文时用
   简体中文书写**摘要与正文**，但保留 Conventional-Commits 的 `<type>(<scope>):` 前缀为小写 ASCII
   （与记忆提炼保留 `[category:xxx]` ASCII 的做法对称，也与本仓自身提交风格 `docs(state): …中文`
   一致）。
3. 在 RFC-156「系统 Agent」页签的**提交推送卡片**里加一个与记忆卡输出语言下拉框同款的
   `<Select>`（Default / English / 简体中文），归入同一个 Save。

## 非目标

- 不改动记忆提炼既有**语言指令 / prompt** 机制（只做对称新增）。**例外（随行修）**：记忆卡输出
  语言下拉框存在与本 RFC 同款的「选 Default 无法清除已存值」隐患（发 `undefined` 被 mergePatch
  当「不改」），本 RFC 一并把它改为发 `null`（与运行时选择器一致），否则新旧两个语言下拉框行为
  不一致、违背「配置项一致」。
- 不改 commit message 的**结构**（仍是 Conventional Commits）、不引入除 `zh-CN`/`en-US`
  之外的第三种语言（与记忆提炼两值枚举一致；未来要扩语言两处一起扩）。
- 不本地化 commit message 的类型/范围词（前缀恒为 ASCII，用户已拍板）。
- 不改动 commit-push 的 git 编排、推送/修复分类、fallback 模板（`buildFallbackMessage`
  仍是英文确定性模板——它是 LLM 失败时的兜底，不走语言开关，保持可预测）。
- 不做「按仓库/按任务」粒度的语言覆盖；不做 distiller 式 per-job 持久化冻结。沿用其它 commit-push
  旋钮同一条链——每次 scheduler 启动 / resume / retry 时从 **live config** 解析、单次运行内固定
  （与 `diffMaxBytes` / `maxRepairRetries` 一致；任务暂停期间管理员改 config 会在 resume 后生效）。见 design §数据流。

## 用户故事

- 作为中文团队管理员，我在「系统 Agent」页签把提交推送输出语言设为「简体中文」，此后自动提交
  生成的 commit message 摘要/正文为中文、`feat(scope):` 前缀仍为英文，与我们手写提交风格一致。
- 作为管理员，我保持 Default（不设该项），自动提交产出英文 commit message——与**显式选 English**
  一致（与记忆提炼对称：en-US 指令即便未设置也追加，只是强化「摘要/正文英文、前缀 ASCII」，
  commit message 仍为英文，语义与升级前无实质差异）。
- 作为已设为「简体中文」又想改回默认的管理员，我在下拉选回「Default」并保存，配置项被**真正清除**
  （回到未设置/英文），而不是保存假成功却仍是中文——与运行时选择器「继承」清除同款机制（发 `null`）。
- 作为管理员，当远端策略钩子拒绝推送、框架发起修复会话时，修复后的 commit message 与初始
  message 用**同一种**配置语言，不会中英混杂。

## 验收标准

1. `config.commitPushLang` 基础 schema 接受 `'zh-CN'` / `'en-US'`（不接受 null，与运行时字段一致——
   null 是 patch-only）；省略时运行期等价 `'en-US'`；拒绝空串与非法值。`ConfigPatchSchema` 额外接受
   `null`（= 清除该键回默认），前端「Default」发 `null` 使 mergePatch 真正删除已存值（**不是**发
   `undefined` 被当「不改」——本 RFC 对 `commitPushLang` 与随行修的 `memoryDistillLang` 同样处理）。
2. `commitPushLang='en-US'`（及未设置，运行期归一为 en-US）时，`buildCommitMessagePrompt` /
   `buildRepairPrompt` 产出的 prompt 与「显式 en-US」**逐字节相同**，末尾语言指令是英文版；`'zh-CN'`
   时末尾为中文版。**镜像记忆提炼**：en-US 指令即便在未设置的默认路径也追加（不承诺与升级前逐字节
   一致——那与「配置项一致」相冲；commit message 仍为英文、语义不变）。两版指令都显式声明
   「`<type>(<scope>):` 前缀保持小写 ASCII」。
3. 语言指令追加在两段 prompt 的**最后**（在信封示例之后），使模型最后读到它。
4. 调度器把 `config.commitPushLang` 经既有 launch 配置链透传，初始与修复两个会话都用同一语言。
5. 「系统 Agent」页签提交推送卡出现输出语言下拉框（testid `settings-commit-push-lang-select`，
   三选项 Default/English/简体中文），反映并保存 `commitPushLang`，与记忆卡下拉框视觉/交互一致，
   随同一个 Save 落盘；选 Default **发 `null`** 使已存值被清除（回英文默认）。记忆卡下拉框一并改同款。
6. i18n `settings.commitPushLang*` 五个 key 在中英双语可达。
7. 门禁：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest + binary smoke 全绿；
   CI 双 OS + e2e 绿。测试覆盖见 design §测试策略。
