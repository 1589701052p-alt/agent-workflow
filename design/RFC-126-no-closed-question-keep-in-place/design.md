# RFC-126 — 技术设计（option A）

## 0. 决策

| # | 决策 | 取舍 |
|---|------|------|
| D1 | **CR-1 neuter 为 no-op**（`checkCR1` 改为**无参** `(): LifecycleInvariantFinding[] => return []`：不再 abandon、不再发告警；调用点改 `checkCR1()`），**保留其在 `INVARIANT_RULES` + 修复注册表的注册**。**lint 干净**：无参→无 unused 参数；删 CR-1 退役后变 unused 的 import（仅当某 import 仅 CR-1 用；多数与其它不变量共用、保留）——CI `bun run lint --max-warnings=0`（Codex P2#2） | 比全删更优：① 历史 CR-1 open 告警仍被 `reconcileLifecycleAlerts` 视为"本扫描已不存在"→ 自动 resolved；② 不动 `INVARIANT_RULES`/编译守卫/repair 注册约束 → hotspot 改动面最小。代价=一条永不触发的 rule + 死 repair（注释标明、无害）。全删留后续 hygiene。 |
| D1.5 | **加一个极小数据 migration：存量 `abandoned` → `answered`**（`crossClarifySessions` + `clarifyRounds`，清 `abandonedAt`） | Codex P2#1：否则历史 abandoned 行回落 pending/staged 后**看着可操作、却发不出去**（prompt builder 仍只认 answered → 暂存/下发会 no-op 或 mint 无答案的重跑）。un-abandon 后这些行变 answered → 可投递、resume 能正常消费（= "留在原地"的正解），且 deriveQuestionPhase 此后**永不再遇 abandoned**。**数据 migration、非 schema**（枚举不删）。一并把存量 open `rule='CR-1'` lifecycle_alert 标 resolved。 |
| D2 | **移除 `closed` 相位**：`deriveQuestionPhase` 删 abandoned/canceled→closed 早返回；type/`PHASE_ORDER`/`PHASE_KIND`/i18n/各 `phase!=='closed'` 守卫一并去（abandoned 经 D1.5 migration 已无、canceled 经 D2.5 reconcile 跳过 → 二者都不会再到 `deriveQuestionPhase`） | 看板无「已关闭」列 |
| D2.5 | **reconcile 跳过 `canceled`/`abandoned` 轮**（`reconcileTaskQuestionsForRound` 开头 `if (round.status==='canceled'\|\|round.status==='abandoned') return`，不建条目） | Codex P2#2：终态/中止轮不上看板 → 无 actionable 暂存/下发 UI。`canceled` 当前无写入点但 schema 允许（RFC-023 任务取消路径预留）+ C1 读它 → 防御处理；`abandoned` 经 migration 已无、再防御一层。**self/cross 一致**：取消/放弃的轮都不产承接条目。 |
| D3 | **保留** `abandoned`/`canceled` DB 枚举 + abandoned 死读分支 + 反问页 abandoned chip | 零 migration、兼容历史 abandoned 行、收窄改动面（hygiene 清理留后续） |
| D4 | 复现测试 RED→GREEN；删 CR-1 abandon/repair 专测；改 phase 测试 closed 断言 | test-with-every-change |

## 1. 修数据丢失：CR-1 neuter（G1/G2）

`services/lifecycleInvariants.ts` `checkCR1`（490-571）：现在 task=failed 时把"答了未消费"的跨节点轮 dual-write 成 `abandoned`（:546-555）+ push CR-1 finding（:557-568）。

**改为**：函数体直接 `return []`（保留签名、保留 :100 `INVARIANT_RULES` 注册 + :746 调用点 + repair 注册）。加注释：
```ts
// RFC-126: CR-1 no longer abandons answered-but-unconsumed cross rounds. The
// 'abandoned' upgrade assumed the failed task would never run again, but resume
// re-runs the designer — abandoning silently DROPPED the human's answer on resume
// (data loss). Leaving the round 'answered' lets resume re-consume it. Kept
// registered (no-op) so legacy CR-1 alerts still auto-resolve via reconcile.
return []
```
- **效果**：failed 任务的已答轮**保持 `answered`** → resume 时 `evaluateDesignerRerunReadiness` / `buildExternalFeedbackContext` 照常把它当 answered 源喂给设计者（既有 RFC-056 路径，逐字不变）→ **不丢**。
- **历史 CR-1 告警**：`reconcileLifecycleAlerts`（CR-1 仍在 `ownedRules`）下一扫描见 CR-1 无 finding → 将历史 open CR-1 告警标 resolved（干净收尾）。
- **历史 abandoned 行**（部署前已存在的）：由 **D1.5 migration un-abandon 回 `answered`**（不是"不回滚"——Codex P2#1）→ 变可投递、resume 能消费；migration 后运行期再无 abandoned 行。

## 2. 移除 `closed` 相位（G3）

### 2.1 shared（`packages/shared/src/task-questions.ts`）
- `TaskQuestionPhase`（:42-48）删 `'closed'` 成员。
- `deriveQuestionPhase`（:151-155）**删早返回** `if (roundStatus==='canceled'||'abandoned') return 'closed'`。→ 任何轮（含历史 abandoned/canceled）**回落正常派生**：confirmed→done / 有承接 run→processing|awaiting_confirm / 否则 pending|staged。即"停在自然相位"。

### 2.2 backend（`services/taskQuestions.ts`）
- `:731` `if (phase === 'done' || phase === 'closed')` → `if (phase === 'done')`（reassign 终态守卫；closed 不再存在）。

### 2.3 frontend
- `components/tasks/TaskQuestionList.tsx`：`TaskQuestionPhase`（:27-34）删 `'closed'`；`PHASE_ORDER`（:77-84）去 `'closed'`；`PHASE_KIND`（:86-93）去 `closed` 键；`:263`/`:345` 的 `e.phase !== 'closed'` 守卫去掉（只留 `!== 'done'`）。
- `components/clarify/ClarifyQuestionHandler.tsx:54` + `routes/tasks.detail.tsx:656`：`phase !== 'done' && phase !== 'closed'` → `phase !== 'done'`。
- i18n：删 `taskQuestions.phase.closed`（`zh-CN.ts:5141` 已关闭 + `en-US.ts` 对应 + 类型接口里的 `closed: string`）。

> `TaskQuestionPhase` 在 shared + frontend 各有一份（DTO 镜像），两处同步删 `'closed'`，typecheck 兜底全引用点。

## 3. 保留为死代码（D3，本 RFC 不动）
- `crossClarify.ts` 的 abandoned 跳过分支（`evaluateDesignerRerunReadiness:782`、`buildExternalFeedbackContext` 注释）：对历史 abandoned 行仍正确（跳过），新任务永不产生 → 安全死。
- 反问页 abandoned chip（`clarify.detail.tsx:757-766`）/ `clarify.tsx` abandoned 显示 / `CrossClarifyNode` 状态色 / i18n `crossClarify.abandoned*`：只在 status==='abandoned' 时渲染 → 新任务永不出现、历史行仍正确。
- CR-1 repair（`lifecycleRepair/options-CR1.ts` + 注册）：CR-1 无 finding → 永不触发，死但有效。

## 4. 失败模式 / 边界
| 点 | 处理 |
|----|------|
| 历史 abandoned 行（部署前） | migration（D1.5）un-abandon 回 `answered` → 变可投递、回落自然相位、resume 能消费（消除 Codex P2#1 的"可操作却发不出"）；deriveQuestionPhase 此后永不再遇 abandoned。 |
| 历史 open CR-1 告警 | CR-1 仍注册 → 下扫描自动 resolved（D1）。 |
| resume 一个有答未消费轮的 failed 任务 | 轮保持 answered → 设计者重跑消费（修复点）。 |
| 其它不变量 / self-clarify / questioner 级联 | 一字不动（CR-1 是 cross-only、与它们正交）。 |

## 5. 测试策略

### 5.1 RED→GREEN（核心修复锁）
- `cross-clarify-service.test.ts` 的 RFC-125-follow-up 复现测试：断言改/确认为 **resume 后 `buildExternalFeedbackContext` 仍含答案** + failed+CR-1 扫描后轮**仍 `answered`**（不再 abandoned）。由 RED 转 GREEN。

### 5.2 必更新/删除
- **删** `cross-clarify-abandoned-invariant.test.ts`（整文件锁 CR-1 abandon 行为，已不适用）。
- `lifecycle-repair-CR1.test.ts`：若用例靠 `runLifecycleInvariants` 产 CR-1 告警再修 → 改为手工插告警再测 repair，或随 CR-1 退役一并删（实现期定）。
- `lifecycle-invariants-current.test.ts`：RESOLVED/terminal 集合去 `abandoned`（CR-1 不再产）。
- `shared/tests/task-questions-phase.test.ts`（canceled/abandoned→closed，:46-59）：改为断言**回落自然相位**（不再 closed）。
- 看板/任意断言 `closed` 列的测试：去 closed。

### 5.3 不改判定即绿（golden-lock）
其它 7 条不变量测试、self-clarify、设计者重跑就绪/多源聚合、questioner stop 级联、RFC-070 消费戳、`migration-0031`（schema CHECK：保留 abandoned 合法）。

### 5.4 门槛
typecheck + `(cd packages/backend && bun test)` + 前端 vitest + format 全绿 → push → CI → Codex impl gate（隔离 worktree）。

## 6. Golden-lock 清单
| 锁 | 守法 |
|----|------|
| answered/awaiting_human 状态转移 | 不动 submit/create 路径 |
| 其它 7 条不变量（R1/R2/C1/T1/T2/T3/U1） | checkCR1 外一字不动 |
| self-clarify | CR-1/abandoned/closed 均 cross-only / 不涉 self |
| 设计者重跑就绪 + 多源聚合 + questioner 级联 | 不动 crossClarify 这些函数（仅 abandoned 死分支变不可达） |
| RFC-070 消费戳 aging | 不动 |
| abandoned/canceled schema 枚举合法 | 不删枚举（migration-0031 保持绿） |
