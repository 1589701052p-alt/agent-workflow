# RFC-137 — 技术设计：集中回答面板统一答题

零后端改动 / 零 API 变化 / 零 migration。改动收敛在一个组件 + 一个测试文件：
`packages/frontend/src/components/clarify/CentralizedAnswerDialog.tsx`、
`packages/frontend/tests/centralized-answer-pane.test.tsx`。

## 1. 现状与改动总览

集中面板对跨节点轮的 scope 面（全部删除）：

| 位置（CentralizedAnswerDialog.tsx）                                                                         | 现状                                                  | 处置                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `:29` `import { CLARIFY_QUESTION_SCOPE_DEFAULT }` + `:24` `ClarifyQuestionScope` 类型                       | 选择器默认值 / 类型                                   | 随消费点一并删除（删后组件内零引用）                                  |
| `:141` `RoundSubmission.kind`                                                                               | 唯一消费点是 `:262` 的 cross 门                       | 删除字段（`round.kind` 在分组头 `:620` 的用法保留，属来源展示）       |
| `:151` `RoundSubmission.questionScopes?`                                                                    | 子块上报的逐题 scope                                  | 删除字段                                                              |
| `:262-264` 提交体 `if (sub.kind === 'cross' && sub.questionScopes !== undefined) body.questionScopes = ...` | 唯一把 scope 写进请求体的点                           | 删除——面板提交体恒不含 `questionScopes`                               |
| `:425` `const [scopes, setScopes]` + 注释 `:422-424`                                                        | 逐题 scope 状态（纯 ephemeral，组件态，无任何持久化） | 删除（`:595` effect deps 里的 `scopes` 一并去掉）                     |
| `:579-591` 上报 builder 的 cross 分支（fresh 题填默认 designer）                                            | 组装 `questionScopes`                                 | 删除                                                                  |
| `:657-664` 重答题只读 scope 行（`centralized-scope-readonly-{qid}`）                                        | RFC-136 D6 的展示面                                   | 删除（服务端锁定语义不变；sealed scope 在 /clarify 详情页仍只读可见） |
| `:665-693` `.segmented` 选择器（`centralized-scope-{qid}`）                                                 | RFC-059/128 P5-BC 控件                                | 删除                                                                  |
| `:375-378`、`:652-656` 等块注释                                                                             | 描述 cross 渲染 scope picker                          | 改写为新语义（见 §2）                                                 |

不动：`ClarifyQuestionHandler`（`:641-645`，处理节点回显/改派，seal 后自显）、重答提示（`:647-651`）、分组头 cross/self i18n（`:617-622`）、draft 自动保存（本来就不含 scope）、`groupAnswerableQuestions`、提交 mutation 其余字段（`defer:true` / `questionIds` / `resubmitQuestionIds` / `ifMatchIteration`）。

## 2. 接口契约（提交体差异与服务端等价性）

面板此前对 cross 轮发送 `questionScopes = { 每道 fresh 题: 用户所选 ?? 'designer' }`；改后完全不发送。服务端路径：

- `POST /api/clarify/:nodeRunId/answers` schema 里 `questionScopes` 是 optional（`packages/shared/src/schemas/clarify.ts`，`CLARIFY_QUESTION_SCOPE_DEFAULT = 'designer'` 同文件 `:150`）——不发送=合法请求，非破坏。
- seal 时 `services/clarifySeal.ts:277`（`mergedScopes`，写回 `:347/:367/:416`）把收到的 scopes 合并进 `question_scopes_json`；未传则该题无键。
- 派生读取端 `reconcileDesiredEntries`（`packages/shared/src/task-questions.ts:99-138`）：反问者条目**恒有**（`:114-120`，与 scope 无关，语义不变）；设计者条目在「已 seal ∧ directive≠stop ∧ `scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT === 'designer'`」时派生（`:124-133`），`defaultTargetNodeId = graph.designerNodeId`，而 `graphForRound` 把它接到 `round.targetConsumerNodeId`（`services/taskQuestions.ts:117-122`）——即 `to_designer` 边指向的**设计节点**。

- scope 的另一消费点 `extractDesignerScopedSubset`（`packages/shared/src/clarify.ts:641-660`，设计者 External Feedback 注入的逐题过滤）同样经 `resolveQuestionScope`（`:621-627`）解析，无键 → 默认 `designer` → 全量转发。

**等价性的准确边界**（Codex 设计门 P2-1 修订）：「不发送」与「发送全默认 designer」在**派生/运行时面等价**——reconcile 派生条目、注入过滤、mint gating 的全部读取方都走同一个 `resolveQuestionScope` 的 `??` 默认分支，产出完全一致。但**存储/DTO 形状有显式接受的差异**：面板此前发全默认 → `question_scopes_json` 持久化 `{"每题":"designer"}`；改后不发送 → route 仅在 present 时 forward、`clarifySeal` 落 NULL（既有后端测试锁定该行为：`cross-clarify-question-scope.test.ts:225`「no questionScopes → designer rerun + both tables NULL」）。该差异无语义后果：所有读取方（reconcile `task-questions.ts:125`、注入 `clarify.ts:652`、详情页 sealed 只读 chip `clarify.detail.tsx:233` `?? CLARIFY_QUESTION_SCOPE_DEFAULT`）都对键缺失默认兜底，没有任何消费者对键的存在性敏感。处理节点默认=设计节点由既有默认值直接达成，后端零改动。锚定测试：`packages/backend/tests/cross-clarify-question-scope.test.ts`「未传 scope → designer 默认 + designer rerun」case（本 RFC 引用、不修改）。

RFC-136 重答（reseal）题：面板此前对 resubmit id 就不发送 scope（`:587`），服务端 D6 二层防御忽略误传——改后行为无差异；历史 scope=`questioner` 的题重答仍保持 questioner 派生面（不生成设计者条目）。

## 3. 前端改动细节

`RoundAnswerBlock`：删 `scopes` 状态与两段 scope JSX；上报 effect（`:556-602`）删 cross 分支与 `scopes` dep；`RoundSubmission` 收缩为 `{ roundId, iteration, answers, questionIds, resubmitQuestionIds }`。块顶注释（`:373-378`）改写为：

> A CROSS round answers uniformly with a SELF round — no per-question scope UI. Scopes are
> not sent; the server resolves every fresh question to the default `designer` scope, so the
> handler entry's target defaults to the designer node (RFC-137; route-level scope control
> lives only on /clarify detail). RFC-136 re-answers keep their committed scope server-side (D6).

父组件 `submitMut`：删 `:262-264` 三行。i18n：`crossClarify.questionScope.*` 三键仍被 `clarify.detail.tsx` 使用，**不删**，无孤儿键。CSS：`.segmented` 是公共 class，不动。

## 4. 失败模式

| 场景                                                                                 | 行为                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 并发：他人经 /clarify 详情页对同轮答题并选了 `questioner`                            | 与现状同——先 seal 者胜（exactly-once 409 / RFC-136 声明制不变）；面板侧不受影响。                                                                                  |
| 历史轮 `question_scopes_json` 已有 `questioner` 值、该题回到待指派被面板重答         | 服务端 D6 锁定原值，派生面零变化；面板不再显示该 scope（详情页 sealed 只读 chips 仍可见）。                                                                        |
| 面板提交的 cross 轮存储/DTO 形状变化：`question_scopes_json`=NULL（原为全默认 JSON） | 显式接受（§2）：全部读取方经 `resolveQuestionScope` / `?? CLARIFY_QUESTION_SCOPE_DEFAULT` 兜底，详情页只读 chip 对 NULL 仍显示「设计者」；无消费者对键存在性敏感。 |
| 旧客户端/详情页继续发送 `questionScopes`                                             | API 原样接受（D2 后端保留），无兼容问题。                                                                                                                          |

无新增失败模式：改动只是「少发一个 optional 字段 + 少渲染两段 JSX」。

## 5. 测试策略（Test-with-every-change）

前端 vitest `centralized-answer-pane.test.tsx` 联动（现有 scope 相关 5 处）：

1. `:323-325` self 轮无 scope UI —— 保留，断言面扩展为「任何轮都无 `centralized-scope-*`」。
2. `:395` 「cross 重答题 scope 只读；fresh 题仍有切换」 → 改写为「cross 重答题与 fresh 题均无任何 scope UI（`centralized-scope-readonly-q1`、`centralized-scope-q2` 皆不存在），重答提示保留」。
3. `:426` 「提交体 fresh+reseal 混合 → questionScopes 只含 fresh」 → 改写为「提交体不含 `questionScopes` 键（`'questionScopes' in body === false`），`questionIds`/`resubmitQuestionIds` 语义不变」。
4. `:498` 两轮批量提交 → 断言两个请求体均无 `questionScopes`。
5. `:561` 「cross 渲染选择器、切 questioner」 → 改写为回归锁：「cross fresh 题不渲染选择器；默认提交即落 designer 语义（体现在体内**无** scope 字段）」。

文件顶注释更新 why-this-test-exists 说明（锁 RFC-137：面板不区分同/跨节点答题）。

不动：`cross-clarify-scope-control.test.tsx` / `cross-clarify-scope-shortcut.test.tsx` / `cross-clarify-scope-i18n.test.ts`（详情页 D1 保留）；后端零改动、零新测（契约由既有 `cross-clarify-question-scope.test.ts` 锚定）。

门禁：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest 全绿；push 后查 GitHub Actions。

## 6. 兼容与迁移

无。纯前端渲染/请求体收缩；无持久化状态（scope 从未进 draft/IDB），无数据迁移，无 API 版本影响。回滚=revert 单 commit。
