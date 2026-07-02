# RFC-134 任务分解

> 单 RFC 单 PR（默认）。commit 前缀 `feat(clarify): RFC-134 …`。
> 实现前置：工作树当前有协作者在 clarify 区域的未提交改动（design §1 协作提示）——**开工时先确认其已提交 / rebase 到最新，再落点**；同函数真冲突停下问用户。

## 任务

| Task | 内容 | 依赖 | 主要产出 |
| --- | --- | --- | --- |
| RFC-134-T1 | shared oracle：`TaskQuestionRoleKind` + `'echo'`；纯函数 `planEchoEntries`（兄弟跳过=**交付感知+可渲染性、stampedIds 单值化**：入参含兄弟 `id`/`dispatchedAt`/`sealedAt`/`sourceKind` 快照 + 本批 stamp 集 + `batchTimestamp`（sealedAt 兜底在纯函数内定值，R7-F12）；历史 sealedAt-NULL 兄弟仍产 echo、同批 sealedAt-NULL 兄弟跳过——两分支分开锁，R3-F6 + R4-F8 + R6-F11）；`causeClassForEntry` 签名扩 `Pick<Row,'roleKind'\|'sourceKind'>` + echo 防御映射 | — | `shared/task-questions.ts`、`services/clarifyRerunLedger.ts`；测试 §8.1/8.2（先红后绿） |
| RFC-134-T2 | 写入点：`dispatchTaskQuestions` in-tx 落 echo（onConflictDoNothing、不入 mint/frontier/守卫、log）+ **seal 行戳归一化**（stamp 同事务补 sealedAt NULL 的 clarify 行，R5-F9）；两处守卫白名单加「豁免」注释（不改数组）；豁免非阻塞 + 同批异类绑定行为锁 + 归一化双投递回归（§8.5b） | T1 | `services/taskQuestionDispatch.ts`（+`clarifyAutoDispatch.ts` 注释）；测试 §8.3/8.4/8.6/8.7/8.9 |
| RFC-134-T3 | 生命周期 guard：confirm 放宽（echo 任意相位可 confirm，其余角色不变）；**stage 原子 CAS**（staged=true 改 `WHERE dispatched_at IS NULL` 条件更新、0 行→Conflict，un-stage 不动，R2-F4 + R3-F7）+ 并发 dispatch-vs-stage 回归；reassign/再下发 CAS 锁定测试 | T1 | `services/taskQuestions.ts`；测试 §8.8 |
| RFC-134-T4 | 注入层去重 + 端到端 + 兜底锁：`buildClarifyQueueContext` 按 (origin,question) 渲染去重、绑定全量（角色无关，Codex R2-F3，`AgentQueueEntry` 补 `questionId` 投影）；级联注入/绑定/老化 e2e；双渲染回归（pre-existing designer→questioner 节点 + echo 跨批）；`clarifyQueue.ts` 无 `'echo'` 字面量 + 守卫白名单不含 `'echo'` 双源码断言；RFC-099 隔离用例并入 | T2 | `services/clarifyQueue.ts`；测试 §8.5/8.9c/8.10/8.11/8.11b |
| RFC-134-T5 | 前端：回执卡（role 标签「回执/Receipt」、仅 confirm、无改派/stage）、过滤、i18n 中英、vitest | T1（类型） | `TaskQuestionList.tsx` + locales；测试 §8.12 |
| RFC-134-T6 | 收口：STATE.md 完工行 + plan.md 索引置 Done；门禁全绿（typecheck×3 / backend / vitest / lint / format / 单二进制 smoke）；push 后查 CI；Codex 实现 gate | T2-T5 | — |

依赖图：T1 → T2 → {T3, T4}；T5 与 T2-T4 并行（仅依赖 T1 类型）；T6 收口。

## 验收清单 → 测试映射

| AC | 测试（design §8） |
| --- | --- |
| AC-1 写入与不 mint | 8.3、8.4 |
| AC-2 注入无 echo 特判 | 8.5、8.11 |
| AC-2b 同题同目标去重 | 8.1（兄弟跳过）、8.9c |
| AC-3 序列化豁免 | 8.2、8.6、8.9、8.11b |
| AC-4 幂等 / reconcile 安全 | 8.3（重放）、8.7 |
| AC-5 范围黄金锁 | 8.1、8.4（未改派零 echo） |
| AC-6 相位 | 8.8 |
| AC-7 只读知会 | 8.8 |
| AC-8 未来耦合登记 | design §7 末行存在（文档断言，随 T6 收口核对） |
| AC-9 隔离 / 零 migration | 8.10 + 无新 migration 文件（journal 计数不动） |
| AC-10 前端 | 8.12 + 视觉对齐自查 |

## 风险登记

- **协作区重叠**：`clarifyRerunLedger.ts`（T1 触碰）当前有他人未提交改动 → T1 开工前 rebase；绝不删他人行。
- **枚举扩宽的隐性 switch**：全仓 grep `roleKind ===` / `role_kind` 排查穷尽点（board 过滤、DTO 校验、i18n）——T1 验收项。
- **零 migration 断言**：若实现中发现某处对 role_kind 有运行时白名单校验（zod enum 等），扩宽枚举即可，仍零 DB migration；journal 计数测试不动。
- **reopen 期货耦合**（Codex F2）：当前无打回实现；若后续任何 RFC 落地打回（就地改 answers_json / 改承接目标），**必须**按 design §7 末行联动 echo（重排队 / 改回即删），否则回执静默送旧答案。
