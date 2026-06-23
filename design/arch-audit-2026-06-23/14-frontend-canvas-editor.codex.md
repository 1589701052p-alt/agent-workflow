# Codex 核验：前端：工作流画布编辑器 (14-frontend-canvas-editor)

> 对应报告：`design/arch-audit-2026-06-23/14-frontend-canvas-editor.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **CANVAS-D1 / X1 / C1 / X5 属实，P1/P2 合理**：节点身份、默认值、端口、表单、特殊连线确实散落在 `WorkflowCanvas.tsx:100-112`、`nodePalette.ts:11-20`、`nodePalette.ts:58-151`、`WorkflowCanvas.tsx:1203-1346`、`NodeInspector.tsx:172-1196`；`NodeInspector` 反向 import `computePorts` 也属实（`NodeInspector.tsx:33`）。这是扩展成本问题，不是即时 bug。
- **CANVAS-X2 / T1 属实，P1 合理**：`onNodeDragStop` 的组合逻辑内联在 JSX 中（`WorkflowCanvas.tsx:1046-1145`），虽调用了纯 helper，但“拖停整链”本身没有独立断言面。
- **CANVAS-I1 属实，P2 合理**：CLAUDE 明确禁用裸 `<input className="form-input">`（`CLAUDE.md:72-74`），canvas 内仍有多处：`EditorSidebar.tsx:41-47`、`NodeInspector.tsx:290-318`、`NodeInspector.tsx:1442-1474`、`PromptPreview.tsx:72-77`、`EdgeInspector.tsx:97-109`。
- **CANVAS-X3 属实但重复项，P2 可接受**：wrapper kind 三元判断确实散落，例如 `WorkflowCanvas.tsx:1065-1068`、`wrapperMembership.ts:85-86`、`wrapperOps.ts:17-20`；`coordProjection.ts:31-35` 的注释也证明曾因漏 `wrapper-fanout` 出过问题。
- **CANVAS-X4 / T2 方向属实，且实际风险比报告说得更具体**：`draft` 是单一覆盖 state（`routes/workflows.edit.tsx:187`），远端 update invalidate 后 refetch，`useEffect` 会直接 `setDraft(healed)`（`routes/workflows.edit.tsx:217-233`）。
- **CANVAS-D4 属实，P3 合理**：前端本地 `ValidationIssue` 与 shared 的 `WorkflowValidationIssue` 重复定义（`routes/workflows.edit.tsx:457-464` vs `shared/src/schemas/workflow.ts:240-253`）。
- **CANVAS-X6 属实，P3 合理**：New/Edit 三栏布局重复（`routes/workflows.edit.tsx:142-169`、`routes/workflows.edit.tsx:416-452`）。

## REFUTED / 伪问题（给反证 file:line）

- **CANVAS-C2 的表述不成立，需改为“schema/类型过宽”而非“绕过判别联合”**：当前 `WorkflowNode` 正是 permissive base schema `.passthrough()` 推导出来的宽类型（`shared/src/schemas/workflow.ts:82-103`），不是严格判别联合；所以 `as Record<string, unknown>` 不是绕过已有联合收窄，而是类型模型尚未收紧。问题存在，但严重级应降为 P3 设计债。
- **CANVAS-D2 过度解读**：`node-kind-behavior.ts` 自称“Today: only retryCascade is consulted at runtime”，其他维度是未来 hook（`shared/src/node-kind-behavior.ts:15-21`）。canvas 未 import 该表属实，但不能据此说它已经违反一个现行前端单一事实源契约；建议降为 P3。
- **CANVAS-D3 应降级**：`design.md` M2 确实列了撤销重做/自动布局（`design/design.md:1576-1577`），但这是路线图未完成，不是当前实现回归；应归为 P3 product gap，而非 P2 架构问题。
- **CANVAS-I2 / I3 报告已自行推翻，复核同意**：`affectsDefinition` 排除 position/select/dimensions 有明确注释与拖停提交路径（`WorkflowCanvas.tsx:1470-1488`、`WorkflowCanvas.tsx:1046-1060`）；嵌套坐标投影也有绝对坐标再减直接父的设计与测试（`wrapper-coord-projection.test.ts:83-107`）。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **复制 wrapper 后 `nodeIds` 未重写 — High — `canvasClipboard.ts:74-94` + `wrapperOps.ts:51-61` — 粘贴出的 wrapper 仍引用原 child id；后续“delete with inner”可能删除原节点，属于数据破坏风险。**
- **复制 fanout 边丢失 `boundary` 元数据 — High — `canvasClipboard.ts:84-94` + `workflow.validator.ts:1304-1323` — 复制 wrapper-fanout 内外边时只拷贝 source/target，不保留 `boundary`，运行时 fanout 注入/聚合语义会丢。**
- **远端更新会静默覆盖本地 dirty draft — High — `useWorkflowSync.ts:47-55` + `routes/workflows.edit.tsx:217-233` — hook 注释说不自动 clobber unsaved drafts（`useWorkflowSync.ts:5-7`），但 route 在 refetch 后无 dirty guard 直接 setDraft，且 update toast 被禁用。**
- **wrapper-fanout 输入改名/删除不级联边 — Medium — `NodeInspector.tsx:661-667`、`NodeInspector.tsx:707-710`、`workflow.validator.ts:1317-1323` — output 节点改名会 sync edge，但 fanout inputs 只改数组；已有 boundary/source 或入边会停留在旧 port，保存/运行语义漂移。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的“注册表 + ConnectionStrategy + portInventory”方向基本正确，但建议收敛范围：不要一次把 `InspectorForm`、palette、runtime-like behavior 全塞进一个巨型 registry，否则会把 UI 组件、shared 类型、canvas reducer 绑成新 god-object。

更优拆法：先抽三层小事实源：`isWrapperKind/isProcessKind/promptCapable` 这类纯谓词；`portInventory.ts` 只管端口；`connectionStrategies.ts` 只管特殊连线的 classify/preflight/apply/cascade。UI 的 `NodeInspector` 可以后续按 kind 拆子组件，不必第一步进入 registry。

`commitChange` 带 intent 对 undo 有价值，但要谨慎：不要让前端 intent 成为后端任务语义来源。RFC-097 状态 CAS、RFC-099 prompt 隔离、opencode env 合并优先级都不应被 canvas 重构触碰；前端 intent 应只服务 editor history/redo，不进入 task launch snapshot 以外的运行时决策。

## 总评

**mostly-sound**：报告抓住了 canvas 编辑器的主要架构债，但有几处把路线图缺口/未来事实源说成现行违规，同时漏掉了 copy/paste wrapper 与远端 dirty draft 覆盖这类更直接的数据破坏风险。
