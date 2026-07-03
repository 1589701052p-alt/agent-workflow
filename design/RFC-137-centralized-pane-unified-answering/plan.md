# RFC-137 — 任务分解

单 PR（main 直推，commit 前缀 `feat(clarify): RFC-137 …`）。改动面：1 组件 + 1 测试文件 + 索引/STATE 登记。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                                                                                     | 依赖  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| RFC-137-T1 | `CentralizedAnswerDialog.tsx` 去 scope 面：删 `scopes` 状态、两段 scope JSX（选择器 + 重答只读行）、`RoundSubmission.kind`/`questionScopes` 字段、提交体 cross 门（`:262-264`）、builder cross 分支（`:579-591`）、`CLARIFY_QUESTION_SCOPE_DEFAULT`/`ClarifyQuestionScope` import；改写相关块注释为新语义（design §3）。 | —     |
| RFC-137-T2 | `centralized-answer-pane.test.tsx` 联动：按 design §5 改写 5 处 scope 断言为「无 scope UI + 提交体无 `questionScopes`」回归锁；更新文件顶 why-this-test-exists 注释。                                                                                                                                                    | T1    |
| RFC-137-T3 | 收口：`bun run typecheck` + 后端 `bun test` + 前端 vitest + `bun run format:check` 全绿；`design/plan.md` RFC 索引置 Done、`STATE.md` 进行中行改已完成行；commit + push + 查 GitHub Actions。                                                                                                                            | T1,T2 |

## 验收清单

- [x] AC-1 面板 cross fresh 题无 `centralized-scope-{qid}`。
- [x] AC-2 面板 cross 重答题无 `centralized-scope-readonly-{qid}`，重答提示保留。
- [x] AC-3 提交体（单轮/多轮/fresh+reseal 混合）均无 `questionScopes` 键。
- [x] AC-5 同/跨节点**答题面**同形（保留面除外：分组头来源文案、`ClarifyQuestionHandler` 处理节点回显——边界见 proposal AC-5）。
- [x] AC-6 详情页测试（`cross-clarify-scope-control` 等）零改动全绿。
- [x] 组件内 `ClarifyQuestionScope` / `CLARIFY_QUESTION_SCOPE_DEFAULT` 零引用（typecheck + lint 兜底）。
- [x] 门禁四件套绿（typecheck×3 / 后端 4532 / 前端 vitest 2933 / format）；CI 于 push 后核验。
