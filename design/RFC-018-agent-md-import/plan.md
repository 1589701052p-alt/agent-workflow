# RFC-018 Plan — 任务拆分

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> 默认 PR 拆分：单个 RFC 单个 PR（与 CLAUDE.md §RFC workflow 第 5 条对齐）。

## 子任务

### RFC-018-T1 — Shared parser
- 编辑/新增：
  - `packages/shared/package.json`：加 `yaml` 依赖（版本与 backend 对齐）
  - `packages/shared/src/agent-md.ts`：导出 `parseAgentMarkdown`、`AgentMarkdownParseResult`、`AgentMarkdownParseOptions`
  - `packages/shared/src/index.ts`：重导出
- 实现细节见 design.md §2。
- 测试：`packages/shared/tests/agent-md.test.ts`，至少 16 条 case（见 design.md §6.1）。

### RFC-018-T2 — Frontend merge helper
- 新增 `packages/frontend/src/lib/agent-import-merge.ts`：纯函数 `mergeAgentImport(current, result)`。
- 测试 `packages/frontend/tests/agent-import-merge.test.tsx` 4 条 case（design.md §6.2）。
- 依赖：T1（用 `AgentMarkdownParseResult` 类型）。

### RFC-018-T3 — Import dialog 组件
- 新增 `packages/frontend/src/components/AgentImportDialog.tsx`：实现 Upload / Paste tab + Parse + Preview + Apply（design.md §3.1）。
- 复用现有 Modal / Tab / Field primitives；不引入新设计系统组件（落地时先 grep 仓内现有 modal/dialog 模式选择最贴近的，例如 `WorkflowYamlImportDialog` 如存在则照搬骨架）。
- 测试 `packages/frontend/tests/agent-import-dialog.test.tsx` 4 条集成断言。
- 依赖：T1, T2。

### RFC-018-T4 — `/agents/new` 集成 + 编辑页排除断言
- 编辑 `packages/frontend/src/routes/agents.new.tsx`：在 AgentForm 之上加 Import 按钮 + dialog 容器（design.md §3.2）。
- i18n：在 zh / en locale 文件加 §4 列出的新 key。
- 测试 `packages/frontend/tests/agents-new-import-button.test.tsx`：
  - 路由组件渲染存在 Import 按钮 testid。
  - 源码层文本断言：`packages/frontend/src/routes/agents.detail.tsx`（编辑路由文件）不 import `AgentImportDialog`。
- 依赖：T3。

### RFC-018-T5 — 文档同步 + push
- 更新 `design/plan.md` RFC 索引表：追加 RFC-018 行（状态 In Progress → Done）。
- 更新 `STATE.md`：开工时在顶部 "进行中 RFC" 区追加一行；完工时改为 Done 并在已完成 issue 表加一行。
- 不引入新文档文件。
- 跑 `bun run typecheck && bun run test && bun run format:check`；按 [feedback_post_commit_ci_check] 推送后查 CI。

## 依赖图

```
T1 ──► T2 ──► T3 ──► T4 ──► T5
        ▲             │
        └─────────────┘
```

T2 仅依赖 T1 类型；T3 同时用 T1 (parser) 和 T2 (merge)；T4 依赖 T3；T5 在前四个任务全绿之后才动 docs。

## 验收清单

落 PR 前所有项必须打勾：

- [ ] `parseAgentMarkdown` 16 条 case 全绿
- [ ] `mergeAgentImport` 4 条 case 全绿
- [ ] AgentImportDialog 4 条集成 case 全绿
- [ ] `/agents/new` 渲染 Import 按钮；`/agents/$name` 源码层不引用 AgentImportDialog
- [ ] i18n 中英双份新增 key 齐全
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] `design/plan.md` RFC 索引表追加 RFC-018
- [ ] `STATE.md` 顶部"进行中 RFC"区追加一行；落地完工再改 Done

## 不做（落地阶段提醒）

- 不要顺手加导出（agent → md）；本 RFC 不含。
- 不要扩 `CreateAgentSchema`；本 RFC 不改 schema / DB / backend。
- 不要顺手给 NodeInspector 加 import；NodeInspector 是节点级覆写，与 agent 资源 import 无关。
- 编辑路由 `/agents/$name` 不集成 Import 按钮，即使技术上可行——见 proposal §2 / design.md §3.2。
