# RFC-007 Plan — Canvas review / output 拖拽连线实施计划

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 策略：**单 PR**。所有改动集中在 `packages/frontend/`，零 backend / shared / DB / runtime 改动。

## 1. 子任务

### RFC-007-T1：新建 connectionSync 纯函数模块

**文件**：

- `packages/frontend/src/components/canvas/connectionSync.ts`（新建）

**做什么**：

1. 导出常量 `REVIEW_INPUT_HANDLE_ID = '__review_input__'`。
2. 导出 4 个纯函数（签名见 design.md §4）：
   - `applyConnectionForReviewOutput(def, edge) → next def`
   - `applyDisconnectForReviewOutput(def, deletedEdges[]) → next def`
   - `syncEdgeFromFormField(def, target, prev, next) → next def`
   - `healFieldEdgeConsistency(def) → next def`
3. ref-equality 短路：所有函数在 "无实质变化" 时返回原 `def` 引用，让上游 React 用 `===` 判定不脏写。
4. 不引入任何 React / xyflow 依赖；仅依赖 `packages/shared/src/schemas/workflow.ts` 的类型与 `review.ts` 的 ReviewNode 形状。

**Size**：S（≈ 120 行 TS，4 函数 + 一些 helper）

**Deps**：—

**Output**：单文件；构建 / typecheck 全绿。

### RFC-007-T2：ReviewNode 新增左侧 target Handle + 注释更新

**文件**：

- `packages/frontend/src/components/canvas/nodes/ReviewNode.tsx`

**做什么**：

1. 顶部注释删除 "Catch-all inbound strip is intentionally off..."，替换为 "Single named target Handle `__review_input__` accepts the review's input edge; the canvas connect handler writes both the edge and `inputSource` (see RFC-007)."。
2. 引入 `Handle, Position` from `@xyflow/react` 与 `REVIEW_INPUT_HANDLE_ID` from `../connectionSync`。
3. 在 `<div className="canvas-node canvas-node--review">` 子树里，`<PortHandles side="right">` 之前 inline 一个：
   ```tsx
   <Handle
     type="target"
     position={Position.Left}
     id={REVIEW_INPUT_HANDLE_ID}
     className="canvas-node__handle canvas-node__handle--review-input"
     aria-label="review-input"
   />
   ```
4. 不动 PortHandles 调用、不动 inputSource 显示逻辑、不加新 prop。

**Size**：XS（≈ 10 行改动）

**Deps**：T1（要 import 常量）

**Output**：单文件；视觉上 review 节点左侧多一个 8px dot，连边可落上。

### RFC-007-T3：WorkflowCanvas 接入 connect / disconnect / isValidConnection

**文件**：

- `packages/frontend/src/components/canvas/WorkflowCanvas.tsx`

**做什么**：

1. 顶部 import `applyConnectionForReviewOutput`、`applyDisconnectForReviewOutput` from `./connectionSync`。
2. 改 `handleConnect`（line 239-247）：在 commitChange 前先经 `applyConnectionForReviewOutput`，详见 design §5.1。
3. 改 `onEdgesChange` 路径：删除事件触发时收集被删边，commitChange 前经 `applyDisconnectForReviewOutput`，详见 design §5.3。
4. 加可选 prop `taskContext?: { reviewIteration: Record<string, number> }`，并实现 `isValidConnection`（design §5.2）。editor canvas 不传，task 详情 canvas 由 `tasks.detail.tsx` 传入。
5. 不动 RFC-003 的 `translateInboundConnection`、不动 `buildEdgeFromConnection`。

**Size**：S（≈ 40 行改动 + 1 个新 callback）

**Deps**：T1

**Output**：connect / disconnect 全走 connectionSync；task 详情画布拖拽连边在 iterate review 上被拒。

### RFC-007-T4：NodeInspector 表单写回边

**文件**：

- `packages/frontend/src/components/canvas/NodeInspector.tsx`

**做什么**：

1. review 分支 `inputSource.nodeId` / `.portName` 输入框的 onChange：先经 `syncEdgeFromFormField` 算出新 definition，再调 `onCommitDef(next)`。
2. output 分支每个 port 的 `bind.nodeId` / `bind.portName` 同样处理。
3. iterate 态提示：检测 `taskContext.reviewIteration[node.id] > 0`（如果 NodeInspector 有这个上下文）→ 在 inputSource 字段下方加一条灰字 i18n key `inspector.review.iterateTargetLockHint`（中文："iterate 中，更换评审目标不会影响本次任务"）。
4. 不改字段渲染、不改其他 review 12 字段、不改 output 其他 UI。

**Size**：S（≈ 30 行改动）

**Deps**：T1

**Output**：表单改一笔字段，画布上的边跟着重连。

### RFC-007-T5：workflows.edit.tsx 接入 healFieldEdgeConsistency

**文件**：

- `packages/frontend/src/routes/workflows.edit.tsx`

**做什么**：

1. import `healFieldEdgeConsistency` from `../components/canvas/connectionSync`。
2. 在 `healLoadedDefinition`（RFC-004 既有）尾部追加 `def = healFieldEdgeConsistency(def)`。
3. ref-equality 短路天然兼容既有 dirty 判定逻辑：若 `def !== prev` 则触发 1s auto-save。
4. 不动 RFC-004 既有 inputs[] heal。

**Size**：XS（≈ 5 行改动）

**Deps**：T1

**Output**：打开老 workflow 自动补边或补字段，1 秒后 auto-save 写回 DB。

### RFC-007-T6：注释 / schema 文案同步

**文件**：

- `packages/shared/src/schemas/review.ts`（line 47-49 注释更新）

**做什么**：

1. 删除 "Catch-all edges in canvas (RFC-003) feed the input"，替换为 "A single named target Handle `__review_input__` on the canvas feeds the input; connect/disconnect/form-edit keep `inputSource` and the matching edge in sync (RFC-007)."。
2. **不改 schema 字段**。仅注释。

**Size**：XS（≈ 3 行改动）

**Deps**：—

**Output**：schema 文档与实现一致。

### RFC-007-T7：单元测试 — connectionSync 纯函数

**文件**：

- `packages/frontend/tests/connection-sync.test.ts`（新建）

**做什么**：

按 design.md §8.1 逐条写 18 个 case：

- `applyConnectionForReviewOutput` × 6 case
- `applyDisconnectForReviewOutput` × 4 case
- `syncEdgeFromFormField` × 4 case
- `healFieldEdgeConsistency` × 5 case（双向 + ref-equality + 冲突取边为准）

文件顶部注释链回 RFC-007 design.md §8.1，说明每条 case 锁的回归点。

**Size**：M（≈ 250 行测试）

**Deps**：T1

**Output**：vitest 18 case 全绿。

### RFC-007-T8：集成测试 — Canvas 连接路径

**文件**：

- `packages/frontend/tests/canvas-review-output-drag.test.tsx`（新建）

**做什么**：

按 design.md §8.2 写 5 个 case：

1. connect 到 `__review_input__` → spy 收到 next def 包含新边 + inputSource。
2. 二次 connect 不同源 → 边总数不变 + inputSource 切换。
3. connect 到 output `final_doc` → port.bind 写入。
4. onEdgesChange 删除入边 → 字段清空。
5. iterate 态 isValidConnection 返回 false。

走 React Testing Library 渲染 `<WorkflowCanvas>` + 直接调 props `onConnect` / `onEdgesChange`（不真拖拽 DOM，JSDOM 限制）。

**Size**：M（≈ 200 行测试）

**Deps**：T2, T3

**Output**：5 case 全绿。

### RFC-007-T9：扩展 canvas-edit-old-workflow 测试

**文件**：

- `packages/frontend/tests/canvas-edit-old-workflow.test.ts`（既有，RFC-004 落地）

**做什么**：

按 design.md §8.3 加 3 新 case：

1. review inputSource 有 + edges 空 → heal 补边。
2. output port.bind 有 + edges 空 → heal 补边。
3. YAML 导入路径：edges 有 + 字段空 → heal 写字段。
4. ref-equality：已一致 fixture 跑过 healLoadedDefinition 返回原引用。

**Size**：S（≈ 80 行新增）

**Deps**：T5

**Output**：vitest 通过；既有 case 不破。

### RFC-007-T10：源代码层兜底测试

**文件**：

- `packages/frontend/tests/canvas-review-output-drag-not-floating.test.ts`（新建）

**做什么**：

按 design.md §8.4：

- fs.read + 正则锁 4 个文件的标志性字符串与符号：
  - `ReviewNode.tsx` 含 `__review_input__` + `<Handle` + `type="target"`；不含旧注释。
  - `connectionSync.ts` 存在且 export 4 个函数名。
  - `WorkflowCanvas.tsx` 引用 `./connectionSync` + 体内有 `applyConnectionForReviewOutput`。
  - `workflows.edit.tsx` 引用 `healFieldEdgeConsistency`。
- 文件顶部注释链回 RFC-007 + 提交 hash（commit 落地后回填，初版用 placeholder `<TBD-commit-hash>`）。
- 说明 JSDOM 不跑 layout 与节点种类判定行为，源码层断言必要。

**Size**：S（≈ 60 行）

**Deps**：T1, T2, T3, T5

**Output**：vitest 全绿；任何未来 refactor 删常量 / 删 import 都会被锁红。

### RFC-007-T11：（可选）e2e

**文件**：

- `e2e/main.spec.ts`（扩展，可选）

**做什么**：

可选；本 RFC 默认不做，留作 follow-up issue。若做：在 task 详情画布做 read-only 锁的回归点；编辑器画布因 xyflow drag-drop 在 Playwright 上工具复杂度高，暂不引入。

**Size**：S（如做约 20 行 e2e）

**Deps**：所有

**Output**：可选。

## 2. PR 拆分建议

**单 PR**。范围：8 个生产文件改动（含 1 新建 connectionSync.ts、1 改 ReviewNode、1 改 WorkflowCanvas、1 改 NodeInspector、1 改 workflows.edit.tsx、1 改 review.ts 注释、1 新 集成测、1 扩老测）+ 3 个测试文件（1 新建单元、1 扩老的、1 新建源码层兜底）。

理由：

- 全部改动在 frontend，单一 layer。
- 跨文件依赖：T3/T4/T5 都依赖 T1，但 T1 是新文件无 break risk；review.ts T6 是注释，零执行影响。
- 单 PR 在 git revert 上最简洁；任何拆分都引入"中间态"风险（如先合 T1+T2 没 T3 → ReviewNode 渲染了新 handle 但 connect 不写字段 → 用户体验更糟）。

commit message 模板：

```
feat(canvas): RFC-007 review/output 节点支持拖拽连线

- 新 connectionSync 纯函数模块，让 connect/disconnect/表单提交三入口
  统一同步 definition.edges[] 与 inputSource / port.bind 字段
- ReviewNode 新增左侧 __review_input__ target Handle；删除"catch-all
  intentionally off"老注释
- WorkflowCanvas.handleConnect / onEdgesChange 接入 sync helper
  + 新增 isValidConnection 在 task 详情画布 iterate 态拒绝换源
- NodeInspector 表单字段 onChange 触发边重建（双向同步）
- workflows.edit.tsx healLoadedDefinition 扩展 healFieldEdgeConsistency
  让老 workflow 打开即补边或补字段
- review.ts schema 注释更新指向 RFC-007

测试 +30：connection-sync 18 case 纯函数；canvas-review-output-drag
5 case 集成；canvas-edit-old-workflow 扩 4 case heal；新增 source-level
源代码兜底 1 文件锁标志符号
```

## 3. 验收清单

- [ ] T1 connectionSync.ts 文件 + 4 函数 export
- [ ] T2 ReviewNode 渲染左侧 `__review_input__` Handle
- [ ] T3 WorkflowCanvas 三入口走 sync helper + isValidConnection
- [ ] T4 NodeInspector 表单写回边
- [ ] T5 workflows.edit.tsx heal 扩展
- [ ] T6 review.ts 注释更新
- [ ] T7 connection-sync.test.ts 18 case 全绿
- [ ] T8 canvas-review-output-drag.test.tsx 5 case 全绿
- [ ] T9 canvas-edit-old-workflow.test.ts +4 case 全绿，旧 case 不破
- [ ] T10 源代码兜底测试全绿
- [ ] proposal §4 验收标准 11 条全部对应到测试 ID
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] push 后 GitHub Actions 矩阵全绿（含 build-binary + Playwright e2e）按 [feedback_post_commit_ci_check] 复查
- [ ] STATE.md "已完成 RFC" 表追加 RFC-007 行（status Done）
- [ ] design/plan.md RFC 索引 status 从 Draft 改 Done
- [ ] STATE.md 顶部 "进行中 RFC" 移除 RFC-007 行

## 4. 风险点速查

- **死循环**：T1 ref-equality 是底线，T4 表单 onChange 不能在 commitChange 后立刻再触发 onChange（React 已有 batching，但 RFC-004 既有手法可参考）。
- **iterate 锁误伤编辑器**：T3 `isValidConnection` 只读 taskContext，编辑器画布永远 undefined → 永远 true。**确保编辑器画布不传 taskContext prop**。
- **xyflow handle id 冲突**：`__review_input__` 与 RFC-003 `__inbound__` 不同前缀，与任何用户自定义 port name 冲突概率为 0（用户不会写 `__xxx__` 风格的 port 名）。
- **scheduler 不读边的回退**：本 RFC 不动 scheduler；万一 sync helper 有 bug 让边和字段分叉，运行时仍按字段，**视觉错而行为对**。bug 修复后下次保存自动重连。

## 5. 与其他 RFC 的协调

- 与 RFC-005（review 节点）：本 RFC 不动 schema、不动 runtime、不动 review 字段语义；只是把"输入怎么配"这一 UX 缺口补齐。RFC-005 既有 doc_versions / 评论 / 决策流程完全不受影响。
- 与 RFC-003（catch-all）：catch-all 仍只在 agent / wrapper-loop 节点上启用；review / output 不挂 catch-all。`translateInboundConnection` 路径与本 RFC sync helper 互不交叉。
- 与 RFC-004（input port contract）：本 RFC heal 扩展紧贴 RFC-004 既有 healLoadedDefinition 之后；都走 ref-equality 短路；都靠 1s auto-save 写回。
- 与 RFC-006（PortHandles 行内化）：output 节点的 left handles 已经是新行内布局；本 RFC 0 改 CSS / 0 改 PortHandles，仅在 review 节点单独 inline 一个 Handle（不走 PortHandles，避免给它加新分支）。

## 6. 完工后动作

1. 在 STATE.md "已完成 RFC" 表追加 RFC-007 行（关键产出栏简述本 RFC 落地内容）。
2. design/plan.md RFC 索引 status 改 Done。
3. STATE.md 顶部移除 "进行中 RFC：RFC-007" 标记。
4. 按 [feedback_post_commit_ci_check]：推 push 后立刻 `gh run list -L 5` 查 CI 状态，全绿确认。
