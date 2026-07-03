# RFC-139 任务分解

单 PR（直接 push main，按仓惯例），commit 前缀 `fix(clarify): RFC-139 反问收场的承接 run 关闭改派台账`。

## 子任务

### RFC-139-T1 判定改动 ①② + 注释随动

- 改动 ①：`clarifyRerunLedger.ts` bound 分支：`return mode === 'in-flight' ? true :
  hr.hasOutput` → `return true`（done 即消费，两 mode 在 bound 分支合流）。
- 改动 ②（同锚合流，design §3b）：`taskQuestionDispatch.ts` `LedgerResolution` 增
  `anchorRunIds: Set<string>`（open bound 条目的 trigger 集；queued 不产锚），两本台账函数
  填充；`resolveBorrowForNode` reject 条件改为「open 台账数 >1 且锚集不相交（含任一为空）」。
- `clarifyRerunLedger.ts` `LedgerOpenMode` 注释（:41-54、:76-85）改写：mode 分歧收窄到 queued
  分支；失效的 RFC-127 测试引用更新为本 RFC + rfc133 case 8。
- `taskQuestionDispatch.ts` resolveBorrowForNode 大注释两处「outputless => keep borrowing」
  措辞随动 + P2-2 reject 注释补合流豁免语义。
- 依赖：无。

### RFC-139-T2 测试（与 T1 同 commit，test-with-every-change）

- 新增 `packages/backend/tests/rfc139-clarify-ask-closes-ledger.test.ts`：
  design.md §6 的 1（纯函数矩阵）/ 2（pre-bind 主回归，先红后绿）/ 3（post-bind
  failed+interrupted 变体，先红后绿）/ 4（对称 case）/ 5（真冲突双 queued + 异链 bound 仍
  reject）/ 6（混合 ride 放行）。
- 翻转 `rfc133-queued-run-obligation.test.ts` case 8 `:159` 断言 + 注释改写（§6.7）。
- 确认零修改跑绿：rfc128-p5-bc 双台账三例、rfc133 矩阵 case 1-7、rfc127 两文件。
- 依赖：T1。

### RFC-139-T3 收口

- `design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 顶部进行中行改已完成摘要。
- 门禁：`bun run typecheck && bun run test && bun run format:check` + `bun run build:binary`
  smoke；push 后查 GitHub Actions。
- Codex 实现门评审（feedback_codex_review_after_changes），findings 修完才算交付。
- 本机手动验收（proposal 验收 6）：重试 QMGP5 `agent_m7p3n1` 节点，确认任务续跑、双份 Q&A 注入。
- 依赖：T1、T2。

## 验收清单

- [ ] `resolveBorrowForNode` 在 QMGP5 pre-bind 形态（designer bound→done-no-output + self
      queued + pending rerun）返回 null 不抛
- [ ] post-bind 形态（两本账 bound 同一 failed/interrupted run + revival pending）返回 null
      不抛（同锚合流）
- [ ] 真冲突仍抛 `task-question-borrow-ledger-conflict`：双 queued（∅ vs ∅）+ 异链 bound
      （{X} vs {Y}）
- [ ] failed / interrupted / pending / running 承接 run 台账仍 open
- [ ] `'in-flight'` 门全矩阵零变化
- [ ] rfc133 case 8 锁按新语义翻转、其余断言逐字不动
- [ ] 三门禁 + binary smoke + CI 绿
- [ ] QMGP5 本机重试走通
