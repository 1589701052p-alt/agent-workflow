# Codex 核验：结构化 diff (08-structural-diff)

> 对应报告：`design/arch-audit-2026-06-23/08-structural-diff.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **STRUCT-01 属实，P1 合理**：语言事实确实散在多张表和硬分支中：`EXT_RESOLUTION`、`EXTRACTION`、`DEGRADED_LANGS`、`MASK_QUERIES`、`CALL_QUERIES`、`INDEXER_SPECS` 分别在 `packages/backend/src/services/structuralDiff/lang/grammars.ts:69`、`lang/queries.ts:143`、`lang/queries.ts:166`、`lang/mask.ts:21`、`callGraph/extractCalls.ts:60`、`deep/indexers.ts:37`；语言分支见 `lang/extract.ts:85-89`、`lang/extract.ts:301-304`、`lang/extract.ts:383-386`、`frontend/src/lib/structureGraph.ts:54-70`。

- **STRUCT-02 属实，P1/P2 之间**：调用图确实重跑 extraction query 并自建 `indexDefs`，与 `extractSymbols/buildSymbols` 平行：`callGraph/service.ts:71-111` vs `lang/extract.ts:222-410`。报告指出的匿名类型、parent/owner 语义漂移风险成立；但 RFC-085 明确把调用图定为 best-effort，严重级可降为 **P2 高**。

- **STRUCT-04 属实，P2 合理**：单仓 task 走 `withDeep`：`service.ts:100-102`；多仓 task 分支直接 `computeFromWorktree`：`service.ts:133-155`；多仓 node 反而走 `withDeep`：`service.ts:209-226`。`mode=deep` 由路由传入：`routes/tasks.ts:304-312`，但 task 多仓静默忽略。

- **STRUCT-05 属实，P2 合理**：baseline 支持 C++ 扩展无 `.h`：`lang/grammars.ts:84-89`；deep scip-clang 覆盖 `.h`：`deep/indexers.ts:70-76`；deep 的 indexer 选择基于 `baseline.files`：`deep/service.ts:61`，而 `.h` 在 assemble 阶段会因 `resolveLang` 为 null 被跳过：`assemble.ts:49-55`。

- **STRUCT-06 属实，P3 合理**：粗筛固定串是 `${name}(`：`gitBackend.ts:113-115`，底层是 `git grep -F`：`util/git.ts:726-735`；精筛允许空白 `\s*(`：`impact.ts:37-45`。会漏 `foo ()` 风格的跨文件候选。

- **STRUCT-07 属实，P2 合理**：SCIP path 与 git path 直接 `===`：`deep/deepImpact.ts:25-31`；git changed files 是裸 repo-relative path：`util/git.ts:628-667`。无 `./`、绝对路径、前缀归一化。

- **STRUCT-08 属实但建议降为 P3/P2 perf**：new 文件 baseline parse：`baseline.ts:64-83` → `extract.ts:204`；class edge mask 又 parse：`gitBackend.ts:184-192` → `mask.ts:49-79`；cross-file impact 候选再 parse：`gitBackend.ts:130-145`。不过 RFC-087 as-built 明确选择 mask 计算期重解析：`design/RFC-087-structural-diff-multilang-parity/design.md:38-42`，不是遗漏设计。

- **STRUCT-09 属实，P2 合理**：`SymbolKind` 集合、`leaf`、`escapeRegExp` 重复且已漂移，证据包括 `lang/extract.ts:26-35`、`classGraph.ts:12-27`、`callGraph/service.ts:21-29`、`frontend/src/lib/structureGraph.ts:14-31`、`shared/src/structuralDiffGraph.ts:254-267`、`impact.ts:27-29`、`classGraph.ts:81-83`。

- **STRUCT-11 属实，P2 合理**：前端解析后端 symbol id 格式：`structureGraph.ts:190-203`，并重做 owner/card 推断：`structureGraph.ts:231-309`。这与后端 id 生成 `lang/extract.ts:337`、merge 前缀逻辑 `assemble.ts:137-145` 形成隐式协议。

- **STRUCT-13 / STRUCT-14 属实**：有逐语言行为测试，但没有“每个 LangId 每张表齐全”的一致性断言；现有测试是按功能覆盖，如 mask 全语言：`structural-diff-mask.test.ts:24-50`、call query 全语言：`call-graph-extract-langs.test.ts:23-80`、indexer 映射：`structural-diff-indexer-discovery.test.ts:12-32`。SCIP path 测试只用自造相同路径：`structural-diff-deep-fallback.test.ts:68-88`、`structural-diff-precise-impact.test.ts` 多处 `relativePath`，未覆盖 `./` 前缀。

## REFUTED / 伪问题（给反证 file:line）

- **“所有语言可见性都必须后端结构化产出”表述过强**：schema 明确把 `visibility` 设计为 optional，缺失时前端 heuristic 运行：`packages/shared/src/schemas/structuralDiff.ts:99-105`；前端也确实优先 `sym.visibility`，再 fallback：`frontend/src/lib/structureGraph.ts:544-548`。所以 STRUCT-03 的方向对，但“未填就是 bug”不成立。

- **STRUCT-10 不应按实现 bug 处理，最多 Low heuristic 误导**：`applyViaImport` 注释明确说是 fuzzy hint、not authority：`packages/backend/src/services/structuralDiff/assemble.ts:91-97`；代码用 `includes` 是有意启发式：`assemble.ts:109-117`。可改进，但不是架构缺陷。

- **“deep/service v1 only one indexer”只是注释过期，不是行为问题本身**：代码实际循环所有 needed indexers 并 merge：`packages/backend/src/services/structuralDiff/deep/service.ts:66-104`；测试也锁了多语言合并：`packages/backend/tests/structural-diff-deep-fallback.test.ts:91-155`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **Deep 部分成功会丢弃 baseline impact — High — `packages/backend/src/services/structuralDiff/deep/service.ts:66-105` / `deep/deepImpact.ts:67-85` — 影响：只要至少一个索引器成功，返回 `engine:'deep'` 且 `impact` 被精确结果整体替换；其他失败索引器语言、路径未命中符号、无 SCIP definition 的 changed callable，其 baseline inferred impact 全部消失，且无 degradedReason。**

- **多仓 node deep 的 engine 状态被 merge 覆盖成 baseline — Medium — `packages/backend/src/services/structuralDiff/service.ts:209-249` / `assemble.ts:211-238` — 影响：多仓 node 分支每仓可跑 `withDeep`，但 merge base 固定 `engine:'baseline'`，最终响应可能含 deep 精确 impact 却标 baseline，或者 per-repo degradedReason 被吞掉。**

- **Call graph worktree class index 只在 GC 删除时失效，任务继续写入后可能 stale — Medium — `packages/backend/src/services/structuralDiff/callGraph/expandService.ts:32-79` / `expandService.ts:183-185` / `packages/backend/src/services/gc.ts:72-75` — 影响：同一 worktree 后续节点新增/删除类后，`/call-targets` 仍可能用旧 class→file index，导致调用链解析漏新类或指向已删除类。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

- **`LangProfile` 方向正确，但别把 backend 函数塞进 shared**。`receiverPrefix/visibility/heritage` 依赖 tree-sitter `SyntaxNode`，应留在 backend；shared 只下沉纯常量、`SymbolKind` 分组、id codec、`leaf/escapeRegExp`。否则容易违反 shared schema 当前“pure data only”的约束：`packages/shared/src/schemas/structuralDiff.ts:10-13`。

- **不要直接让 `langIdSchema = z.enum(Object.keys(LANG_PROFILES))`**。TS/Zod 对运行时 keys 不能稳定给出字面量 tuple；更稳的是 `const LANG_IDS = [...] as const`，`langIdSchema = z.enum(LANG_IDS)`，再让 backend `LANG_PROFILES satisfies Record<LangId, ...>`。

- **“删除 `indexDefs`、只用 `SymbolNode[]`”建议不足**。`expandMethod` 需要 AST node/body 来抽调用：`callGraph/service.ts:175-193`；而 `extractSymbols` 当前会 `tree.delete()`：`lang/extract.ts:216-219`。更优解是抽一个低层 `parseAndExtractDefs`，在一次 tree 生命周期内同时产出 `SymbolNode[]` 与 def-node handle；不是简单把 `SymbolNode[]` 当唯一输入。

- **关系结构化应渐进，不要一次性把 classGraph 正则全砍掉**。RFC-087 已明示正则 fallback 是降级策略：`design/RFC-087-structural-diff-multilang-parity/design.md:148-152`。建议先把 Go/Rust/C++/Scala 的高误判点结构化，再保留正则作为 legacy artifact 和 degraded 语言兜底。

- **scope resolver 重构可做，但必须保持只读 structuralDiff 不触碰 RFC-097 状态机**。结构化 diff service 当前只读 task/node_runs 并读写 structural diff store，不写 task status；重构时不要引入 `setTaskStatus/trySetTaskStatus` 路径。报告建议不涉及 RFC-099 prompt 隔离或 opencode env 合并优先级，未发现会破坏这些不变量。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：主体问题识别准确，尤其是语言注册分散、deep 多仓失效、SCIP path 对齐和 def 索引漂移；但部分建议把 intentional best-effort/fallback 说成缺陷，并低估了 `extractSymbols` 与调用图 AST 生命周期的重构复杂度。
