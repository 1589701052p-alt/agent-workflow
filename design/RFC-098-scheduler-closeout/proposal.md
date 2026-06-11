# RFC-098 — 调度子系统收尾：剩余工作包（WP-5/6b/6c/6d/8/9/10）合并实施

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线剩余全部工作包，按用户
> 指示合并为单 RFC。触发：2026-06-12 用户「继续完成剩余任务，合并一个 RFC」。
> 落档前已做五分域并行普查（`survey.md`，全部 file:line 实证 + FLIP/保绿清单 + 可行性实验）。

## 背景与范围

WP-1/2/3/4/6a/7 已分别以 RFC-092~097 完成。本 RFC 覆盖剩余六包（对应审计正文 11 个 S 条目 +
3 个缺口/限制项）：

| 批  | 工作包      | 条目                                              | 一句话                                                                                                                                                                                                                                                                                       |
| --- | ----------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | WP-5        | S-9 / S-17 / S-24 / ⑥-10 / C-9                    | 任务级写锁注册表（HTTP 回滚与调度同把锁）；写者锁序反转（readonly 不再被排队写者饿死）；commit&push 移出派发循环；git wrapper diff 套锁 + 空 catch 改 failed；三处 out-of-band 回滚接共享多仓回滚                                                                                            |
| B2  | WP-9 + WP-8 | S-11 / S-15 / 缺口 S5                             | 快照 ref 钉住 + fail-closed 回滚 + resume 升级任务级错误；SIGTERM→SIGKILL 升级 + 进程组杀（Bun detached 已实测）+ 有界收尾 + pid 存活检查接入收割/恢复 + stuck S5 规则                                                                                                                       |
| B3  | WP-6b/6c/6d | S-19/20/21、S-7/S-4/S-3、S-28/⑥-11 + RFC-092 限制 | fanout 恢复幂等（跨代 shard 复用 + value hash + aggregator 复用与 done 过滤）；loop/git wrapper 写 consumed、git pre-脏集扣除（顺序双 wrapper 与 git-in-loop 一并修）、approve-in-wrapper 复活 + wrapper 内 clarify mid-run 解锁；wrapper pending→running 一致化、⑥-11 wrapper 行 retry 续跑 |
| B4  | WP-10       | S-16 / S-25                                       | mintNodeRun 工厂收敛 13 处裸铸行（先纯重构）；migration 加 `rerun_cause` 列，clarify 注入门控改 switch(cause)，拆 crossClarify retryIndex hack                                                                                                                                               |

## 目标（用户可见效果）

1. 任务运行中答题/决策触发的回滚不再可能清掉并行写者的半成品（同把任务写锁）；多仓任务的
   clarify/review/cross-clarify 重跑前回滚真正逐仓生效。
2. Code→Audit→Fix 主场景里 readonly 审计节点真并行（不再被排队写者占满槽位）；开
   autoCommitPush 不再冻结派发。
3. fanout 失败重试只重跑失败的 shard；重启后上游内容变了的 shard 会重跑而不是按位回放旧输出。
4. 上游 clarify/review 重跑后，loop/git wrapper 正确判 stale 重做；两个先后 git 阶段、
   git-in-loop 各迭代的 diff 互斥不再累计；loop 内 review approve 后任务自动推进（含 mid-run）。
5. 搁置两周后 resume 不再静默丢未提交状态（快照被 gc 时 fail-closed 报 `snapshot-lost`，
   工作区不被破坏）；不合作的 opencode 进程树在宽限后被整组收割，挂死有 S5 告警。
6. rerun 成因持久化为 `rerun_cause` 列——历史上吃掉 scheduler 58% fix 的"代理信号反推成因"
   门控改为直接 switch，结构性封死该回归类。

## 非目标

- 不动 fanout 失败语义（v1 fail-all-after-join 已按 RFC-094 方案 A 定版；errors port 仍 deferred）。
- 不做 clarify 三表收敛单表（原始队列独立项；WP-10 的 cause 列为其铺路但不动表结构）。
- 不做 gc.ts 多仓改造与 TERMINAL 收紧（审计缺口 3 同族另立；WP-9 的 ref 清理只挂单仓路径并注明）。
- 不动 limits 墙钟（缺口 ⑥-1）、orphans 收割语义（缺口 5 任务侧已在 RFC-097 关闭，节点侧锚点行保留问题留待后续）。
- wrapper 整体重跑时 worktree 残留无回滚（wrapper 行不抓 preSnapshot）——S-7 修复后的已知开放点，记录不修。

## 实施与验收

单 RFC、**四批 commit**（B1→B4，每批门禁全绿 + CI 绿后进下一批；plan.md 明细）。验收 = 各批
FLIP 的 audit 锁定翻转 + survey.md 列明的保绿清单 + 新 oracle（survey 各分域 §测试面）全绿；
全程 lint + typecheck + 根 bun test + format + build:binary + CI。

关键既有锁定翻转面：s17 / s11 / s15 / s03 / s04 / s07（S-7 半边）/ s07-s28（S-28 半边）/
s18-s19（test 2）/ s21 / cross-clarify-designer-retry-index（hack 拆除）/ git-snapshot（先销毁
后报错改写）/ retry-cascade-kind-matrix（⑥-11 方案 A 钉点）。
