# RFC-039 — Clarify Ask Bias (反问强制偏向)

Status: Draft
Author: WangBinquan
Created: 2026-05-19

## 背景

当前在 agent 节点挂接了反问通道（`__clarify__` 出边连到 clarify 节点）后，框架在用户提示词末尾追加一段 **bi-modal preamble**：把 `<workflow-output>` 和 `<workflow-clarify>` 两个 envelope 描述为 _"equally first-class"_，由 agent 自行判断该回答还是该反问（`packages/shared/src/prompt.ts:418-424`）。

同样地，用户在反问会话里点击「继续反问」按钮后（directive = `continue`），框架在下一轮提示词里追加的 trailer 是 _"The user is willing to answer more clarification questions. If material details remain unresolved..."_（`packages/shared/src/clarify.ts:236-240`），仍把"是否继续问"交给 agent 自行判断。

这两段措辞都是 RFC-023 上线后为了"避免 agent 被锚定到 output"而刻意写的对称表述。但用户实测下来发现：agent 在 input 看起来"差不多"时，**仍然倾向直接给 output**——这与挂接反问节点的产品意图相悖。挂反问节点本身就是用户在表达"我希望你先问清楚再做"，五五开的措辞稀释了这个意图。

## 目标

把"挂了反问节点 / 用户点了继续反问"这两种场景下的提示词措辞改成**强烈偏向反问**，但仍保留 agent 在 input 真正完备时直接出 output 的逃生口。

- (G1) 挂接反问节点时，提示词默认基调从"两者并列、自行选择"改为"**默认你应当先反问**；仅当 input 已经完全没有歧义、没有未定义决策时才允许直接 output"。
- (G2) 用户点击「继续反问」按钮后，trailer 措辞从"willing to answer / If..."改为"**强烈要求**你再发一轮 clarify；仅当每个细节都被上一轮答案彻底解决时才允许直接 output"。
- (G3) 不在 runner / scheduler 侧加任何硬拦截——agent 仍可在确实 input 完备时直接走 `<workflow-output>`，框架不视为协议违规。

## 非目标

- 不改变 `<workflow-output>` / `<workflow-clarify>` 协议本身（envelope 结构、both/neither 检测、shard / loop 行为完全不动）。
- 不引入新的 directive 类型；directive 仍是 `continue` / `stop` 二元，本 RFC 只改 `continue` 的文案。
- 不动 STOP CLARIFYING 分支文案（已是硬指令，不存在过软问题）。
- 不动 RFC-026 inline-mode 的短 reminder（它只是给已经在 session 里的 agent 一个"用户答了，请继续"的钩子，不承担"强制反问"语义）。
- 不改前端按钮文案 / UI——「继续反问」/「停止反问」按钮维持原样。
- 不动 schema_version、不加 DB 列、不加 migration。

## 用户故事

- **US1**：我（工作流作者）给一个 codegen agent 挂了反问节点，期望它在拿到模糊需求时先问清楚再写代码。当前实测：input 写得稍微完整一点，agent 就直接生成，跳过了反问。改完后：agent 应该在挂了反问节点的情况下默认先问，除非 input 已经精确到无歧义。
- **US2**：我（任务发起人）在反问会话里看到 agent 的第一轮问题之后，发现还有更多细节它没问到，于是点击「继续反问」。当前实测：agent 在下一轮看完我的答案后，有概率直接生成 output。改完后：agent 必须再发一轮 clarify，把还没问到的细节问完；只有当上一轮答案确实把所有未决项都解决了，它才可以直接 output。
- **US3**：我（工作流作者）希望简单任务不被反问拖累。改完后：input 写得完整明确的简单任务，agent 仍可以直接出 output，不被强行拉去问一轮废话。

## 验收标准

1. **首轮 / 挂接反问节点**：`buildProtocolBlock(agentOutputs, hasClarifyChannel=true)` 输出中：
   - 不再含字符串 `Both envelopes are equally first-class`。
   - 包含新的强偏向措辞（具体文案见 design.md §3.1），明确写出"默认你应当先 ask-back / clarify；只有当 input 已经完全消除歧义、所有决策都已被给定时才走 output"。
   - 仍保留 (A) output / (B) clarify 两个 envelope 的格式说明，且 (B) 仍排在 (A) 之后只是顺序问题，不影响新文案对 (B) 的偏向。
2. **continue 分支**：`renderClarifyDirectiveTrailer('continue')` 输出中：
   - 不再含字符串 `willing to answer more clarification questions`。
   - 包含 `User directive: KEEP CLARIFYING IF NEEDED` 标题（保留原 anchor，方便老测试 / 老日志识别）。
   - 包含新的强偏向措辞（design.md §3.2），明确写出"用户已显式要求你再发一轮 clarify；除非上一轮答案已彻底解决所有未决项，否则你必须再发一个 `<workflow-clarify>`"。
3. **stop 分支**：`renderClarifyDirectiveTrailer('stop')` 输出与本 RFC 前完全一致（不动）。
4. **inline-mode reminder**：`buildClarifyInlineReminder()` 输出与本 RFC 前完全一致（不动）。
5. **runner 行为**：runner 不新增对 envelope 的硬拦截；agent 在 hasClarifyChannel=true 时直接出 `<workflow-output>` 仍是合法 outcome，不报错、不重试。
6. **单元测试**：
   - 锁旧文案的测试（`clarify-prompt-injection.test.ts:102` 对 `Both envelopes are equally first-class` 的断言、`clarify-prompt-inline.test.ts:75` 对应负断言、`clarify-utils.test.ts:295/298` 对 trailer 文案的断言）跟随更新，断言新关键短语。
   - 新增**正向**用例：bi-modal preamble 含"default to" / "ask back first" / "only when ... fully resolved" 等强偏向短语；continue trailer 含"required" / "another `<workflow-clarify>`" 等强语气短语。
   - 新增**回归防护**：源码层 grep 守卫——`packages/shared/src/prompt.ts` 不得再含 `Both envelopes are equally first-class`；`packages/shared/src/clarify.ts` 不得再含 `willing to answer more clarification questions`。
7. **e2e**：无新增。Playwright 不覆盖提示词文案，本 RFC 不影响 UI 路径。
8. **三件套**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions 六 jobs 全绿。

## 风险与权衡

- **风险 R1（过度反问）**：把首轮 bi-modal 改成强偏向反问，可能让简单任务也被多问一轮。
  - 缓解：保留逃生口（input 完备时仍可直出 output），并在文案里显式给出判定准则（"every decision is already given by the inputs"）。
  - 监测：作为工作流作者，可以通过移除 clarify 节点退出反问通道——一旦节点不挂，bi-modal preamble 不出现，回到 legacy 行为。
- **风险 R2（与 RFC-023 设计意图回退）**：RFC-023 当初引入 bi-modal 是为了让 agent 不被锚定到 output；本 RFC 把锚点反过来挪到 clarify 侧，可能让 agent 在 hasClarifyChannel=true 时即便 input 完备也反问。
  - 缓解：文案里明确"only when ... fully resolved"，用判定准则替代单纯的强制。R2 的反向也是本 RFC 的目的——挂了反问节点本身就是用户在选择"宁错杀不放过"，可接受少量过度反问换取"该问没问"被消除。
- **风险 R3（措辞改动破坏老 agent 协议适配）**：极少数 agent 可能 grep 了固定文案做行为分支。
  - 缓解：保留 envelope 名（`<workflow-output>` / `<workflow-clarify>`）+ 保留 `KEEP CLARIFYING IF NEEDED` / `STOP CLARIFYING` 两个 H3 标题作 anchor；只改解释性长文，结构不动。

## 与已落地 RFC 的关系

- **RFC-023**（clarify channel + bi-modal preamble）：本 RFC 改的就是 RFC-023 引入的两段文案，属于在同一抽象上的措辞调优，不撤销 RFC-023 的协议设计。
- **RFC-026**（inline session mode）：inline-mode reminder 由 `buildClarifyInlineReminder()` 单独渲染，本 RFC 不动它（首轮 bi-modal preamble 已经在 session 里，inline reminder 只是"用户答了"的短钩子，不承担文案强弱）。
- **RFC-037**（任务名称必填）：完全正交，本 RFC 不涉及 task 字段。
- **RFC-038**（agent 表单依赖自动识别）：完全正交。
