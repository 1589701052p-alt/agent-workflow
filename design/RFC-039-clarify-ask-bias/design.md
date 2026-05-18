# RFC-039 — Clarify Ask Bias · 技术设计

## 1. 改动范围一览

| 层            | 文件                                                                                               | 改动                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared        | `packages/shared/src/prompt.ts`                                                                    | `buildProtocolBlock(..., hasClarifyChannel=true)` 分支的 preamble 文案重写（§3.1）                                                                  |
| shared        | `packages/shared/src/clarify.ts`                                                                   | `renderClarifyDirectiveTrailer('continue')` 文案重写（§3.2）                                                                                        |
| shared tests  | `packages/shared/tests/clarify-utils.test.ts`                                                      | 锁旧 continue 文案的断言改为锁新关键短语 + 加正向用例（§5）                                                                                         |
| shared tests  | `packages/shared/tests/clarify-prompt-inline.test.ts`                                              | 负断言 `not.toContain('Both envelopes are equally first-class')` 改为锁新短语                                                                       |
| backend tests | `packages/backend/tests/clarify-prompt-injection.test.ts`                                          | 锁旧文案的 `expect(out).toContain('Both envelopes are equally first-class')` 改为锁新短语                                                           |
| backend tests | `packages/backend/tests/clarify-service.test.ts`                                                   | trailer 断言（行 562 / 700）跟随新文案                                                                                                              |
| backend tests | 新增 `packages/backend/tests/clarify-prompt-source-grep.test.ts`（可选合并入既有 grep guard 文件） | 源码层 grep 守卫：`prompt.ts` 不得含 `Both envelopes are equally first-class`，`clarify.ts` 不得含 `willing to answer more clarification questions` |

**零改动**：runner.ts / scheduler.ts / clarify.ts 的会话流转逻辑 / envelope.ts / DB schema / shared schemas / 前端任何文件 / e2e。

## 2. 接口契约（不变 / 变）

### 不变

- `RenderPromptInput` / `ClarifyPromptContext` 字段全部保持现状。
- `buildProtocolBlock` 函数签名（`(agentOutputs, hasClarifyChannel?, agentOutputKinds?) => string`）不变。
- `renderClarifyDirectiveTrailer` 函数签名（`(directive?) => string`）不变。
- `<workflow-output>` / `<workflow-clarify>` envelope 检测函数（`detectEnvelopeKind` 等）不变。
- runner 的 both/neither hard-reject + retry policy 不变。

### 变

- 上述两函数**返回字符串**的内容变化，是用户可见的协议文案变化。属于"会传给生产 agent 的 prompt 内容"，是产品行为变更——所以走 RFC。

## 3. 新文案

文案保留两个稳定 anchor，便于老测试和老日志识别：

- bi-modal 段落仍以 `---\n**` 开头。
- continue trailer 仍保留 `### User directive: KEEP CLARIFYING IF NEEDED` 标题。

### 3.1 bi-modal preamble（`hasClarifyChannel=true`）

替换 `prompt.ts:416-424` 现有四行为如下（其余 (A)/(B) 格式块、port 列表、`<workflow-output>` 例子部分保持原样）：

```
---
**This node has a clarify channel. The user has wired it because they expect you to ask back when intent is under-specified.**

By default, your next reply should be (B) `<workflow-clarify>` — ask the user to disambiguate before you commit a final answer. You may emit (A) `<workflow-output>` directly ONLY when every decision needed to satisfy the inputs has already been pinned down by the prompt / inputs / earlier rounds — i.e. there is genuinely nothing left to ask. Picking (A) means you are taking full responsibility that no naming choice, technical option, UX decision, or unstated constraint is being guessed at.

If, while drafting, you find yourself: hedging, marking decisions as "TBD", inventing constraints not given by the inputs, choosing between plausible alternatives without a stated preference, or rationalizing your own pick of the user's intent — you do NOT have the green light for (A); emit (B) instead.

  (A) `<workflow-output>` — final answer, format described under "(A) `<workflow-output>` format" below.
  (B) `<workflow-clarify>` — ask the user; format described under "Clarify mode is enabled for this node" further below.
```

后续 `— (A) <workflow-output> format —` 标题 + port bullet 列表 + `<workflow-output>` 例子，**完全保持原样不动**。clarify 协议块 (`buildClarifyProtocolBlock`) 也不动。

#### 关键短语（测试锚点）

- `The user has wired it because they expect you to ask back`
- `By default, your next reply should be (B)`
- `ONLY when every decision`（替代旧的 "equally first-class"）
- `you do NOT have the green light for (A)`

### 3.2 continue trailer（`directive='continue'`）

替换 `clarify.ts:236-241` 现有三行为如下：

```
### User directive: KEEP CLARIFYING IF NEEDED
- The user has explicitly clicked "Keep clarifying" — they want you to ask another round.
- Your next reply is REQUIRED to be another `<workflow-clarify>` envelope unless every single unresolved detail has been fully pinned down by the answers above. Inventing a "good enough" excuse to skip to <workflow-output> defeats the user's stated intent.
- If — and only if — re-reading the answers above leaves zero unresolved decisions, you may emit <workflow-output> instead. Otherwise emit <workflow-clarify> with every still-open question.
```

#### 关键短语（测试锚点）

- `User directive: KEEP CLARIFYING IF NEEDED` （保留旧 anchor）
- `explicitly clicked "Keep clarifying"`
- `REQUIRED to be another`
- `If — and only if — re-reading the answers above leaves zero unresolved decisions`

### 3.3 不动

- `renderClarifyDirectiveTrailer('stop')` 文案：完全保留 RFC-023 的硬指令措辞。
- `buildClarifyInlineReminder()`：RFC-026 短钩子，不动。
- `buildClarifyProtocolBlock()`（clarify envelope JSON 格式块）：不动。

## 4. 失败模式与边界

- **agent 不遵守新偏向、仍直出 output**：runner 不视为协议违规（与现状一致）。这是 G3 的逃生口；监测靠用户在 task 详情页"任务卡到 awaiting_human 期望来"但实际"直接 done"的体验差异，后续可以通过迭代措辞或加 runner 启发式拦截（不在本 RFC 范围）。
- **agent 看不懂"every decision is already pinned down"判定准则**：fallback 路径与现状一致——agent 自行判断，框架不强干预。
- **老 task 中途升级**：本 RFC 是纯字符串变化，不涉及 DB 字段、不涉及 task 数据迁移。任何在升级时点之前已生成的 prompt 已经发给 opencode，不受影响；升级后的下一次 runNode 调用拿到的就是新文案，无须迁移。
- **agent 反复死循环反问**：与现状一致——靠 wrapper-loop 的 max_iterations 上限收口（已有），continue trailer 含 `__clarify_remaining__` token，agent 能感知剩余轮次。
- **空 agentOutputs**：`buildProtocolBlock` 在 outputs 为空时仍输出 preamble；当前测试已覆盖（不在本 RFC 改动）。

## 5. 测试策略

按 CLAUDE.md "Test-with-every-change" 规则，本 RFC 的测试 = **更新既有用例 + 加 grep 守卫 + 加正向锚点**。

### 5.1 必更新的现有用例

| 文件                                                      | 行   | 改动                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/tests/clarify-prompt-inline.test.ts`     | ~75  | `not.toContain('Both envelopes are equally first-class')` → `not.toContain('By default, your next reply should be (B)')`（inline mode 仍不应出现新 preamble）                                                                          |
| `packages/backend/tests/clarify-prompt-injection.test.ts` | ~102 | `expect(out).toContain('Both envelopes are equally first-class')` → `expect(out).toContain('By default, your next reply should be (B)')` 并补一条 `expect(out).toContain('The user has wired it because they expect you to ask back')` |
| `packages/backend/tests/clarify-service.test.ts`          | 562  | 负断言保持（aBlock 不含 KEEP CLARIFYING，因为不是 latest round），无须改                                                                                                                                                               |
| `packages/backend/tests/clarify-service.test.ts`          | 700  | 正断言保持 anchor `User directive: KEEP CLARIFYING IF NEEDED`，但加一条 `expect(ctx?.answersBlock ?? '').toContain('REQUIRED to be another')`                                                                                          |
| `packages/shared/tests/clarify-utils.test.ts`             | 295  | 锚点 `User directive: KEEP CLARIFYING IF NEEDED` 保留；加 `expect(trailer).toContain('REQUIRED to be another')`                                                                                                                        |
| `packages/shared/tests/clarify-utils.test.ts`             | 298  | 同上                                                                                                                                                                                                                                   |

### 5.2 新增正向用例（建议放在 `clarify-utils.test.ts` 末尾、`clarify-prompt-injection.test.ts` 末尾）

- bi-modal preamble 含全部四个关键短语（§3.1 列表）。
- continue trailer 含全部四个关键短语（§3.2 列表）。
- stop trailer 文案逐字保持（防止误改邻近代码连带改了 stop 分支）。
- inline reminder 文案逐字保持。

### 5.3 新增源码层 grep 守卫

合并到既有的 `packages/backend/tests/clarify-prompt-injection.test.ts`（同文件已有类似 grep guard）或新建 `clarify-prompt-source-grep.test.ts`：

```ts
import { readFileSync } from 'node:fs'
test('RFC-039: prompt.ts must not retain the legacy "equally first-class" wording', () => {
  const src = readFileSync(require.resolve('@agent-workflow/shared/src/prompt.ts'), 'utf8')
  expect(src).not.toContain('Both envelopes are equally first-class')
})
test('RFC-039: clarify.ts must not retain the legacy "willing to answer" wording', () => {
  const src = readFileSync(require.resolve('@agent-workflow/shared/src/clarify.ts'), 'utf8')
  expect(src).not.toContain('willing to answer more clarification questions')
})
```

理由：CLAUDE.md "测试用例随每次需求 / 修复落地"要求 bug 回归防护要带源码层兜底（参考 RFC-022 `selectionOnDrag` grep guard 模式），避免未来 refactor 不经意把旧措辞复活。

### 5.4 不新增 e2e

Playwright 不覆盖 prompt 文案，本 RFC 完全不动 UI。`bun run typecheck && bun run test && bun run format:check` 三件套全绿即可。

## 6. PR 拆分

单 PR：本 RFC 改动量极小（两段字符串 + ~6 处测试更新 + ~4 条新断言 + 2 条 grep 守卫），无需拆分。commit 前缀：`feat(prompt): RFC-039 强化挂接反问节点 / 继续反问的提示词偏向`。

## 7. 回滚方案

- 单 commit 直接 revert 即可。
- 测试随同 revert，无 DB schema / migration 残留。
- 不存在跨 PR 的依赖关系。

## 8. opencode 行为验证

本 RFC 不改 opencode 端的协议——`<workflow-output>` / `<workflow-clarify>` 仍由 opencode 透传到 stdout 末尾，框架侧 `detectEnvelopeKind` 不变。无须再次 grep `packages/opencode/src/`。
