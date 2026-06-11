# RFC-098 — 任务分解

单 RFC、**四批 commit 串行推进**（每批门禁全绿 + push + CI 绿后进下一批；commit 前缀统一
`fix(backend): RFC-098 B<N> <批标题>`）。survey.md 各分域 §测试面为各批操作手册。

## B1 — 写锁与并发（WP-5 + ⑥-10 + C-9 记录）

- taskWriteLocks.ts 注册表 + scheduler 接线 + 三处 HTTP 回滚接 rollbackNodeRunWorktrees
  （loadRollbackTarget + 返回值升级 {attempted, failures}）。
- 三取锁点锁序反转；commit&push 移出派发循环（synthetic in-flight）。
- S-24 套锁 + 空 catch 改 failed。
- 测试：s17 翻转；新增 S-9 oracle（HTTP 回滚 vs 在飞写者互斥）、S-24 oracle（diff 失败 →
  wrapper failed；并发 writer 时 diff 等锁）；保绿网照 survey。

## B2 — 快照与进程（WP-9 + WP-8）

- gitStashSnapshot pinRef + rollbackToSnapshot fail-closed('snapshot-missing') + resume/retry
  升级 snapshot-lost + gc.ts ref 批删。
- runner detached + killTree + SIGTERM→SIGKILL 升级 + 有界收尾 + pid 治理接入 reap/resume +
  stuck S5（含 shared 类型涟漪与 S5 acknowledge option）。
- 测试：s11 / s15 / git-snapshot 翻转；stubborn-opencode fixture + 组杀/墙钟 oracle；pin 存活
  - ref 清理 + snapshot-lost 升级 oracle。

## B3 — wrapper 语义簇（WP-6b + 6c + 6d）

- 顺序：S-7（consumed + 两个共享抽取）→ S-4（preDirty 案 A + design.md §6.5 同步）→
  S-3/RFC-092 限制（wrapperRevivalEvidence 案二）→ S-19/20/21（migration 0043 + 锚放宽 +
  pickReusableShardRun + consumed 代际门 + aggregator 复用）→ S-28（mark-running + 广播后移 +
  markWrapperTerminal 收紧）→ ⑥-11（方案 A）。
- 测试：s03/s04/s07（S-7 半边）/s07-s28（S-28 半边）/s18-s19 test2/s21/retry-cascade-kind-matrix
  翻转；rfc095-wrapper-canceled-revival 补 wrapper-行目标 RED；approve-inside-loop/git e2e +
  mid-run wrapper clarify e2e + 上游变更 shard 重跑 oracle；保绿网照 survey（rfc040 baseline
  闸、duplicate-shards 同代口径、dispatch-frontier N2 等）。

## B4 — 铸行与成因（WP-10）

- T-a mintNodeRun 工厂 + 13 处迁移 + grep guard（纯重构，全量回归网为界）。
- T-b migration 0044 rerun_cause + 工厂落库 + migration 测试。
- T-c 门控四点 switch(cause) + (consumerKind×cause) 真值表。
- T-d 拆 crossClarify retryIndex hack（designer-retry-index 测试翻转）。

## 收尾

- design/plan.md 置 Done；STATE.md 登记；调研报告附录补「全部 WP 完成」收官注记；记忆更新。
- 每批门禁：lint + typecheck + 根 bun test + format:check + build:binary；推送后查 CI。
