# RFC-039 — Clarify Ask Bias · 任务分解

单 PR，~6 个子任务，按以下顺序串行（每个子任务都在同一 PR 里，但 commit history 可清晰分段）。

## RFC-039-T1：改写 bi-modal preamble 文案

- 编辑 `packages/shared/src/prompt.ts` 的 `buildProtocolBlock`：`hasClarifyChannel === true` 分支按 design.md §3.1 重写 preamble 段落（保留 (A)/(B) 格式块、port 列表、example 不动）。
- 同时更新 `buildProtocolBlock` 上方 JSDoc 关于"bi-modal preamble"的描述，指出新基调是"default ask-back"。
- 依赖：无。

## RFC-039-T2：改写 continue trailer 文案

- 编辑 `packages/shared/src/clarify.ts` 的 `renderClarifyDirectiveTrailer`：`directive === 'continue'` 分支按 design.md §3.2 重写。
- `directive === 'stop'` 分支保持完全不动。
- 同时更新函数上方 JSDoc 中 'continue' 行的描述（"mild reminder" → "strong directive, soft escape hatch"）。
- 依赖：无（与 T1 并行可，但同 PR 提交）。

## RFC-039-T3：更新既有测试断言

- 按 design.md §5.1 表更新 4 个测试文件的现有断言：
  - `packages/shared/tests/clarify-prompt-inline.test.ts`
  - `packages/backend/tests/clarify-prompt-injection.test.ts`
  - `packages/backend/tests/clarify-service.test.ts`（两处：行 562、行 700）
  - `packages/shared/tests/clarify-utils.test.ts`（两处：行 295、298）
- 依赖：T1 + T2 完成（否则旧文案断言会先红一遍）。

## RFC-039-T4：新增正向锚点用例

- 按 design.md §5.2，在 `clarify-utils.test.ts` 末尾加：
  - "RFC-039: continue trailer contains strong-bias anchors" 4 条 toContain。
  - "RFC-039: stop trailer wording locked verbatim" 1 条 toEqual / toMatchSnapshot 防误改。
- 在 `clarify-prompt-injection.test.ts` 末尾加：
  - "RFC-039: bi-modal preamble default-asks (B) and lists ask-back triggers" 4 条 toContain。
- 依赖：T1 + T2。

## RFC-039-T5：新增源码层 grep 守卫

- 按 design.md §5.3：在 `packages/backend/tests/clarify-prompt-injection.test.ts` 末尾加两个 grep guard test（或新建独立文件 `clarify-prompt-source-grep.test.ts`，二选一，看现有 test 文件长度决定）。
- 注释里写明本守卫的来由（RFC-039 + commit），让未来 refactor 看到红就能立刻定位意图。
- 依赖：T1 + T2 落地后断言才会绿。

## RFC-039-T6：验证 + 提交

- 本地三件套：`bun run typecheck && bun run test && bun run format:check`。期望测试 +6~10 条全绿，前置 4 处更新断言也绿。
- commit message：`feat(prompt): RFC-039 强化挂接反问节点 / 继续反问的提示词偏向` + body 引用 design.md §3.1 / §3.2。
- 更新 `design/plan.md` RFC 索引追加 RFC-039 一行（状态 Draft → In Progress → Done 随实现推进）。
- 更新 `STATE.md` 顶部"进行中 RFC"指向 RFC-039；完工后状态改 Done 并在已完成 issue 表追加一行。
- 按 [feedback_post_commit_ci_check] 推送后立即查 GitHub Actions 六 jobs 状态。
- 依赖：T1..T5。

## 验收清单

- [ ] `packages/shared/src/prompt.ts` 不再含 `Both envelopes are equally first-class`，含 design.md §3.1 的四个关键短语
- [ ] `packages/shared/src/clarify.ts` 不再含 `willing to answer more clarification questions`，含 design.md §3.2 的四个关键短语
- [ ] `renderClarifyDirectiveTrailer('stop')` 输出逐字保持
- [ ] `buildClarifyInlineReminder()` 输出逐字保持
- [ ] runner / scheduler / envelope / clarify session 流转逻辑零改动
- [ ] DB schema / migration / shared schemas 零改动
- [ ] 前端代码零改动
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] GitHub Actions 六 jobs 全绿（含单二进制 build smoke + Playwright e2e）
- [ ] `design/plan.md` RFC 索引登记 RFC-039
- [ ] `STATE.md` 同步更新

## 不在本 RFC 范围（后续可独立提）

- runner 侧硬拦截："continue 后直出 output → 视为协议违规 + 自动重试"——需要 directive 落到 ClarifyPromptContext 给 envelope.ts 读，是行为变更，单立 RFC。
- bi-modal preamble 在 input 完备时**自动跳过**反问 preamble 的启发式（让 framework 反向判定）——需要新启发式 + tokens 预算分析，单立 RFC。
- agent.md 层声明 "force-ask-on-first-run"（让作者更细控制反问偏向）——属 agent 元数据扩展，单立 RFC。
