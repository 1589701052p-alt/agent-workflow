# 结构化 diff（多语言解析 / 调用图 / 影响分析）— 架构审计 (2026-06-23)

## 0. 健康度一句话

子系统职责分层清晰、纯函数密度高、wasm 资源管理无泄漏、降级路径周到，是全仓质量最高的子系统之一；但**「加一门语言」的成本被分散到 8+ 个并行的 per-language 注册表 + 11 处 `lang === 'x'` 硬分支里**，且存在两套各写一份的「def 索引器」与多套重复的 `SymbolKind` 集合 / `leaf` / `escapeRegExp`，是其最大的架构债——扩展性瓶颈集中在语言注册模型，而非功能正确性。

## 1. 当前架构与职责

管线分四层，I/O 全部注入、核心算法皆为纯函数（高度可测）：

- **lang/**（解析层）：`grammars.ts`（扩展名→语言+wasm 注册表 `EXT_RESOLUTION`）、`parser.ts`（web-tree-sitter init + Language 缓存）、`queries.ts`（per-language 抽取 query `EXTRACTION` + `DEGRADED_LANGS`）、`extract.ts`（query matches → `SymbolNode[]`：qualifiedName/可见性/继承/构造归类）、`mask.ts`（per-language 注释/串掩码 query `MASK_QUERIES`）。
- **assemble/baseline/bodyDelta**（单文件 diff 层）：`baseline.analyzeFile`（old/new 抽取 + `graphDiff`）、`assemble.assembleStructuralDiff`（聚合 + 多仓 `mergeStructuralDiffs` 命名空间前缀）、`bodyDelta`（行多重集 delta）。算法核心 `graphDiff`/`computeSummary` 在 `shared/structuralDiffGraph.ts`（依赖无关叶子，规避 RFC-079 模块环）。
- **impact/classGraph/callGraph/**（关系层）：`impact.ts`（`name(` 文本启发式 within-file 调用方）、`gitBackend.augmentCrossFileImpact`（`git grep` + 重解析跨文件调用方）、`classGraph.ts`（变更类之间 inherit/reference 边）、`callGraph/*`（RFC-085 懒展开「一个方法的直接被调」：`extractCalls` + `service.expandMethod` + `classIndex`）。
- **deep/**（精确层，可选）：`indexers.ts`（SCIP 索引器 `INDEXER_SPECS` 注册表）、`runner.ts`（带超时 spawn）、`scip.ts`（protobuf 解码）、`deepImpact.ts`（位置映射 baseline→SCIP 符号 → 精确反向引用）、`service.computeDeepStructuralDiff`（探测→运行→合并→失败回退 baseline）。
- **service.ts / store.ts / refSelect.ts**（编排 + 持久化）：task/node/wrapper scope 解析、终态任务 eager 落盘、多仓合并。路由在 `routes/tasks.ts:304`（`/structural-diff`）+ `:318`（`/call-targets`）。前端 `frontend/lib/structureGraph.ts`（卡片图建模 + dagre 布局）+ `components/structure/*`。

## 2. 设计问题（Design）

**[STRUCT-01] 「一门语言」被拆成 8 个并行注册表 + 11 处硬分支，没有单一语言注册中心** — 级别 P1｜类型 design/extensibility｜证据 `lang/grammars.ts:69`(`EXT_RESOLUTION`)、`lang/queries.ts:143`(`EXTRACTION`) + `:166`(`DEGRADED_LANGS`)、`lang/mask.ts:21`(`MASK_QUERIES`)、`callGraph/extractCalls.ts:60`(`CALL_QUERIES`)、`deep/indexers.ts:37`(`INDEXER_SPECS`)、`lang/extract.ts:85-118`(visibility 按 lang switch)、`:124-174`(heritage Go/Rust 专用函数)、`:143-152`(`receiverPrefix` 注册)；前端 `structureGraph.ts:54-71`(`memberVisibility` 按 lang)。`grep "=== 'go'|=== 'rust'|lang === "` 命中 11 处。｜影响：一门语言的事实被分散到 5 个 `Partial<Record<LangId>>` map + 多个 `if (lang === …)` 里，没有任何编译期约束保证它们一致——加 Kotlin 要按记忆改 8 处，漏一处就静默降级（如只加 `EXTRACTION` 不加 `MASK_QUERIES` → 注释里的类名当真实引用）。RFC-087 的 design §1 自己把根因写成「用正则在扁平文本上猜语言结构」，但 as-built 把承载收敛进 schema 时**没有把这 8 张表收敛成一个 `LangProfile`**。｜建议：引入单一 `LangProfile` 注册表（见 §7），每语言一条记录 `{ exts, grammarFile, extractQuery, maskQuery, callQuery, receiverPrefix?, visibility?, heritage?, degraded, indexer? }`，`langIdSchema` 的 enum 用它派生；用一条「每个 LangId 在每张表里都有项（或显式标 N/A）」的源代码断言锁死遗漏。

**[STRUCT-02] 调用图自带第二套 def 索引器，与 baseline 抽取漂移** — 级别 P1｜类型 coupling/extensibility｜证据 `callGraph/service.ts:71` `indexDefs` 重新跑同一条 `cfg.query` 并自算 owner（`:92-107`），与 `lang/extract.ts:222` `buildSymbols` 完全平行但语义不同：`indexDefs` 不处理匿名类型（`isAnonymousTypeNode` 缺席）、不做 `import` 父跳过、owner 用「最近 class-like 祖先名 / receiverPrefix」而 `buildSymbols` 用「parentId 链 + classLikeIdByName」。｜影响：同一份源码，结构化 diff 里的符号 id/qualifiedName 与调用链展开里识别的方法可能对不上（`findCallable` 退化成 `fallback` 按名乱猜，`service.ts:130-142`）；加语言要同时喂 `buildSymbols` 与 `indexDefs` 两套归类逻辑，任何归类规则改动（如新的构造函数语言）必须改两处否则调用链与树视图不一致。｜建议：让 `extractSymbols` 返回的 `SymbolNode[]`（已带 parentId/kind/qualifiedName）成为调用图的唯一 def 真相源，`expandMethod` 在其上定位方法节点，删除 `indexDefs`。

**[STRUCT-03] 跨语言关系判定有两套并行实现：结构化(extract) + 正则(classGraph/frontend)，且边界靠语言名手工分摊** — 级别 P2｜类型 design/coupling｜证据 继承：`extract.goHeritage`/`rustHeritageMap`（结构化，仅 Go/Rust）vs `classGraph.isInheritance`（正则，其余 6 语言，`classGraph.ts:207-216`）；可见性：`extract.computeVisibility`（rust/cpp/`#`）vs frontend `memberVisibility`（其余，`structureGraph.ts:54`）；注释掩码：`mask.maskCommentsAndStrings`（AST）vs `classGraph.stripCommentsAndStrings`（手写 C 系词法器，`classGraph.ts:91`）。｜影响：「哪些语言走结构化、哪些走正则兜底」是隐式的语言名分摊（注释里写"其余 6 语言"），没有数据驱动；加语言时容易落进错误那侧（如新语言的可见性既不在 `computeVisibility` 也不被 frontend 正则正确识别 → 私有门控 `externallyUsable` 失效，把私有方法当外部可用）。这是 RFC-087 已识别根因的「未竟收口」：结构化只补了缺口语言，没把正则降为纯兜底。｜建议：可见性/继承统一在 extract 阶段产出 `SymbolNode.visibility`/`heritage`（schema 已有字段），所有语言都填；正则路径只在 `visibility === undefined` 时兜底，并在 `LangProfile` 显式标注「该语言走兜底」。

**[STRUCT-04] deep 多语言只在 task 单仓 / node scope 生效，多仓 task scope 与 wrapper 静默丢 deep** — 级别 P2｜类型 design/observability｜证据 `service.ts:135` 多仓 task 分支直接调 `computeFromWorktree` 而非 `withDeep`（对比 `:100` 单仓、`:209` 多仓 node、`:393` wrapper 都走 withDeep）；`deep/service.ts:8` 注释承认「v1 runs ONE indexer ... multi-language merging is a follow-up」但实际 `:72` 已循环跑全部 needed 并 `mergeScipGraphs`——注释过期。｜影响：用户在多仓 task 上点 `mode=deep`，路由照常构造 deepCfg（`routes/tasks.ts:311`）但服务层丢弃它，返回 baseline 且 `engine` 仍是合并产出的 `'baseline'`、**不带 `degradedReason`**，UI 无从得知 deep 被跳过。｜建议：多仓 task 分支每仓也走 `withDeep`（与 node 分支一致），或在 `mode==='deep' && repoCount>1` 时显式 `degradedReason:'multi-repo-deep-unsupported'`。

**[STRUCT-05] `.h` 头文件在 baseline 不受支持，但 deep 索引器声称覆盖 → header-only C++ 变更无法触发 deep** — 级别 P2｜类型 design/impl-bug｜证据 `lang/grammars.ts:84-89` `EXT_RESOLUTION` 含 `.hpp/.hh/.hxx` 但**无 `.h`**；`deep/indexers.ts:75` scip-clang `exts` 含 `.h`；`deep/service.ts:61` `needed = indexersForFiles(baseline.files.map(f=>f.filePath))` ——而 `assemble.ts:50-52` 只把 `resolveLang(path)!==null` 的文件放进 `files`，`.h` 被整体跳过。｜影响：一个只改了 `.h` 头的 C++ diff，baseline.files 不含该文件 → `indexersForFiles` 看不到 `.h` → `needed` 可能为空 → 即便装了 scip-clang 也抛 `indexer-missing` 回退 baseline（而 baseline 对 `.h` 本就空）。两张扩展名表（grammar 侧 / indexer 侧）口径不一致。｜建议：`.h` 加进 `EXT_RESOLUTION`（C 或 C++，C/C++ 共用 cpp grammar 可接受），或让 deep 的 `needed` 基于 `changedFiles` 原始列表而非已过滤的 `baseline.files`。

## 3. 实现问题 / Bug（Impl）

**[STRUCT-06] 跨文件 impact 的 grep 模式 `name(` 与 `findCallers` 的 `name\s*\(` 不一致** — 级别 P3｜类型 impl-bug｜证据 `gitBackend.ts:114` `patterns = [...new Set(targets.map(t => `${t.name}(`))]` 走 `git grep -F`（固定串）；但实际命中判定 `impact.findCallers` 用 `new RegExp(\`\\b${name}\\s*\\(\`)`（`impact.ts:44`）。｜影响：源码写成 `foo ()`（名与括号间有空格）时，`git grep -F "foo("` 不会把该文件选进候选（漏选），即使候选文件本身能匹配 `\s*\(`；这是跨文件 impact 的 false-negative（within-file 不受影响，它直接扫符号体）。Go/Scala 等允许空格调用的代码更易触发。｜建议：grep 也用名字本身（`-F name`）做粗筛，命中判定交给 `findCallers` 的正则，牺牲少量候选数换正确性；或对常见调用风格统一。

**[STRUCT-07] SCIP `relativePath` 与 git 路径的对齐无规范化，索引器加 `./` 前缀即全部 miss** — 级别 P2｜类型 impl-bug/test-gap｜证据 `deepImpact.ts:30` `graph.documents.find(d => d.relativePath === ownerFile)`，`ownerFile = f.filePath`（来自 `gitChangedFiles` 的裸 repo-relative，`util/git.ts:628`）。两者是直接 `===` 比较，无 `./`/`normalize`/前导斜杠处理。｜影响：不同 SCIP 索引器对 `relative_path` 的约定不一（部分写 `./src/x.ts`、部分写绝对或带项目前缀），一旦不等，`resolveChangedScipSymbol` 全返回 null → deep 退化成「跑了索引器却 0 精确 impact」，但 `engine` 已被标 `'deep'`（`deep/service.ts:105`），UI 误以为是精确空结果。CI 用自造 fixture（`encodeScipFixture`）路径自洽，掩盖了真实索引器的路径口径差异。｜建议：比较前对两侧做 `path.normalize` + 去 `./`/前导 `/`；对每个真实索引器记录其 relativePath 约定（属 §7 LangProfile.indexer 元数据）。

**[STRUCT-08] 同一文件在一次请求里被解析 2-3 次（extract-new + mask + 可能的 cross-file），无跨阶段 tree 复用** — 级别 P2｜类型 perf｜证据 `baseline.analyzeFile` 对 new 文件 `extractSymbols`→`parseSource`（`extract.ts:204`）；`gitBackend.augmentClassEdges:191` 对每个 changed-class 的 NEW 文件再 `maskCommentsAndStrings`→`parseSource`（`mask.ts:51`）；候选文件命中跨文件 impact 时第三次解析（`gitBackend.ts:138`）。`parser.ts` 只缓存 Language，不缓存 Tree。｜影响：大 diff（几十个变更类文件）下重复 tree-sitter 解析是主要 CPU 成本；掩码本可复用 extract 已解析的树并直接读 comment/string 节点 range（design §W2 初稿本就想持久化 maskRanges，as-built 退化成重解析）。｜建议：单请求内对 `(filePath, side)` 缓存 `{tree, source}`（用后统一 delete），extract 与 mask 共用；或把掩码 range 作为 `analyzeFile` 的副产物随 `FileStructuralDiff` 流出（计算期，不入盘）。

**[STRUCT-09] 多处重复实现：3+ 份 `SymbolKind` 集合、2 份 `escapeRegExp`、~6 份 `leaf` helper** — 级别 P2｜类型 coupling｜证据 `CLASS_LIKE`/`CONTAINER_KINDS`：`extract.ts:26`、`classGraph.ts:12`、`callGraph/service.ts:21`、`frontend/structureGraph.ts:14`、`shared/structuralDiffGraph.ts:254`(`CLASS_KINDS`)——同一概念 5 处各写一份且成员略有出入（extract 含 `namespace/module`，callGraph 不含）；`MEMBER_KINDS`/`MEMBERISH` 4 处；`CALLABLE` 在 `impact.ts:21`（导出）与 `callGraph/service.ts:29`（私有 `Set<string>`）两份。`escapeRegExp`：`impact.ts:27`（导出）+ `classGraph.ts:81`（私有副本）。`leaf`/`leafName`/`leafOf`/`leafType`/`leafOfQn`：`classGraph.ts:136`、`callGraph/service.ts:48`、`callGraph/extractCalls.ts:76`、`callGraph/classIndex.ts:73`、`frontend:205/216`——同样的「取最后一段」语义 6 份各写。｜影响：成员集合漂移是真实 bug 源（callGraph 的 CLASS_LIKE 漏 `namespace`，TS namespace 内方法 owner 归错）；改一处别处忘改即不一致。既有 dedup-audit 只收录了 1 项（`#61 wrapper-progress-decode`），完全没覆盖这片。｜建议：`SymbolKind` 集合 + `leaf`/`escapeRegExp` 提到 `shared/structuralDiffKinds.ts`（依赖无关叶子，规避模块环），前后端 + 各阶段共用单一定义。

**[STRUCT-10] `applyViaImport` 子串匹配会误标依赖来源** — 级别 P3｜类型 impl-bug｜证据 `assemble.ts:116` `c.length >= 3 && addedImports.some(imp => imp.includes(c))`。｜影响：包名 `react`（5 字符）会匹配任何含 "react" 的 import（如 `react-dom`、`@my/react-utils`），把无关依赖标 `viaImport: true`；这是个标注提示而非权威（注释已声明 heuristic），影响小但会误导用户。｜建议：用边界/段匹配（import path 的某段 === 包名或 `包名/` 前缀），而非裸 `includes`。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

**[CHOKE-01] 半年后「加 Kotlin / Swift / C#」：要碰 8 张表 + 2 个前端启发式 + schema enum** — 触发场景：新增一门一等公民语言。根因：[STRUCT-01]——没有 `LangProfile` 单一注册中心，语言事实分散在 `EXT_RESOLUTION`/`EXTRACTION`/`DEGRADED_LANGS`/`MASK_QUERIES`/`CALL_QUERIES`/`INDEXER_SPECS`/`computeVisibility`/heritage 函数/`receiverPrefix` + 前端 `memberVisibility`/`packageLabel`。现在加功能要碰：`shared/schemas/structuralDiff.ts:22`(enum)、上述 5 张 backend map、`extract.ts` 的 visibility/heritage/constructor switch（`:85/:299`）、`frontend/structureGraph.ts:54`、外加测试。漏任一表静默降级而非报错。目标形态：单一 `LANG_PROFILES: Record<LangId, LangProfile>`，enum 从其 keys 派生；一条源代码断言遍历每个 LangId 校验必填字段齐全（缺失即编译/测试红）；加语言 = 新增一条记录 + 写它的 query 字符串，**纯加数据**。

**[CHOKE-02] 「让调用图/影响分析支持新语言」要喂第二套归类器** — 触发场景：让 RFC-085 调用链覆盖新语言或修正某语言归类。根因：[STRUCT-02] `indexDefs` 与 `buildSymbols` 两套 def 识别。现在要碰：`callGraph/service.ts` 的 owner 计算 + `extract.ts` 的 finalKind/qualifiedName 两处，且二者对匿名类/嵌套/import 行为不同，难保证一致。目标形态：调用图复用 `extractSymbols` 的 `SymbolNode[]`（含 parentId/range）做唯一 def 真相，`expandMethod` 只负责「在已知 def 集合里按 range 找方法 + 抽体内调用」，删 `indexDefs`。

**[CHOKE-03] 「新增一种关系视图（如 typestate / data-flow 边）」要再写一套语言无关正则启发式** — 触发场景：RFC-088 之后想加新边类型。根因：[STRUCT-03] 关系层是「结构化(extract) + 正则(classGraph)」混合，新边没有统一的「从 AST 一次性算出结构化事实、随 SymbolNode 流出」的落点，只能再写一份 `classGraph.ts` 式的跨语言正则。目标形态：把「类间关系」建成 extract 阶段产出的结构化 `SymbolEdge[]`（已在 design §W6 初稿提过但 as-built 砍掉），关系视图消费数据而非重新文本扫描。

**[CHOKE-04] 「deep 接入新索引器 / 多语言精确合并」缺索引器能力元数据** — 触发场景：接 scip-ruby、或让一次 diff 跨 TS+Py 都精确。根因：`INDEXER_SPECS` 只描述 argv/exts/timeout，不带「relativePath 约定、是否需要构建、是否支持增量」等元数据；`deep/service.ts` 已能跑多索引器合并但 [STRUCT-07] 的路径对齐风险使「合并」在真实环境脆弱。现在加索引器要：改 `IndexerId` union、`INDEXER_SPECS`、`DeepIndexerOverrides`、config schema `structuralDeepIndexers`（4 处）。目标形态：索引器作为 `LangProfile.indexer` 的子记录（含 pathConvention/needsBuild），override 表从 profile 派生。

**[CHOKE-05] 「单请求 diff 变大」无 tree 复用 + 无并发 + 无缓存，性能不随 diff 规模线性恶化的保证缺失** — 触发场景：审计大 PR（几百文件）。根因：[STRUCT-08] 重复解析 + `assemble.ts:49` 串行 `for ... await analyzeFile`（逐文件顺序解析）+ 结构化 diff 仅终态落盘、非终态每次请求全量重算。现在「加大 diff」=线性叠加重复解析成本，无横切缓存层。目标形态：单请求 tree 缓存 + 文件级并发（受 `MAX_*` 上限约束）；non-terminal 任务可加短 TTL 内存缓存（按 worktree HEAD + fromRef 失效）。

## 5. 耦合 / 分层违规

**[STRUCT-11] 前端 `structureGraph.ts` 重新实现了 id 解析与卡片归属的「领域逻辑」，与后端 id 格式硬耦合** — 级别 P2｜类型 coupling｜证据 `structureGraph.ts:190-218` 用字符串切分反解 `${file}#${qn}:${kind}:${line}`（`qnFromId`/`fileFromId`/`kindFromId`），`memberContainer`/`displayTitle`（`:265/:231`）在前端重做「method-local / anon / 真内类」的归属推断——这是后端 extract 已有的结构知识（parentId/kind）。｜影响：symbol id 格式（`assemble.ts:144` 的 `#`/`::` 约定 + `extract.ts:337`）是前后端隐式契约，任一侧改 id 拼法两边都炸；归属逻辑两地各写一份（与 [STRUCT-02] 同病）。｜建议：后端在 `SymbolChange` 上直接给出 `cardKey`/`cardTitle`/`ownerKind`，前端纯渲染；id 解析收敛到 shared 的一个 parse 函数。

**[STRUCT-12] `service.ts` 既做 scope 解析、又做错误码映射、又做持久化触发、又做多仓合并，单文件 406 行承担 5 职责** — 级别 P3｜类型 coupling｜证据 `service.ts` 同时含 HTTP 语义（409/410 DomainError）、CAS 终态判断（`isTerminalTaskStatus`）、git 探测（`isGitWorkTree`）、多仓循环、wrapper 委派。｜影响：每加一种 scope（如 RFC 提到的 wrapper-in-loop）要在这个大编排函数里再嵌一层 if；deep 多仓遗漏（[STRUCT-04]）正是这种「分支太多人工分摊」的产物。｜建议：scope→(fromRef,toRef,worktree) 解析抽成纯 resolver 表，service 只做「resolver → compute → withDeep → persist」的统一流水。

## 6. 测试 / 可观测性缺口

**[STRUCT-13] 没有「每个 LangId 在每张 per-language 表里都有项」的一致性断言** — 级别 P1｜类型 test-gap｜证据 8 张表（§2 STRUCT-01）无交叉校验测试；`hasExtraction`/`hasMaskQuery`/`hasCallQuery` 各自返回 boolean，没有测试断言「凡 `EXTRACTION` 有的语言，`MASK_QUERIES`/`CALL_QUERIES` 也必须有或显式豁免」。｜影响：加语言漏填某表静默降级（如漏 mask → 注释泄漏成引用），无红灯。｜建议：一条参数化测试遍历 `langIdSchema.options`，对每张表断言有项或在白名单豁免（如 deep 索引器可缺）。

**[STRUCT-14] deep 真实索引器路径口径无测试覆盖** — 级别 P2｜类型 test-gap｜证据 [STRUCT-07]；测试全用 `encodeScipFixture` 自造路径，无法暴露真实 scip-typescript/scip-python 的 `relativePath` 前缀差异。｜影响：deep 在真实环境可能 0 命中而 CI 全绿。｜建议：至少加一个「relativePath 带 `./` 前缀 / 前导 `/`」的 fixture 断言归一化后仍命中。

**[STRUCT-15] degraded/engine 状态缺结构化可观测性** — 级别 P3｜类型 observability｜证据 `withDeep`（`service.ts:52`）catch 后只把 `degradedReason` 塞进响应体，无日志/指标；多仓 task 丢 deep（[STRUCT-04]）连 reason 都没有。｜影响：运营无法回答「deep 模式实际命中率 / 各语言降级原因分布」。｜建议：deep 探测/运行/解析失败打结构化日志（reason + lang + 耗时）。

## 7. 目标形态（Target architecture）

理想：**「语言」是一条数据记录，不是散落的分支。** 引入单一注册中心，所有阶段从它派生：

```
// shared 或 backend 单文件，依赖无关叶子（规避 RFC-079 模块环）
interface LangProfile {
  id: LangId
  exts: string[]                     // 取代 EXT_RESOLUTION
  grammarFile: string
  extractQuery: string               // 取代 EXTRACTION
  maskQuery?: string                 // 取代 MASK_QUERIES
  callQuery?: string                 // 取代 CALL_QUERIES
  receiverPrefix?: (n) => string|null
  visibility?: (n, name) => Visibility|undefined   // 结构化可见性，所有语言可填
  heritage?: (n, root) => string[]                 // 结构化继承
  degraded?: boolean                 // 取代 DEGRADED_LANGS
  indexer?: { spec: IndexerSpec; pathConvention: 'bare'|'dotslash'|... }  // 取代 INDEXER_SPECS
}
const LANG_PROFILES: Record<LangId, LangProfile> = { ... }
// langIdSchema = z.enum(Object.keys(LANG_PROFILES))   ← enum 从数据派生
```

配套：
1. **单一 def 真相源**：`extractSymbols` → `SymbolNode[]` 是树视图、impact、classGraph、callGraph 共同消费的唯一符号集；删除 `indexDefs`（[STRUCT-02]），调用图在 SymbolNode 上按 range 定位。
2. **结构化优先、正则只兜底**：可见性/继承/掩码全在 extract 阶段算成结构化数据（schema 已有 `visibility`/`heritage` 字段），正则路径仅在 `profile.visibility === undefined` 时启用且在 profile 显式标注。
3. **关系即数据**：类间 inherit/reference 建成 extract 产出的结构化边（计算期，不入盘），关系视图与新边类型消费数据而非文本重扫。
4. **共享原语下沉**：`SymbolKind` 集合 / `leaf` / `escapeRegExp` / id parse 提到一个 shared 叶子（[STRUCT-09]/[STRUCT-11]）。
5. **单请求 tree 缓存 + 文件并发**：extract 与 mask 共用同一棵树；`analyzeFile` 受上限约束地并发（[STRUCT-08]）。
6. **一致性断言**：参数化测试锁死「每 LangId 每表齐全」（[STRUCT-13]）。
7. **scope resolver 表**：service 退化成「resolve → compute → withDeep → persist」统一流水，deep 对所有 scope/仓数一致生效（[STRUCT-04]/[STRUCT-12]）。

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 |
|---|---|---|---|---|
| 1 | CHOKE-01 / STRUCT-01 | 语言事实散落 8 张表无注册中心，加语言碰一堆点且漏填静默降级 | P1 | extensibility/design |
| 2 | STRUCT-13 | 缺「每 LangId 每表齐全」一致性断言（上条的安全网） | P1 | test-gap |
| 3 | STRUCT-02 / CHOKE-02 | 调用图自带第二套 def 索引器，与 baseline 抽取漂移 | P1 | coupling |
| 4 | STRUCT-04 | deep 在多仓 task scope 静默失效且不标 degradedReason | P2 | design/observability |
| 5 | STRUCT-07 / STRUCT-14 | SCIP relativePath 无归一化，真实索引器可能 0 命中却标 engine=deep | P2 | impl-bug/test-gap |
| 6 | STRUCT-05 | `.h` 在 baseline 不支持但 deep 声称覆盖，header-only C++ 无法触发 deep | P2 | impl-bug |
| 7 | STRUCT-09 / STRUCT-11 | SymbolKind 集合/leaf/escapeRegExp/id-parse 5-6 处各写一份并已漂移 | P2 | coupling |
| 8 | STRUCT-08 / CHOKE-05 | 单文件被解析 2-3 次、串行无并发、非终态不缓存 | P2 | perf |
| 9 | STRUCT-03 / CHOKE-03 | 关系判定结构化+正则两套，新边只能再写一份正则 | P2 | design |
| 10 | STRUCT-06 / STRUCT-10 / STRUCT-12 / STRUCT-15 | grep 模式不一致 / viaImport 子串误标 / service 多职责 / deep 无指标 | P3 | impl/observability |

> 与既有审计关系：本子系统无专项审计；`dedup-audit-2026-06-13.md` 仅收录 1 项（#61 wrapper-progress-decode），**[STRUCT-09] 的 SymbolKind/leaf/escapeRegExp 重复簇是该报告核心结论「公共原语已存在但被绕过各写一份」在本子系统的未覆盖延伸**。其余发现均为新增的架构/扩展性洞察。
