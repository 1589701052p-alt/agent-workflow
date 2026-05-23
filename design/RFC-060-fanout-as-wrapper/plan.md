# RFC-060 — Fanout as Wrapper（任务分解与 PR 拆分）

> 配合 `proposal.md` / `design.md` 阅读。本文件给出落地的子任务编号、依赖关系、PR 拆分、每 PR 验收清单。

## 0. 总体节奏

6 PR 强序，单 PR 全绿 push CI 后再启下一 PR。每个 PR 在 commit message 前缀写 `feat(scope): RFC-060 PR-X — title`，body 引用本 plan.md 的子任务编号。

| PR | 范围 | 估时 | 阻塞 |
|---|---|---|---|
| PR-A | kind 系统升级（shared 层 + parser + 注册表） | ~4 工作日 | — |
| PR-B | agent role=aggregator + signal output kind | ~3 工作日 | PR-A |
| PR-C | wrapper-fanout NodeKind + schema + validator | ~5 工作日 | PR-A, PR-B |
| PR-D | scheduler 适配 + 聚合 agent runtime + per-shard review/clarify | ~7 工作日 | PR-C |
| PR-E | 断代 agent-multi + wrapper-git 升级 list<path> | ~4 工作日 | PR-D |
| PR-F | frontend UI 收尾 + cartesian warning 渲染 + e2e + STATE.md | ~5 工作日 | PR-E |

合计 ≈ 4 周（不含 review、CI 间隙）。

---

## PR-A — Kind 系统升级（shared 层）

**目标**：把 `path<T>` / `list<T>` 参数化 kind + signal kind 加入 schema，新增 parser / registry / keyOf，但**不接 runtime / 不改 validator / 不改 UI**。本 PR 落地后 agent.outputs 里写 `list<path<md>>` 不报错，但还没人消费。

### A.T1 — kind parser

- 新建 `packages/shared/src/kindParser.ts`：`parseKind(text)` / `stringifyKind(parsed)` / `KindParseError`。
- 支持：`base | 'path<' ext '>' | 'list<' kind '>'`（递归）。
- 别名：`'markdown_file'` 读为 `{kind:'path', ext:'md'}`；写时输出 `'path<md>'`（不回滚到 `markdown_file`）。
- 测试：`packages/shared/tests/kind-parser.test.ts` ≥ 12 case（base、path、list、嵌套 list、别名、malformed、round-trip）。

### A.T2 — AgentOutputKind 类型升级

- `packages/shared/src/schemas/review.ts:27` `AGENT_OUTPUT_KIND` 不再是简单 enum；改为 `z.string()` + `.refine(text => parseKind(text) ok)`。
- 升级 `AgentOutputKind` 类型为字符串字面值。
- 任何之前依赖 `kind === 'markdown_file'` 字面值的代码改为先 `parseKind`，比较 `{kind:'path', ext:'md'}`。
- 测试：`packages/shared/tests/agent-output-kind-upgrade.test.ts` ≥ 8 case。

### A.T3 — output kind handler registry 重构

- 新建 `packages/shared/src/outputKinds/registry.ts`，含 `OutputKindHandler` interface + `getHandlerForKind(parsed)`。
- 现有 `markdownFile.ts` 重命名为 `path.ts`，泛化为 `PathHandler`（ext 参数化）；handler.matches 校验 parsed.kind === 'path'。
- 新增 `list.ts` ListHandler：rawContent 多行 split，逐项 delegate item handler validate；promptRender 默认多行 join。
- 新增 `signal.ts` SignalHandler：rawContent 强制空（warning if not empty，不 fail）。
- 测试：`packages/shared/tests/output-kinds-registry.test.ts` ≥ 10 case。

### A.T4 — shardingRegistry

- 新建 `packages/shared/src/shardingRegistry.ts`：`resolveKeyOf(itemKind)` 返回 keyOf 函数。
- 注册 `path<*>` / `path<md>` → 路径本身；其他默认 0-based 索引。
- 测试：`packages/shared/tests/sharding-registry.test.ts` ≥ 6 case。

### A.T5 — markdown_file 字面值兼容向量

- 全仓库 grep `'markdown_file'` 字面值；非测试代码处替换为 `'path<md>'`（必要时引用 `stringifyKind({kind:'path', ext:'md'})`）。
- agent.md frontmatter / workflow YAML 文件中 `'markdown_file'` 字符串读取时**保持兼容**（parser 别名映射）。
- 测试：`packages/shared/tests/markdown-file-alias.test.ts` ≥ 5 case。

### PR-A 验收

- [ ] 4 个新测试文件全绿；现有套件（特别是 RFC-049 port-validation）全绿不退化。
- [ ] `parseKind('list<path<md>>')` / `parseKind('path<*>')` / `parseKind('markdown_file')` 各自正确。
- [ ] 仓库 `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] 任何处理 outputKind 的下游代码若 still hardcode `'markdown_file'` 比较 → grep test 报错（或显式标 `// alias kept for round-trip` 放行）。
- [ ] CI 6 jobs 全绿。

---

## PR-B — Agent role=aggregator + signal output kind

**目标**：把 `role` 字段塞进 agent.md frontmatter；让前端 agent 编辑器支持二选枚举；signal 作为有效的 output kind 字面值进入 agent 创建流程。**仍不接 wrapper-fanout** —— 本 PR 后 agent 可以被标 role=aggregator 但 validator 不让它进顶层 nodes[]，因为 wrapper-fanout 还没落。

### B.T1 — Agent schema 扩展

- `packages/shared/src/schemas/agent.ts` 加 `AgentRoleSchema = z.enum(['normal','aggregator'])`；Agent 类型加 `role?` 字段。
- `agent.outputs[i]` 加 `wrapperPortName?: string` 字段。
- 进出 frontmatter_extra 的 merge / split 见 `services/agent.ts`。
- 测试：`packages/backend/tests/agent-role-schema.test.ts` ≥ 6 case。

### B.T2 — frontmatter parse 升级

- `services/agent.ts` 读 agent.md frontmatter 时把 `role` / `outputs[i].wrapperPortName` 提取出来；写时序列化回去。
- 默认 `role: 'normal'`；frontmatter 没写 role 时进 DB / 出 wire = `'normal'`。
- 测试：`packages/backend/tests/agent-frontmatter-role.test.ts` ≥ 6 case（含 round-trip）。

### B.T3 — signal kind 加入 validator

- `services/runner.ts` 渲染 prompt 前的 validatePromptTemplate（design §3.3）：发现引用了 signal kind 的 port → throw `PortValidationError('signal-port-in-prompt', ...)`。
- 测试：`packages/backend/tests/signal-port-in-prompt.test.ts` ≥ 4 case。

### B.T4 — agent role placement 校验（占位）

- `services/workflow.validator.ts` 加规则：如果 agent.role === 'aggregator' 且节点出现在顶层 nodes[]（即不在任何 wrapper.nodeIds 内） → `aggregator-agent-outside-fanout` 错误。
- 注：PR-B 阶段 wrapper-fanout 尚未存在，故 aggregator agent 实际无处可放；本规则仅锁住"未来"。测试用反例（aggregator agent + wrapper-git 包裹）验证规则在 PR-C 之前不破坏 wrapper-git。
- 测试：`packages/backend/tests/agent-role-placement.test.ts` ≥ 4 case。

### B.T5 — frontend agent 编辑器 role 字段

- `packages/frontend/src/routes/agents/edit.tsx`（或对应组件）加 role 单选 `<Select>` ；按 RFC-035 复用公共 `<Select>` / `<Field>`。
- aggregator role 时 outputs[i] 下拉额外展示 `wrapperPortName` 文本输入（公共 `<TextInput>`）；normal role 时该字段 hidden。
- 8 个 i18n key 双语对称。
- 测试：`packages/frontend/tests/agent-editor-role.test.tsx` ≥ 6 case。

### PR-B 验收

- [ ] 4 个新测试文件全绿。
- [ ] agent.md 写 `role: aggregator` round-trip 不丢字段。
- [ ] frontend agent 编辑器能切换 role；切到 aggregator 时 outputs 字段多 wrapperPortName。
- [ ] `signal` kind 在 prompt 模板里引用报错。
- [ ] CI 6 jobs 全绿。

---

## PR-C — wrapper-fanout NodeKind + schema + validator

**目标**：让 `wrapper-fanout` NodeKind 在 schema 中合法存在；validator 完整校验（含 boundary edge / shardSource / multiple aggregator / cartesian warning）；前端 canvas 能渲染 wrapper-fanout（继承 RFC-016 容器 UX，与 wrapper-git 同视觉规则）。**仍不接 scheduler** —— 本 PR 后 wrapper-fanout 工作流能保存 / 显示 / 校验，但不能跑。

### C.T1 — NodeKind 加 wrapper-fanout

- `packages/shared/src/schemas/workflow.ts`：`NODE_KIND` 加 `'wrapper-fanout'`；`isProcessNodeKind` 加它。
- `WorkflowNodeSchema` passthrough 仍 OK，但定义 narrowed `WrapperFanoutNodeSchema` 用于 validator 解析。
- 测试：`packages/shared/tests/wrapper-fanout-schema.test.ts` ≥ 6 case。

### C.T2 — WrapperPort + 边界 edge schema

- `WorkflowEdgeSchema` 加 `boundary?: 'wrapper-input' | 'wrapper-output'` 可选字段。
- `WrapperFanoutNode.inputs[]: WrapperPort[]`；WrapperPort schema 含 `name` / `kind` / `isShardSource?`。
- 测试：`packages/shared/tests/wrapper-port-edge-schema.test.ts` ≥ 5 case。

### C.T3 — deriveWrapperFanoutOutputs helper

- 新建 `packages/shared/src/wrapperFanout.ts`：`deriveWrapperFanoutOutputs(wrapperId, defn)`（design §5.4）。
- 测试：`packages/shared/tests/wrapper-fanout-outputs.test.ts` ≥ 5 case（无 aggregator / 单 aggregator with rename / 多 aggregator fallback）。

### C.T4 — validator 规则集

`packages/backend/src/services/workflow.validator.ts` 加：

- `wrapper-fanout-shard-source-missing` / `-duplicate` / `-must-be-list`。
- `boundary-input-source-not-wrapper` / `-port-not-declared` / `-target-not-inner`。
- `boundary-output-target-not-wrapper` / `-source-not-inner` / `-source-must-be-aggregator`。
- `multiple-aggregators-in-fanout`（v1 限 1）。
- `wrapper-fanout-nested`（warning，schema-time cartesian guard）。
- `review-input-list-kind-not-supported`（review 节点 input 不接 list<T>）。
- 删除 `clarify-cross-agent-questioner-not-agent-multi`（解禁 cross-clarify questioner 在 fanout 内）。
- 测试：`packages/backend/tests/wrapper-fanout-validator.test.ts` ≥ 14 case。

### C.T5 — frontend canvas 渲染 wrapper-fanout

- `packages/frontend/src/canvas/WrapperNode.tsx`（或类似）加 wrapper-fanout 分支；视觉与 wrapper-git/loop 同一类容器 chrome。
- `NodeInspector` wrapper-fanout 分支：编辑 inputs[]（add / del / mark shardSource flag）；显示推导出的 outputs（read-only，from `deriveWrapperFanoutOutputs`）。
- Palette 加 wrapper-fanout 项。
- 边界 edge 拖拽辅助：从 wrapper 边界 port 拖到 inner 节点 → 自动 mark `boundary: 'wrapper-input'`；inner 节点拖出到 wrapper 边界 port → `boundary: 'wrapper-output'`。
- 12 个 i18n key 双语对称。
- 测试：`packages/frontend/tests/wrapper-fanout-canvas.test.tsx` ≥ 10 case。

### C.T6 — ValidationPanel cartesian warning

- `packages/frontend/src/components/ValidationPanel.tsx`：渲染 `wrapper-fanout-nested` warning，文案"内嵌的 fanout 可能导致 shard 数量爆炸"。
- 测试：`packages/frontend/tests/cartesian-warning-render.test.tsx` ≥ 3 case。

### PR-C 验收

- [ ] 4 个 backend / shared 测试文件全绿（≥ 30 case 新增）。
- [ ] 2 个 frontend 测试文件全绿（≥ 13 case 新增）。
- [ ] wrapper-fanout 节点能在 canvas 拖出、编辑 inputs、保存；validator 给出全套规则。
- [ ] inner 节点放进 wrapper-fanout 不破坏 RFC-016 wrapper-children-outside-bounds 既有 warning。
- [ ] CI 6 jobs 全绿。

---

## PR-D — Scheduler 适配 + 聚合 agent runtime + per-shard review/clarify

**目标**：第一个能跑 wrapper-fanout 端到端的 PR。完成 shard scope 推断、聚合 agent dispatch、per-shard review/clarify、runtime cartesian guard。

### D.T1 — computeShardScope + applyAutoPromote

- 新建 `packages/backend/src/services/fanout.ts`：`computeShardScope(wrapperId, defn)` / `applyAutoPromote(scope, defn)`（design §6.1 / §6.2）。
- 测试：`packages/backend/tests/fanout-shard-scope.test.ts` ≥ 10 case（含 fix-point promote 链、aggregator 豁免、empty list）。

### D.T2 — scheduler wrapper-fanout 分支

- `scheduler.ts` 加 case `'wrapper-fanout'`：
  1. 拿 shardSource port 值（上游 list<T>）；解析为 list items。
  2. 对每个 item，按 perShard set mint 一批 node_runs（shardKey = keyOf(item)）。
  3. 对 shared set mint 一批 node_runs（shardKey = null）。
  4. 推进 inner subgraph 直到 reachable 节点全部 done/failed。
  5. dispatch aggregator agent（若存在）。
  6. finalize wrapper-fanout row（outputs promote）。
- 删除 `scheduler.ts:2171-2454` 的 agent-multi fanout-aggregate / fanout-empty 旧路径（保留代码不动，本 PR 不删，等 PR-E）。
- 测试：`packages/backend/tests/wrapper-fanout-scheduler.test.ts` ≥ 8 case。

### D.T3 — aggregator dispatch + raw list 收集

- `fanout.ts` 加 `collectAggregatorInputs(aggregatorId, scope, db, wrapperRunId)`（design §7.2）。
- `runner.ts` 渲染 prompt 时识别 `{{#each port.shards}}…{{/each}}` 块（design §7.3）。
- 测试：`packages/backend/tests/fanout-aggregator-runtime.test.ts` ≥ 8 case。

### D.T4 — per-shard review

- `review.ts: dispatchReviewNode` 改造：picker 当前选 freshest source run 时，按 shardKey 维度匹配（之前的 skip-fanout-child 逻辑废弃，但本 PR **保留代码**不动；PR-E 删除）。
- 新逻辑：review row 自身 shardKey 由 mint 时继承自上游 perShard inner 节点；source picker 按 review.shardKey + source nodeId 取 freshest done row（含 ULID tie-break）。
- 测试：`packages/backend/tests/review-in-fanout.test.ts` ≥ 8 case（含 reject 仅本 shard cascade、iterate per-shard、未在 fanout 内的 review 不退化）。

### D.T5 — per-shard clarify + cross-clarify

- `clarify.ts` / `crossClarify.ts`：mint clarify_round 时继承当前 node_run 的 shardKey；按 (nodeId, shardKey, iteration) 维度独立。
- cross-clarify questioner 在 fanout 内时每个 shard 独立 cross_clarify_iteration 计数。
- 测试：`packages/backend/tests/clarify-in-fanout.test.ts` ≥ 6 case（self + cross）。

### D.T6 — runtime cartesian guard

- `fanout.ts: estimateShardTotal(wrapperRunId, defn)` + scheduler 在 mint perShard rows 前检查 settings.fanoutMaxShardTotal。
- 默认阈值 256；从 `settings.json` 读 `fanoutMaxShardTotal`。
- 超阈值 throw `DomainError('fanout-cartesian-limit', ...)` → wrapper-fanout 立即 failed。
- 测试：`packages/backend/tests/fanout-cartesian-runtime.test.ts` ≥ 4 case。

### D.T7 — signal output kind end-to-end

- envelope.ts: signal kind 解析 → 强制空 content；agent 写了非空 → warning log，不 fail。
- wrapper-fanout finalize：无 aggregator 时写 `__done__` signal port row。
- 测试：`packages/backend/tests/signal-output-end-to-end.test.ts` ≥ 4 case。

### D.T8 — RFC-053 lifecycle 兼容

- `lifecycle.ts`：新 NodeKind `wrapper-fanout` 不破坏既有不变量；视情况加新规则（如 F1 wrapper-fanout pending + children all done 一致性）—— 留 RFC-057 follow-up 不在本 PR 落地，但本 PR 至少不引入新违反不变量的状态。
- 测试：`packages/backend/tests/wrapper-fanout-lifecycle.test.ts` ≥ 4 case。

### PR-D 验收

- [ ] 8 个测试文件全绿（≥ 52 case 新增）。
- [ ] 手动 demo workflow（含 wrapper-fanout + review 内嵌）跑通端到端。
- [ ] RFC-014 cascade / RFC-052 retry-cascade / RFC-049 port-validation 等套件全绿。
- [ ] settings.json 添加 `fanoutMaxShardTotal` 默认 256；超阈值 hard fail。
- [ ] CI 6 jobs 全绿。

---

## PR-E — 断代 agent-multi + wrapper-git 升级 list<path>

**目标**：删除 `agent-multi` NodeKind 全部代码路径；wrapper-git 输出从 `git_diff: string` 升级为 `git_diff: list<path>`；现有 fixture / e2e 工作流的 prompt 模板做对应改写。**Breaking change PR**。

### E.T1 — NodeKind 移除 agent-multi

- `packages/shared/src/schemas/workflow.ts`：`NODE_KIND` 移除 `'agent-multi'`；`isProcessNodeKind` 移除。
- 测试：`packages/shared/tests/agent-multi-removed.test.ts` ≥ 4 case（含 source-grep）。

### E.T2 — backend services 清扫

- `workflow.validator.ts`：删 4 处 `case 'agent-multi'` + 3 个错误码 + 现有的 agent-multi-sharding-* 规则。
- `scheduler.ts`：删 `scheduler.ts:2171-2454` 整段老 fanout 路径；只保留 wrapper-fanout 分支（PR-D 已加）。
- `services/clarify.ts` / `crossClarify.ts` / `review.ts`：删除 fanout-child special-case 路径（design §10）。
- `services/inventory.ts`：删 agent-multi 提及。
- 测试：`packages/backend/tests/agent-multi-removed-backend.test.ts` ≥ 6 case。

### E.T3 — wrapper-git output kind 升级

- `scheduler.ts` wrapper-git 完成 finalize：`git_diff` port content = changed file paths join('\n')；kind 改为 `'list<path>'`。
- 新增/调整 `packages/backend/src/util/git.ts: gitChangedFiles(repo, preSha, postSha)`。
- 测试：`packages/backend/tests/wrapper-git-list-path.test.ts` ≥ 6 case。

### E.T4 — fixture / 文档刷新

- 仓库 e2e / unit fixture 工作流（含 `kind: 'agent-multi'` 或 `{{git_diff}}` 假设 single string）全部修订。
- `proposal/init.md` "fanout 是 agent-multi 的多进程变体" 措辞加 footnote："superseded by RFC-060 — 改为 wrapper-fanout 模型"。
- `design/proposal.md` / `design/design.md` 中描述 agent-multi 的章节加跳转链接到 RFC-060。

### E.T5 — RFC-055 inspector 废弃

- frontend `<ShardingStrategyField>` 组件删除（RFC-055 落地）；NodeInspector 中 agent-multi 段删除。
- 测试：`packages/frontend/tests/sharding-strategy-inspector-removed.test.tsx` ≥ 2 case。

### E.T6 — source-grep guard

- 新增 `packages/backend/tests/agent-multi-grep-guard.test.ts`：在 `packages/**/*.{ts,tsx}`（排除 dist、test fixture 显式反例、`design/` 文档）grep `agent-multi`，命中数 = 0。
- 测试 ≥ 1 case。

### PR-E 验收

- [ ] 5 个测试文件全绿（≥ 19 case 新增）。
- [ ] grep `agent-multi` 仓库源码（排除文档与 RFC 自身）命中 0。
- [ ] wrapper-git 跑出的 git_diff port 是路径列表；下游 `{{git_diff}}` 模板正常工作（path 多行）。
- [ ] 现有 e2e（review.spec.ts / clarify-cross.spec.ts 等）全绿。
- [ ] CI 6 jobs 全绿。

---

## PR-F — Frontend UI 收尾 + e2e + STATE.md

**目标**：完成 wrapper-fanout 编辑器的视觉 polish（与 wrapper-git/loop 风格对齐）、Inspector 推导 outputs 渲染、e2e 套件、STATE.md / RFC 索引收尾。

### F.T1 — wrapper-fanout 编辑器 polish

- canvas 渲染：wrapper-fanout chrome 与 wrapper-git/loop 同 padding / 颜色 / 圆角；边界 port 视觉位置（左侧 inputs，右侧 outputs by 推导）。
- NodeInspector wrapper-fanout 段：除 inputs[] / shardSource toggle 外，添加 read-only "推导 outputs" 区，展示 `__done__` 或 aggregator outputs（含 wrapperPortName 提示）。
- 复用 `<Field>` / `<Switch>` / `<Select>` / `<ChipsInput>` 等 RFC-035 公共原语，**禁止**自写 chrome。
- 测试：`packages/frontend/tests/wrapper-fanout-inspector-polish.test.tsx` ≥ 6 case。

### F.T2 — signal port 视觉标识

- canvas edge / port 渲染：signal kind port 用虚线连接 / 或灰色填充以区分 data port。
- 测试：`packages/frontend/tests/signal-port-visual.test.tsx` ≥ 4 case。

### F.T3 — i18n 双语对称

- 整理本 RFC 新增 i18n key（≈ 24 个）；cn / en 完整对称。
- 关键术语统一翻译：fanout = "扇出" / aggregator = "聚合" / shard = "分片" / boundary = "边界" / signal = "信号"。

### F.T4 — e2e spec

- 新建 `playwright/fanout-as-wrapper.spec.ts`，含 3 个 scenario（design §14.4）：
  - Scenario 1：US-1 markdown × review N 份独立检视。
  - Scenario 2：US-3 fanout 嵌套 git wrapper。
  - Scenario 3：US-4 无 aggregator placeholder signal。
- 共 ≥ 8 个断言。

### F.T5 — STATE.md / RFC 索引收尾

- `STATE.md` 顶部追加 "RFC-060 fanout-as-wrapper 完工" 记录（仿 RFC-057 / RFC-058 完工块结构）；删除"进行中 RFC"行。
- `design/plan.md` RFC 索引把 RFC-060 状态从 Draft 改为 Done。

### F.T6 — README / 用户文档

- `README.md`（如有 wrapper-fanout 节点章节）补 wrapper-fanout 入门；详细见 RFC-060 design.md。
- agent 编辑器 role 字段的 inline doc 提及 aggregator 用途。

### PR-F 验收

- [ ] 2 个 frontend 测试文件全绿（≥ 10 case 新增）。
- [ ] e2e spec 3 scenario 全绿。
- [ ] STATE.md / design/plan.md 完工状态登记。
- [ ] 仓库总测试 case 增量 ≥ 90（PR-A ≥ 31 + PR-B ≥ 26 + PR-C ≥ 43 + PR-D ≥ 52 + PR-E ≥ 19 + PR-F ≥ 18 + e2e ≥ 8）；实际计数以 CI test report 为准。
- [ ] CI 6 jobs 全绿；视觉 sanity check（与 /agents、/workflows 等核心页 side-by-side）一致。

---

## 子任务依赖图

```
PR-A.T1 (parser) ─── A.T2 (kind upgrade) ─── A.T3 (registry) ─── A.T4 (sharding) ─── A.T5 (alias)
                                                                      ↓
PR-B.T1 (schema) ──── B.T2 (frontmatter) ── B.T3 (signal validate) ── B.T4 (placement) ── B.T5 (editor)
                                                                      ↓
PR-C.T1 (NodeKind) ── C.T2 (edge schema) ── C.T3 (outputs derive) ── C.T4 (validator) ── C.T5 (canvas) ── C.T6 (warning)
                                                                      ↓
PR-D.T1 (scope) ── D.T2 (scheduler) ── D.T3 (aggregator dispatch) ── D.T4 (review per-shard) ── D.T5 (clarify per-shard) ── D.T6 (cartesian runtime) ── D.T7 (signal e2e) ── D.T8 (lifecycle)
                                                                      ↓
PR-E.T1 (rm NodeKind) ── E.T2 (rm backend) ── E.T3 (git list<path>) ── E.T4 (fixtures) ── E.T5 (rm inspector) ── E.T6 (grep guard)
                                                                      ↓
PR-F.T1 (canvas polish) ── F.T2 (signal visual) ── F.T3 (i18n) ── F.T4 (e2e) ── F.T5 (STATE) ── F.T6 (README)
```

PR 之间严格强序；同 PR 内子任务可视开发员判断并行（多数有顺序依赖但相邻 T 间常可并行写测试）。

## 验收守门清单（汇总）

PR 全部合入后总验收：

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] 仓库 grep `agent-multi` 命中 0（design 目录 / RFC-060 自身 / proposal/init.md 注脚除外）。
- [ ] e2e `fanout-as-wrapper.spec.ts` 3 scenario 全绿。
- [ ] STATE.md / design/plan.md RFC-060 状态 Done。
- [ ] 任意工作流升级路径：v4 fixture（无 agent-multi）能正确 load；含 agent-multi 的 historical row（如有）validator 报 `unknown-node-kind`。
- [ ] settings.fanoutMaxShardTotal 默认 256；可在 settings.json 调；超阈值 runtime hard fail with `fanout-cartesian-limit`。
- [ ] cartesian warning 在编辑器 ValidationPanel 正常渲染。
- [ ] 与 RFC-014 / RFC-049 / RFC-052 / RFC-053 / RFC-056 / RFC-058 既有套件零回归。

## 工时估算与里程碑

| 节点 | 完成内容 | 时间 |
|---|---|---|
| M1 | PR-A 合入 | week 1 末 |
| M2 | PR-B + PR-C 合入 | week 2 末 |
| M3 | PR-D 合入（端到端能跑） | week 3 中 |
| M4 | PR-E + PR-F 合入（RFC-060 完工） | week 4 末 |

实际节奏视 CI 排队 / review 反复打回有调整空间；每 PR 预留 1 天 reviewer 反馈缓冲。
