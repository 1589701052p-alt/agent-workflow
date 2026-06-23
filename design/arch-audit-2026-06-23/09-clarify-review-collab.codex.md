# Codex 核验：反问 / 评审 / 协作 (09-clarify-review-collab)

> 对应报告：`design/arch-audit-2026-06-23/09-clarify-review-collab.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- CRC-01 属实，P1 合理：`clarify_sessions` / `cross_clarify_sessions` / `clarify_rounds` 三表并存，且创建、提交、消费、清理都在手工双写：`packages/backend/src/db/schema.ts:888`、`packages/backend/src/db/schema.ts:941`、`packages/backend/src/db/schema.ts:1028`、`packages/backend/src/services/clarify.ts:216`、`packages/backend/src/services/crossClarify.ts:244`、`packages/backend/src/services/clarifyRounds.ts:97`。
- CRC-02 属实，P2 合理：cross 创建 round 时 `truncationWarningsJson: null`，但随后只 log warnings；选项截断确实仍可能发生：`packages/backend/src/services/crossClarify.ts:260`、`packages/backend/src/services/crossClarify.ts:268`、`packages/shared/src/clarify.ts:138`、`packages/backend/src/services/runner.ts:1102`。
- CRC-04 属实，P1 合理：scheduler 承载 prompt/context 真值表，`reviewContext`、`clarifyMode`、`isClarifyRerun`、`applyLatestDirective`、`effectiveHasClarifyChannel` 等门控集中在一段隐式状态机里：`packages/backend/src/services/scheduler.ts:1694`、`packages/backend/src/services/scheduler.ts:2126`、`packages/backend/src/services/scheduler.ts:2212`、`packages/backend/src/services/scheduler.ts:2222`、`packages/backend/src/services/scheduler.ts:2311`。
- CRC-05 属实，P2 合理：review supersede 的调度契约依赖 `errorMessage.startsWith(...)`：`packages/backend/src/services/review.ts:1733`、`packages/backend/src/services/review.ts:1759`、`packages/backend/src/services/dispatchFrontier.ts:65`。
- CRC-07 / CRC-08 属实：self legacy `buildClarifyPromptContext`、`computeRemaining`、title loader 等仍存在且与统一入口重复；title loader 确有 kind 白名单漂移：`packages/backend/src/services/clarify.ts:643`、`packages/backend/src/services/clarify.ts:759`、`packages/backend/src/services/clarify.ts:871`、`packages/backend/src/services/clarifyRounds.ts:333`、`packages/backend/src/services/clarifyRounds.ts:698`。
- CRC-09 属实，P2 合理：`submitClarifyAnswers` 明确不能用 async transaction，且 session flip 与 rounds flip 之间有 await，存在 torn-write 半态：`packages/backend/src/services/clarify.ts:393`、`packages/backend/src/services/clarify.ts:485`、`packages/backend/src/services/clarify.ts:501`。
- CRC-10 属实但应降为 P3/已知取舍：代码注释已说明 flip-first 窗口和“浪费重跑、不错误终态”的不变量：`packages/backend/src/services/crossClarify.ts:412`。
- CRC-11 属实，P3 合理：review 决策先逐条归档 doc/comment，再写输出和翻 node_run，缺事务；多文档半归档风险成立：`packages/backend/src/services/review.ts:1494`、`packages/backend/src/services/review.ts:1508`、`packages/backend/src/services/review.ts:1414`、`packages/backend/src/services/review.ts:1428`。
- CRC-12 / CRC-13 / CRC-14 属实：snapshot parse 分散、`sealAnswersServerSide` 反向 import、路由层按 snapshot node.kind 分流都存在：`packages/backend/src/services/review.ts:874`、`packages/backend/src/services/clarifyRounds.ts:694`、`packages/backend/src/services/crossClarify.ts:84`、`packages/backend/src/routes/clarify.ts:146`、`packages/backend/src/routes/clarify.ts:243`。

## REFUTED / 伪问题（给反证 file:line）

- CRC-03 中“cross-clarify 表单协作草稿没有实时同步广播”不成立。草稿保存走统一 route，按 `roundId + intermediaryNodeRunId` 保存并广播 `clarify.draft.updated`，前端 detail hook 按 nodeRunId 刷新，不区分 self/cross：`packages/backend/src/routes/clarify.ts:325`、`packages/backend/src/routes/clarify.ts:340`、`packages/backend/src/services/clarifyRounds.ts:745`、`packages/backend/src/services/clarifyRounds.ts:802`、`packages/frontend/src/hooks/useClarifyWs.ts:47`。
- CRC-06 不应表述为实现 bug；这是明确设计为 task 内节点级永久 stop。问题只剩“UI/文档是否足够明示”，不是代码语义错误：`packages/backend/src/services/crossClarify.ts:1022`。
- CRC-X6 “review comment 没有草稿同步层”事实成立，但严重级偏高。review comment 已是显式提交的评论实体，并有 add/delete/selection WS 同步；它不是 clarify draft 的同构场景：`packages/backend/src/services/review.ts:1177`、`packages/frontend/src/hooks/useTaskSync.ts:40`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- cross-clarify 消费 stamp 未按 `loopIter` 隔离 — High — `packages/backend/src/services/clarifyRounds.ts:132` / `packages/backend/src/services/clarifyRounds.ts:159` — designer/questioner 完成一次输出时，会把同 task、同节点、所有 loop_iter 的 answered cross Q&A 都标 consumed；但读路径按 loopIter 过滤，语义明显要求隔离：`packages/backend/src/services/clarifyRounds.ts:242`、`packages/backend/src/services/clarifyRounds.ts:274`。这会让后续 loop 轮次的 External Feedback / questioner Q&A 被提前老化丢失。
- `buildQuestionerCrossClarifyContext` 也是 legacy 死代码，报告只点了 self 侧 — Medium — `packages/backend/src/services/crossClarify.ts:1203`、`packages/backend/src/services/clarifyRounds.ts:10` — 统一 `buildPromptContext` 已替代 self + cross-questioner，但 cross legacy builder 仍保留，扩大测试/维护误导面。
- task detail 通用 WS hook 未处理 `cross-clarify.*` — Low — `packages/frontend/src/hooks/useTaskSync.ts:64`、`packages/backend/src/services/crossClarify.ts:1519` — clarify 专页会刷新，但任务详情通用同步只认 `clarify.created/answered`；cross answer/reject 后 task/node-run 刷新更多依赖 node.status/task.status 旁路事件，体验一致性弱。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告总体方向对：先收敛写入口和 prompt 决策，再考虑大抽象。优先级应调整为：

1. 先修真实 bug：cross truncation 持久化、cross consumed stamp 加 `loopIter`、clarify/review 多表写事务化。
2. 再做低风险收敛：删除 legacy prompt builders、统一 snapshot loader、把 `sealAnswersServerSide` 移到 shared。
3. 最后才做 `HumanGateInteraction` / `PromptFragment[]`。这两个目标形态有价值，但现在一次性抽象 self/cross/review 容易过度设计；review 的决策模型和 clarify 的 Q&A 模型并不完全同构。

重构必须保护三条不变量：RFC-097 task status 只能走 CAS/转移表；RFC-099 attribution/draft 不能进 prompt；opencode env 合并优先级不能被 runner 参数重构顺手改掉。

## 总评（sound / mostly-sound / flawed + 一句理由）

mostly-sound。报告抓住了主要架构债和多个真实缺陷，但把少数有意设计/产品差异当成问题，并漏掉了 cross-clarify consumption 未按 loop_iter 隔离这个更直接的正确性 bug。
