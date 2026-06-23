# Codex 核验：记忆 / 蒸馏 / 融合 (11-memory-fusion)

> 对应报告：`design/arch-audit-2026-06-23/11-memory-fusion.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **MEM-01 属实，P1 合理**：融合有转移表但写路径未使用；`setFusionStatus` 是裸 `UPDATE id`，无 `status IN allowedFrom` CAS。证据：`packages/backend/src/services/fusion.ts:70-82`、`packages/backend/src/services/fusion.ts:620-630`。`approve/reject/cancel/reconcile` 都是先读后写，确实背离任务状态机 CAS 约束。
- **MEM-02 属实，P2 合理**：`approveFusion` 先把 fusion 写成 `applying`，再调用 `commitSkillVersion`；状态写不在该事务里。`reconcileFusion` 只处理 `running`，孤儿 `applying` 无恢复。证据：`packages/backend/src/services/fusion.ts:640-709`、`packages/backend/src/services/fusion.ts:438-445`。
- **MEM-03 基本属实，但建议降为 P3/产品债**：注入确实只按 `createdAt DESC` 后用预算截断，不消费 category/tags。证据：`packages/backend/src/services/memoryInject.ts:111-165`、`packages/backend/src/services/memoryInject.ts:286-300`、`packages/backend/src/services/memoryDistiller.ts:87-141`。但 RFC-101 明确 N5 不改注入预算/渲染，短期不是实现 bug。
- **MEM-06 属实，P1 合理**：融合临时仓在 `appHome/fusions/{id}/iterN/work`，实现没有终态清理；设计却承诺 done/failed/canceled 后回收。证据：`packages/backend/src/services/fusion.ts:274-276`、`design/RFC-101-memory-skill-fusion/design.md:304`。
- **MEM-08 属实，P2 合理**：融合强制 self-clarify，`answerClarify` 对所有 clarify 无条件入蒸馏队列，未排除内置融合任务。证据：`packages/backend/src/services/fusion.ts:154-155`、`packages/backend/src/services/fusion.ts:231-253`、`packages/backend/src/services/clarify.ts:557-568`。
- **MEM-09 属实但已知，P3**：restore 跨融合版本往返会清掉溯源后无法自动重融，设计 OQ-6 已记录。证据：`packages/backend/src/services/memory.ts:633-662`、`design/RFC-101-memory-skill-fusion/design.md:439`。
- **MEM-10 属实，P3**：runner latch 空 `sessionID`，distiller 有 `candidate.length > 0` 守卫，两份抽取逻辑漂移。证据：`packages/backend/src/services/runner.ts:879-891`、`packages/backend/src/services/memoryDistiller.ts:1127-1145`。
- **MEM-11/MEM-12 基本属实，级别可降**：`fusion.ts` 是强耦合 orchestrator，且 `memory.ts` 中段 import 确实存在。证据：`packages/backend/src/services/fusion.ts:13-15`、`packages/backend/src/services/fusion.ts:35-42`、`packages/backend/src/services/memory.ts:676-692`。这是维护性问题，不是当前行为 bug。
- **MEM-13 属实**：测试覆盖 happy path/OCC/manifest/纯状态函数，缺并发 approve、reconcile/cancel race、孤儿 applying 回归。证据：`packages/backend/tests/fusion-engine.test.ts:114-279`。

## REFUTED / 伪问题（给反证 file:line）

- **MEM-04 作为当前 P2 问题被夸大**：单 daemon / 单进程 worker 是明确架构约束，不是隐藏假设。证据：`CLAUDE.md:180-181` 写 daemon 为 single Bun process + flock；调度器注释也明示不 lease、单 in-process worker：`packages/backend/src/services/memoryDistillScheduler.ts:10-12`。可作为 HA 前置债记录，但不是现状 bug。
- **MEM-07 中“clarify 收件箱泄漏”不成立**：RFC-101 设计就是复用 `/clarify` 完成强制反问，前端融合详情页也明确“running 时指向 clarify inbox”。证据：`design/RFC-101-memory-skill-fusion/design.md:288-292`、`packages/frontend/src/routes/fusions.detail.tsx:1-4`。  
  但“融合底层 task 会出现在普通 task list”这半句有证据：`listTasks` 未过滤内置 workflow，见 `packages/backend/src/services/task.ts:1471-1510`；这更像 UI 噪音/归类问题，而不是 clarify 设计泄漏。
- **MEM-05 只能算可配置性取舍**：prompt 硬编码属实，但注释明确把源码内 prompt 作为可 review/grep-locked 的设计选择。证据：`packages/backend/src/services/memoryDistiller.ts:70-81`。在没有部署级定制需求前，不应列成高优先级架构问题。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **内置融合资源可被同名用户资源 shadow / stale 后不会自愈 — P1 — `packages/backend/src/services/fusion.ts:182-210`, `packages/backend/src/services/fusion.ts:263-267`, `packages/backend/src/services/systemResources.ts:12-22`, `packages/backend/src/services/systemResources.ts:45-47` — `seedFusionResources` 和 `fusionWorkflowId` 只按 name 查找，未校验 `ownerUserId === __system__`；这正好违反 `systemResources.ts` 自己写下的 name+owner 内置判定。用户若先有同名 workflow/agent，融合可能跑错资源；系统资源 body/definition 漂移也不会被 upsert 修复。**
- **融合审批 ACL 未按设计复检技能写权和记忆管理权 — P1 — `packages/backend/src/services/fusion.ts:141-143`, `packages/backend/src/services/fusion.ts:640-647`, `design/RFC-101-memory-skill-fusion/design.md:312-320` — 设计要求 apply 前复检 skill write + 每条 memory can-manage；实现只看 fusion owner/admin。权限在发起后被撤销、技能归属变化、记忆 scope 权限变化时，旧 fusion owner 仍可 approve。**
- **collaborator 可参与任务 clarify，却不能查看/审批 fusion — P2 — `packages/backend/src/services/fusion.ts:395-405`, `packages/backend/src/routes/fusions.ts:93-99`, `packages/backend/src/services/fusion.ts:141-143`, `design/RFC-101-memory-skill-fusion/design.md:362-367` — `createFusion` 把 collaborator 传给 task，但 fusion API 只允许 owner/admin；设计表写的是“任务成员”。会造成协作者能回答融合反问，却无法完成审批闭环。**
- **createFusion 先启动任务再写 fusions 行，失败会遗留无主内置任务 — P2 — `packages/backend/src/services/fusion.ts:376-405`, `packages/backend/src/services/fusion.ts:407-422` — task 已创建/可能已调度后才插入 fusion row；若插入失败或进程崩溃，会留下没有 fusion 记录可管理/回收的 engine task 和临时仓。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的优先级排序大体正确：先补 **CAS、融合临时仓 GC、内置任务蒸馏排除、apply 原子性/恢复**，再谈 registry 和抽象。

但它对“融合不再伪装成任务”的目标形态偏重构化。RFC-101 明确把复用 task/scheduler/runner/clarify 作为设计目标：`design/RFC-101-memory-skill-fusion/design.md:9-10`。更稳的路径不是立刻抽 `runAgentInEphemeralRepo` 大 primitive，而是先把复用契约补齐：任务列表归类/隐藏、蒸馏入口排除 built-in workflow、临时仓 GC、融合状态 CAS、内置资源 name+owner 校验。这样不会破坏 RFC-097 任务 CAS，也保留 RFC-099 prompt 隔离和现有 opencode env 合并路径。

source-kind/scope-kind registry 建议方向合理，但不是第一阶段。当前更紧急的是把“系统资源身份”和“融合审批权限”这两条安全边界补牢；否则 registry 化只是把不安全行为模块化。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound** — 多数源码证据成立，尤其融合 CAS、GC、递归蒸馏；但报告把部分有意设计误判为泄漏/问题，并漏掉了内置资源 shadow 与审批 ACL 复检这两处更硬的安全/正确性缺陷。
