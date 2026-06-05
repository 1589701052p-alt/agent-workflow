# RFC-083 — 任务分解与 PR 计划

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文件。

## PR 拆分（强序，每 PR 自带测试、独立 CI 绿）

体量较大（结构 + 依赖 + 影响面 + 8 语言 + 单二进制内嵌），拆 6 PR。PR-A→E 为 v1 主线；PR-F（xyflow 图）按 OQ-4 可作 v1 收尾或首个 follow-up。

### PR-A — 共享模型 + 基线核心 + 4 一等语言（无 UI / 无后端路由）
- **T1** `shared/src/schemas/structuralDiff.ts`：全部类型 + zod（`SymbolNode`/`SymbolChange`/`SymbolEdge`/`DependencyChange`/`ImpactItem`/`StructuralDiff`/`summary`）。放无依赖叶子，barrel 只重导出类型/纯函数。
- **T2** `graphDiff.ts`（纯叶子）：集合差分 + 三阶重命名/移动感知 + body-hash/签名归一。
- **T3** `services/structuralDiff/lang/registry.ts` + `web-tree-sitter` 集成（grammar 懒加载缓存）+ Py/Go/TS/JS 抽取 query（类/方法/字段/import）。
- **T4** 单文件基线 `baseline.ts`：parseDiff 复用 → old/new blob → 解析 → 符号图 → graphDiff → hunkAnchor。
- **测试**：graphDiff 全 changeType；Py/Go/TS/JS fixtures before-after → 期望 changeset；源码兜底（禁 native tree-sitter import、graphDiff 无注册表耦合）。
- **验收**：`bun run typecheck && test && format:check` 绿；**`bun run build:binary` 不需要本 PR**（grammar 内嵌在 PR-C）—— 本 PR grammar 走文件系统 dev 路径即可。

### PR-B — Java/Rust 自写 query + C++/Scala best-effort + 依赖层
- **T5** Java/Rust 抽取 query（补 field/enum/import/`use`），关联 Rust `use`↔Cargo。
- **T6** C++/Scala best-effort 抽取 + `degraded` 标注。
- **T7** `deps/*` 每生态 manifest 纯解析器（cargo/go/npm/maven/gradle/sbt/pip/poetry/cmake/vcpkg/conan）+ set-diff → `DependencyChange[]`。
- **T8** import 边抽取 + internal/stdlib/external 分类 + viaManifest×viaImport 关联。
- **测试**：6 一等语言 + C++/Scala（锁 best-effort 期望）fixtures；每生态 manifest before/after；import 分类。

### PR-C — 后端服务 + 三粒度取 ref + 产物存储 + 路由 + grammar 内嵌
- **T9** `refSelect.ts`（纯）：task/node/wrapper 取 (fromRef,toRef) + 缺口标注（readonly/pruned/未跟踪）。
- **T10** `db/schema.ts` + drizzle migration：`structural_diffs` 表；`NodeRunSchema` 派生 `hasStructuralSnapshot`/`isWriteNode`。
- **T11** `store.ts` 读写 + runner/task eager 计算 hook（节点/任务完成时落基线 artifact，非阻塞、失败仅 warn）。
- **T12** `routes/structuralDiff.ts` + `server.ts` 挂载 + `resourcePermissionGate`；3 endpoint（task/node GET + deep POST 占位）。
- **T13** grammar 内嵌：`scripts/build-binary.ts` 增 `GRAMMAR_FILES` walk、`embed.generated.ts` stub、`util/paths.ts` 解析、dev↔embedded 双路径。
- **测试**：refSelect 三粒度 + 缺口；endpoint 对 fixture worktree 返回期望；eager hook 落库；**`bun run build:binary` smoke 必跑**（grammar 可加载）。

### PR-D — 前端结构视图（基线全功能，无深度）
- **T14** `worktree-structure` 标签接入 `lib/task-detail-tabs.ts`（登记 `TAB_ORDER` 变更理由）+ `routes/tasks.detail.tsx` pane + query。
- **T15** `components/structure/` 组件族：`StructuralDiffView`(容器+粒度/引擎选择+降级横幅) / `StructuralSummaryCards` / `StructuralTree`(左文件列表+右折叠树+徽标+跳 hunk) / `DependencyChangesPanel`。
- **T16** 文本 diff ↔ 结构视图互链（符号→hunk、hunk→符号）。
- **T17** i18n zh-CN/en-US；`.structure` 命名空间 CSS（复用 `.diff__add`/`.diff__del`/`.segmented`/页面骨架）。
- **测试**：`StructuralTree` 徽标按 changeType（role 断言）；`SummaryCards` 聚合；粒度/引擎选择器；degraded 横幅条件；视觉对齐自查（与 worktree-diff side-by-side）。

### PR-E — 深度模式（SCIP）+ 影响面
- **T18** `deep.ts`：SCIP 索引器发现（PATH/settings）+ 探版本 + 运行（超时/资源上限）+ 编译失败/超时回退基线。
- **T19** SCIP 解析（OQ-2）→ 跨文件引用图 → 被改符号反查调用点 → `ImpactItem[]`；深度 artifact 按需缓存。
- **T20** `POST .../deep` 落地 + 前端 `ImpactPanel` + 引擎切换启用 + 降级横幅文案。
- **T21** C++/Scala 经深度模式一等公民（scip-clang `compile_commands.json` / scip-java build-tool）+ 工具链前置文档（settings 文案）。
- **测试**：固定 SCIP fixture 反查正确；深度不可用→自动回退基线路径；`ImpactPanel` 渲染 + 跳转。

### PR-F（可选 / OQ-4）— xyflow 只读结构图 + AI 摘要 hook 占位
- **T22** `StructuralGraph.tsx`（**`xyflow` + `elkjs`/`dagre` 自动布局** 只读图：符号节点 + 调用/继承/import 边 + 置信着色；**默认收窄到"被改符号 + 1 跳邻居"子图**控制规模）。升级路径(增量)：大规模→Cytoscape.js、UML→Mermaid classDiagram 导出。
- **T23** `SymbolChange.detail?` AI 摘要 hook 占位（schema 余量已留；不实现 LLM 调用）。

## 依赖关系

```
PR-A ─▶ PR-B ─▶ PR-C ─▶ PR-D ─▶ PR-E ─▶ (PR-F)
 模型/基线   语言/依赖   后端/存储/  前端基线   深度/影响  图/AI 占位
 4 语言                内嵌
```
强序：模型先行；基线齐了才接后端；后端有产物前端才有数据；深度叠加在基线之上。PR-F 不阻塞 v1 验收（影响面用调用点列表已满足）。

## 验收清单（汇总，逐 PR 勾）

- [ ] 6 一等语言 before/after → 类/方法/字段 增改删正确，方法重命名显示"重命名"。
- [ ] C++/Scala 基线 best-effort + 文件级"不完整"标注，不牵连其它文件。
- [ ] 8 大生态 manifest "新增外部依赖"识别 + import 边分类。
- [ ] 三粒度（节点/任务/wrapper）出视图；node scope 三缺口显式标注。
- [ ] 影响面（深度）反查正确；深度不可用自动回退基线、视图不崩。
- [ ] `bun run build:binary` smoke 通过（grammar WASM 内嵌可加载）。
- [ ] 前端结构视图与 worktree-diff 风格一致（复用公共组件 / class）；中英 i18n 齐。
- [ ] `typecheck + test + format:check` 全绿；CI（双 OS + 单二进制 smoke + Playwright）绿。
- [ ] 不删他人代码 / 不动 spec-pinned 约束除已登记的 `TAB_ORDER`；STATE.md 完工后登记。

## 风险与缓解

- **grammar 体积 / 加载**：8 wasm ~8–12MB 进二进制；先 build-binary smoke 验证、必要时按需懒加载减常驻内存。
- **二进制模块初始化环（RFC-079 类）**：`graphDiff`/类型留无依赖叶子，barrel 不拉注册表；每次 shared 导出改动前 `build:binary`。
- **深度模式需可编译**：agent 中间态常编译不过 → 默认纯按需 + 自动回退基线（OQ-5），不阻塞。
- **scip-clang 前置**（`compile_commands.json`）：缺则 C++ 深度降级 best-effort，文档明确；不强求。
- **JS ESM import 检测偏弱**：PR-A 用 fixture 验证，必要时补 query。
