# 端口 / 输出 kind 注册表 / 信封协议 — 架构审计 (2026-06-23)

> 子系统 key = `05-port-output-kind`
> 范围：output-kind 注册表（扩展点成熟度）、XML 信封解析健壮性、端口契约、prompt 协议块、signal guard
> 与既有审计的关系：本子系统无专项。scheduler-audit 仅在 dedup 语境提了 `shardingRegistry.ts:75`（freshness shard-value）；dedup-audit 的 "envelope" 指的是 API error envelope（`schemas/apiError.ts`），**不是** workflow-output 信封。本报告所有发现均为新增。

---

## 0. 健康度一句话

**输出 kind 子系统是全仓「可扩展抽象」的最佳样板（参数化 handler + 多重 boot-time drift guard，加一个 base kind 真的只要改两三处且 CI 兜底），但它仍是「样板 + 半成品」混居：RFC-060 PR-D 承诺的「删除 legacy `HANDLERS` Record + `markdownFile.ts`、runtime 单注册表」从未完成，kind 的横切行为被切碎在 5 个并列注册表/谓词里，且 XML 信封解析器是裸非贪婪正则——存在静默截断（嵌套 `</port>`）与 design 承诺却未实现的 CDATA 转义两处真问题。**

---

## 1. 当前架构与职责

文本端口从 agent stdout 进入系统的链路：runner 抓最后一段 `<workflow-output>` → `parseEnvelope` 拆 `<port>` → 按 `agent.outputKinds[port]` 解析成 `ParsedKind`（`kindParser.ts` 文法 `base | path<ext> | list<T>`）→ `getHandlerForParsedKind` 派发到参数化 handler 做 `validate`（fail-fast，失败转 `port-validation-<display>-<sub>` 错误码驱动同会话 followup）→ 持久化**原始** content 到 `node_run_outputs`。出站方向：`buildProtocolBlock` 用同一组 handler 自动生成「端口清单 + bullet 后缀 + 示例 + per-kind 引导」追加到 user prompt 末尾。kind 的横切元数据另由 `uiCatalog`（前端）、`shardingRegistry`（fanout shardKey）、`node-kind-behavior`（节点级，非端口级）承载。

关键文件：
- `packages/shared/src/kindParser.ts` — 文法 + `ParsedKind` + `REGISTERED_BASE_KINDS` 白名单 + `isReviewableBodyKind` 等谓词（**零依赖**，cycle 红线根）。
- `packages/shared/src/outputKinds/registry.ts` — 参数化 `PARAMETRIC_HANDLERS`（string/markdown/path/list/signal）+ `getHandlerForParsedKind` + 分组/repair helper + 3 层 boot-time drift guard。
- `packages/shared/src/outputKinds/{string,markdown,path,list,signal}.ts` + `*Parametric.ts` — handler 实现。
- `packages/shared/src/outputKinds/index.ts` — **legacy** `HANDLERS` Record（runtime 已死）+ barrel。
- `packages/shared/src/outputKinds/{types.ts,markdownFile.ts,uiCatalog.ts}`、`listWire.ts`、`shardingRegistry.ts`、`reviewMultiDoc.ts`、`signalPromptGuard.ts`、`prompt.ts`。
- `packages/backend/src/services/envelope.ts` — 信封正则 + `resolvePortContentDetailed` + `NODE_VALIDATE_IO`。
- `packages/backend/src/services/protocol.ts` — 纯 re-export shim。
- `packages/frontend/src/{lib/output-port.ts,components/KindSelect.tsx}`。

---

## 2. 设计问题（Design）

**[PORT-01] design 承诺 CDATA / 转义，实现是裸非贪婪正则，无任何转义机制** — 级别 P1｜类型 design / impl-bug
- 证据：`design/proposal.md:439`「任意文本内容（保留 CDATA / 转义）」；实现 `services/envelope.ts:143` `PORT_RE = /<port\s+name=(?:"…"|'…')\s*>([\s\S]*?)<\/port>/g`，全文件无 `CDATA` 字样；`prompt.ts:588-599` 的协议块也**从不**告诉 agent 如何转义内容里的 `</port>` / `</workflow-output>`。
- 影响：协议本身无任何转义层。agent 输出的合法内容里若含字面 `</port>` 或 `</workflow-output>`（典型：在 markdown 里记录本 XML 协议、贴一段含该字符串的 fenced code、或一份讲解 agent-workflow 的文档）会被静默截断（见 PORT-02）。design 把转义当成「已解决」，实际是悬空契约。
- 建议：二选一并同步 design：(a) 协议块明确要求 agent 用 ` ``` ` 包裹 + 框架不解析内部，或要求 base64/`<![CDATA[…]]>` 包裹路径外内容；(b) 至少在 `buildProtocolBlock` 加一句「内容中若出现 `</port>` 请改写」。最低限度：把 design §7 的「保留 CDATA / 转义」改成实情，别让后人以为有保护。

**[PORT-02] 嵌套 `</port>` 触发静默内容截断（非贪婪 + 无栈匹配）** — 级别 P1｜类型 impl-bug
- 证据：复现脚本对 `design.md:133` 测试同款输入运行 `PORT_RE.matchAll`，`design` 端口内容被截断为 `# Title\n\`\`\`xml\n<port name="fake">should be ignored as md content`——闭合 fence ` ``` ` 与其后内容全部丢失，且 `fake` 也未被当作独立 port（正则游标已跨过那个 `</port>`）。锁这个行为的测试 `envelope-parse-md-edge-cases.test.ts:133` 只断言 `toContain('\`\`\`xml')` + `toContain('<port name="fake">')`，**对截断视而不见**——`toContain` 通过 ≠ 内容完整。
- 影响：静默数据丢失。下游拿到残缺文档；review 节点把残缺正文写进 `doc_versions`。最隐蔽的一类——run 成功、无报错、内容缺一截。
- 建议：把 `<workflow-output>` 当成「带分隔符的容器」而非可嵌套 XML：对 `extractLastEnvelope` 取到的块用「逐个 `<port name=…>` 起点 + 下一个 `<port name=` 起点或 `</workflow-output>` 为终点」的分段（而非匹配 `</port>`），这样内容里的 `</port>` 不再是边界；或落实 PORT-01 的转义层。补一条**完整内容相等**（非 `toContain`）的回归测试。

**[PORT-03] kind 文法是纯语法白名单，缺「语义可用性」准入——`list<signal>` 被接受** — 级别 P2｜类型 design / extensibility
- 证据：bun 探针证明 `isRegisteredKindString` 对 `list<signal>`、`list<list<signal>>` 均返回 `true`（`kindParser.ts:178 isRegisteredKindString` 只查文法 + base 白名单，`allBasesRegistered` 对 `list` 只递归 item 的 base 名）。fanout 校验 `workflow.validator.ts:216` 只判 `parsed.kind === 'list'`，不问 item 是否 data-bearing / 可分片。
- 影响：作者可声明 `list<signal>`（一串「无数据」控制信号的列表，语义自相矛盾）或把它接成 fanout shardSource，系统一路接受到 mint shard。每个「这种组合不该存在」的规则今天散落或缺失，没有中心。
- 建议：在 handler 接口加一个语义谓词（如 `validAsListItem(parsed)` / `validAsShardItem(parsed)`），或让 schema refine 调用注册表做语义准入（registry 已 import kindParser，不破 cycle）。fanout 校验改成「shard item 必须 data-bearing」。

**[PORT-04] kind 横切行为切成 5 个并列注册表/谓词，"加一个 kind" 的真实 touch-set 远大于 registry 注释暗示** — 级别 P2｜类型 design / extensibility
- 证据：同一个 kind 的不同维度分别落在：(1) `PARAMETRIC_HANDLERS`（validate/prompt/repair/carriesData/bulletSuffix/isReviewableBody）`registry.ts:129`；(2) `OUTPUT_KIND_UI` + `PATH_EXT_UI`（前端 label/download/dataBearing/editorShape）`uiCatalog.ts:43,104`；(3) `shardingRegistry` 的 `keyOf`（fanout shardKey）`shardingRegistry.ts:80`；(4) `kindParser` 里手写的 `isReviewableBodyKind`（review 准入，`registry.ts` 与 `uiCatalog.ts` 通过 cycle 红线无法 import handler 而只能 import 它）`kindParser.ts:225`；(5) `REGISTERED_BASE_KINDS` 白名单。drift guard（`registry.ts:278/302`、`uiCatalog.ts:125`）只锁住 base-name 与 dataBearing 两条交叉，**没有**强制 sharding/review 维度也被新 kind 填满。
- 影响：详见 §4 chokepoint 1。`isReviewableBody` 这一维既在 handler 上声明又在 kindParser 里手写实现，handler 只是 `delegate 回 kindParser`——抽象表面上「kind 自报能力」，实际真值仍在另一个文件，是抽象泄漏。
- 建议：见 §7。

**[PORT-05] 双 handler 注册表长期并存——RFC-060 PR-D 的「删 legacy」承诺从未兑现** — 级别 P2｜类型 design / coupling
- 证据：`registry.ts:6-12` 自述「PR-D：切换 runtime 调用方…同步删除 markdownFile.ts、把现有 HANDLERS Record 替换为本注册表」；至今 `outputKinds/index.ts:21` 仍 export legacy `HANDLERS` + `getOutputKindHandler` + `groupPortsByKind` + `composePerKindRepairBlocks` + `markdownFile.ts`。grep 证明这些 legacy API **runtime 已无调用方**（`getOutputKindHandler`/`groupPortsByKind`/`composePerKindRepairBlocks`/`HANDLERS` 仅出现在注释、`schemas/review.ts` 的 coverage 注释、和测试里）。`markdownFile.ts` 同理（仅 index barrel + 自身单测）。
- 影响：两套接口（`OutputKindHandler<K>` vs `ParametricOutputKindHandler`）+ 两套分组/repair helper + 一个死 handler 长期维护。新人不知道该往哪套加；`types.ts` 注释说「四方法上限」但参数化接口实际已 11 个方法——文档与现实脱节。
- 建议：执行 PR-D：删 `HANDLERS` Record + `markdownFile.ts` + `string.ts`/`markdown.ts`（legacy 版）+ 对应 helper，把 `types.ts` 的 legacy `OutputKindHandler` 退役，coverage 测试改测参数化注册表。保留 `markdownFileHandler` 仅作为 alias 测试可放进 kindParser round-trip 测试。

---

## 3. 实现问题 / Bug（Impl）

**[PORT-06] fanout 对 `list<markdown>`（内联 boundary 分隔）会按行误分片——多行文档被切碎** — 级别 P1｜类型 impl-bug
- 证据：fanout 读 shardSource 后用**手写**行分割 `scheduler.ts:3120` `const items = rawContent.split('\n').map(s=>s.trim()).filter(...)`，对 `list<markdown>` 的 boundary 形式（`listWire.ts` 的 `splitMarkdownDocs`，按 `MARKDOWN_DOC_BOUNDARY` 分隔的多行文档）完全无视。validator `workflow.validator.ts:216` 只要求 `parsed.kind === 'list'`，**不**拒绝 `list<markdown>` 作 shardSource。探针确认 `isRegisteredKindString('list<markdown>') === true`。对比：review 侧对内联 list 正确用 `splitMarkdownDocs`（`review.ts:445` 用 `splitListItems` 处理路径 list、`reviewMultiDoc.isInlineMarkdownListReviewInput` 分流内联）——fanout 侧没有这个分流。
- 影响：把一个 `list<markdown>` 端口 fan-out 时，每个 markdown 文档的每一**行**变成一个 shard，文档被横切、boundary 行自身也成 shard。静默产出错误分片集。无测试覆盖（grep `fanout.*list<markdown>` 无命中）。
- 建议：fanout 分片改用 kind-aware 分割：内联 markdown list → `splitMarkdownDocs`，否则 `splitListItems`（与 review 侧同源）。或在 validator 拒绝内联 `list<markdown>` 作 shardSource（仅允许 `list<path<...>>` / `list<string>`），并补测试。

**[PORT-07] fanout 行分割手写一份，绕过 `splitListItems` 公共 codec（drift 风险）** — 级别 P2｜类型 impl-bug / coupling
- 证据：`scheduler.ts:3120` 的 `.split('\n').map(trim).filter(len>0)` 与 `listWire.ts:18 splitListItems` 字节等价，但是独立手写的一份。`listWire.ts` 头注释明确说自己是「list<T> wire-form item splitter」单一事实源；review 侧 `review.ts:445` 已 import 它，fanout 侧没有。
- 影响：典型「公共原语已存在却被绕过各写一份」（与 dedup-audit §核心结论同形，但此处是新点位）。哪天 `splitListItems` 改语义（如去重、保留空行语义），review 与 fanout 会漂移——而二者本应分片一致（`review.ts:443` 注释自承「Split with the SAME shared splitter…downstream wrapper-fanout use so the reviewed item set matches the shard set byte-for-byte」，但 fanout 实际没用同一个 splitter，注释已是谎言）。
- 建议：fanout 直接调 `splitListItems`（解决 PORT-06 的同时顺带消除这条 drift）。

**[PORT-08] `signal` 端口非空内容被静默丢弃，承诺的 telemetry/warning 从未接线** — 级别 P2｜类型 observability / impl-bug
- 证据：`signal.ts:51-64` validate 永远 `ok:true, body:''`，注释说「Callers that want to log the warning can detect this by comparing rawContent vs result.body…PR-B may upgrade this to a structured warning channel」。grep `signal-non-empty` / `carriesData.*warn` / rawContent-vs-body 对比在 backend **零命中**。更糟：runner 持久化的是**原始** content（`runner.ts:1204` 写 `content`，不是 handler 归一化后的 body），所以 signal 端口若 agent 写了内容，DB 里存的是原始非空内容，与 handler「forced to empty」的契约矛盾——只有走 `resolvePortContent`（验证路径，结果被丢）才会归一化。
- 影响：(1) agent 误把数据塞进 signal 端口时无任何告警，作者无从发现 wiring 错了；(2) signal 端口的持久化值与「control-only 应为空」契约不一致，下游若误读会拿到非空串。
- 建议：runner 持久化时对 signal kind 用 handler 归一化后的 body（统一走 `resolvePortContent` 的结果而非原始 content），并在 rawContent≠body 时 `log.warn` + 发一条事件流行。

**[PORT-09] `detectEnvelopeKind` 的 'both' 判定对「合法内容里碰巧出现另一种标签」误报失败** — 级别 P2｜类型 impl-bug
- 证据：`envelope.ts:212-224` `detectEnvelopeKind` 用全局 `ENVELOPE_RE.test` + `CLARIFY_ENVELOPE_RE.test` 跨整段 stdout 计数；注释 `:209-211` 自承「any stdout that contains BOTH tag pairs (even nested or separated by megabytes) is `both`」是有意的。但若一个**正常 output** 的 `<port>` 正文里贴了一段讲解 clarify 协议的文本（含字面 `<workflow-clarify>…</workflow-clarify>`），会被判 `both` → 硬失败 `clarify-and-output-both-present`。
- 影响：与 PORT-02 同根（裸正则不分「容器外」与「容器内/正文内」）。clarify 节点的 mandatory ask-back 文案本身就含 `<workflow-clarify>` 字面（`prompt.ts:644`），agent 复述指令就可能踩雷。
- 建议：只在「最后一段 envelope 外」检测对立标签，或要求对立标签也是 stdout 末段的合法闭合块才算数；至少补一条「output 正文里含 clarify 字面不应判 both」的回归测试。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

**[PORT-EXT-1] 加一个新 output kind（半年后场景：`json` / `path<json>` schema 校验、或 `table` kind）要碰 5+ 个并列文件，且 drift guard 只锁住其中 2 维** — 类型 extensibility
- 未来场景：产品想加 `path<json>`（带 JSON schema 校验）、或一个 `table` / `kv` data kind 供下游结构化消费。
- 根因：kind 的横切维度被切成 5 个互不强制对齐的注册表（见 PORT-04 证据）。`registry.ts` 的 boot guard 只交叉校验 `baseNames ↔ REGISTERED_BASE_KINDS`（`registry.ts:302`）与 `dataBearing ↔ carriesData`（`uiCatalog` 侧 + 测试），**不**强制新 kind 在 `shardingRegistry`（`keyOf`）或 review 准入（`isReviewableBodyKind`）维度被填——这两维要么靠默认 fallback 静默吞掉（`shardingRegistry.ts:63` 默认 0-based index），要么手写在 kindParser 里（PORT-04）。
- 现在加功能要碰：`kindParser.REGISTERED_BASE_KINDS`（若是 base）+ 文法（若是 param）→ 5 个 handler 维度方法 → `uiCatalog` 两表 + 两条 i18n label → `shardingRegistry` 注册（否则 fanout shardKey 静默用 index）→ `kindParser.isReviewableBodyKind`（若可 review）→ 各 cycle 红线注意 import 方向。
- 目标形态：单一「kind capability descriptor」表（见 §7），每个新 kind 在一个地方填全部维度（含 sharding keyOf、review 准入、download、dataBearing），`satisfies` 强制穷尽 + boot guard 交叉校验**所有**维度而非两维；cycle 问题用「descriptor 拆成纯数据 + handler 行为分层」而非「把真值散到 kindParser」解决。

**[PORT-EXT-2] 信封协议是裸正则，加任何「结构化端口」（嵌套、二进制、含分隔符的内容）都会撞上无转义层** — 类型 extensibility / design
- 未来场景：想支持端口正文含任意二进制/含 `</port>` 的内容、或一个端口里嵌结构化子块。
- 根因：`PORT_RE`/`ENVELOPE_RE` 是非贪婪正则，无转义/CDATA/分隔符协议（PORT-01/02/09 同根）。任何「正文可能含协议标签」的新端口形态都会静默截断。
- 现在加功能要碰：`envelope.ts` 的两条正则 + `prompt.ts` 协议块文案 + 全部 envelope 解析测试（且要把 `toContain` 断言升级成完整相等）。
- 目标形态：把 envelope 解析从「可嵌套 XML 误用」改成「显式分隔的容器」（端口边界靠下一个 `<port name=` 起点而非 `</port>` 匹配），并在协议块定义一个明确的转义/围栏规则；解析器对「容器外的对立标签」与「容器内正文」严格区分。

**[PORT-EXT-3] fanout 分片逻辑没走 kind handler，新 list 形态（如 `list<path<json>>` 自定义 shardKey、或内联多行 item）要在 scheduler 里再手写一段分割** — 类型 extensibility / coupling
- 未来场景：fanout over `list<markdown>`（已坏，PORT-06）、over 某 kind 但想自定义 shardKey 提取（slug 而非路径）、over 嵌套 list。
- 根因：fanout 分片在 `scheduler.ts:3120` 手写行分割，仅 shardKey 走 `resolveKeyOf`（`shardingRegistry`）；「如何把 wire content 切成 items」这一步**没有**问 list handler，而 list handler 自己已经知道内联 vs 行 item 的区别（`list.ts:50-83` 的 bullet/example 分流）。这份知识在 handler 和 scheduler 里各存一份且后者残缺。
- 现在加功能要碰：`scheduler.ts` 的手写分割 + `shardingRegistry` + validator 的 shardSource 准入；handler 里的分流知识用不上。
- 目标形态：list handler 暴露 `splitItems(wireContent): {key, value}[]`（内部按 item kind 选 `splitListItems`/`splitMarkdownDocs` + `resolveKeyOf`），fanout 与 review 都调它——一处定义、两处复用，PORT-06/07 一并消失。

**[PORT-EXT-4] `node-kind-behavior` 表号称「单一事实源 + 编译期穷尽」，但 5 维里 4 维只是文档、runtime 仍是 kind-blind** — 类型 extensibility / design
- 未来场景：真要落「per-node time budget」「pin worktree until review done」等 per-kind 横切 hook。
- 根因：`node-kind-behavior.ts:18-22` 自承「Today only `retryCascade` is consulted at runtime…The other four dimensions document intended behavior…Their values can disagree with the current code paths (which are kind-blind) without breaking anything」。即表里写的 `limits`/`orphanReap`/`gc`/`shutdown` 与真实代码路径**允许不一致**——它是「该怎样」不是「实际怎样」。这削弱了「加 NodeKind 编译期强制对齐」的承诺：填了表不代表 runtime 真照做。
- 现在加功能要碰：实现 per-kind hook 时要逐个把 `limits.ts`/`orphans.ts`/`gc.ts`/`shutdown.ts` 改成 query 这张表——而它们今天各自硬编码 `status IN (...)` 过滤（`node-kind-behavior.ts:73-79` 注释自承 orphanReap 是「ENFORCED implicitly by orphans.ts querying only…」）。
- 目标形态：要么把这 4 维真接进对应 service（让表名副其实），要么明确把它们标为「Reserved / not-yet-wired」并从 `NodeKindBehavior` 接口移到一个单独的 `PlannedBehavior` 类型，别让「编译期穷尽」给人「填了就生效」的错觉。（注：这条偏 node-kind，与 LIFE/SCHED 子系统交叉，列此供交叉印证。）

---

## 5. 耦合 / 分层违规

**[PORT-10] cycle 红线（kindParser 不得 import registry）把「kind 能力」真值挤进 kindParser，造成抽象泄漏** — 级别 P2｜类型 coupling
- 证据：`isReviewableBodyKind` 实现在 `kindParser.ts:225`（零依赖层），handler 的 `isReviewableBody` 只是 `delegate 回它`（`markdown.ts:17`、`path.ts:71`）。原因明写在 `kindParser.ts:220-224`：`schemas/review.ts` 在 import 图里坐在 handler registry **下方**，不能 pull registry（会重建 RFC-079 `index→list→registry→list` init cycle 崩 `build:binary`，见 memory `reference_binary_build_module_cycle`）。所以「这个 kind 能不能 review」这条本属 handler 的能力被迫定义在 kindParser。
- 影响：`carriesData`/`bulletSuffix` 等能力在 handler，`isReviewableBody` 真值在 kindParser——同一类「kind 自报能力」的知识被 cycle 约束劈成两处，新人难判断该往哪加。这是架构 cost，不是 bug，但限制了 §4 目标形态的落地。
- 建议：把「纯数据 capability descriptor」（零依赖，可被 schemas/uiCatalog/kindParser 安全 import）与「行为 handler」（依赖 IO/registry）分层（§7），让 review 准入这类纯谓词从 descriptor 读，而非散在 kindParser。

**[PORT-11] `protocol.ts` 是空壳 re-export，但仍是 backend 的「官方入口」造成认知噪音** — 级别 P3｜类型 coupling
- 证据：`services/protocol.ts` 全文仅 re-export `shared` 的 `buildProtocolBlock`/`renderUserPrompt`（P-2-06 搬去 shared 让前端 preview 复用）。
- 影响：轻微。grep `services/protocol` 仍可能命中此 shim 而非真实现，增加定位成本。
- 建议：可保留（向后兼容）；或直接让调用方 import shared，删 shim。

---

## 6. 测试 / 可观测性缺口

**[PORT-12] envelope 嵌套标签测试用 `toContain` 掩盖截断（PORT-02 的元问题）** — 级别 P1｜类型 test-gap
- 证据：`envelope-parse-md-edge-cases.test.ts:133` 仅 `toContain`，对截断零断言。CLAUDE.md「Test-with-every-change」明令回归测试应「一眼识别锁的是哪类回归」——此测试标题说「md content can contain text that looks like <port>」，实际锁住的是一个**有缺陷**的行为且断言太弱。
- 建议：补一条完整内容相等断言（PORT-02 修复后），把这条测试从「确认能截断」翻成「确认不截断」。

**[PORT-13] fanout over `list<markdown>` / `list<signal>` / 自定义 shardKey 全无测试** — 级别 P2｜类型 test-gap
- 证据：grep `fanout.*list<markdown>` / `shardSource.*markdown` 在 `tests/` 零命中（PORT-06）；探针证明 `list<signal>` 可被 schema 接受但无任何拒绝测试（PORT-03）。
- 建议：补 fanout shardSource 的负向/边界用例：内联 markdown list、signal-item list、嵌套 list。

**[PORT-14] signal 非空内容丢弃 + 持久化不一致无任何可观测信号** — 级别 P2｜类型 observability / test-gap
- 证据：PORT-08。无 warn、无事件流、无测试断言「signal 端口写了内容会被告警」。
- 建议：接线 warn + 事件流后补测试。

---

## 7. 目标形态（Target architecture）

**核心思路：把今天散在 5 处的 kind 知识收敛成「两层」——纯数据 capability descriptor（零依赖）+ 行为 handler（依赖 IO），用一张 descriptor 表做 boot-time 全维度 drift guard。**

1. **`kindCapabilities.ts`（零依赖纯数据层）**：每个 kind 一条 descriptor，字段 = `{ matches, dataBearing, reviewable, downloadable, editorShape, label, splitItems?, keyOf? }`。`kindParser`/`schemas/review`/`uiCatalog` 都从这里读纯谓词（解决 PORT-10：`isReviewableBodyKind` 从 descriptor 派生，不再手写在 kindParser）。零依赖 ⇒ 不破 cycle 红线。
2. **`outputKindHandlers`（行为层）**：依赖 `ValidateIO`，持 `validate`/`buildPromptGuidance`/`buildRepairBlock`/`splitItems`。每个 handler 引用其 descriptor。
3. **单一 boot guard**：`satisfies` + 一处交叉校验**所有**维度（base-name、dataBearing、sharding keyOf、review 准入都强制新 kind 填满；不再「填了表 runtime 不照做」），消灭 PORT-04/EXT-1 的多表 drift。
4. **list/fanout 分片走 handler**：list handler 暴露 `splitItems(wireContent)`（内部分流 `splitListItems`/`splitMarkdownDocs` + `resolveKeyOf`），fanout 与 review 共用（解决 PORT-06/07/EXT-3）。
5. **信封解析改容器分隔语义 + 显式转义协议**（解决 PORT-01/02/09/EXT-2）：端口边界靠 `<port name=` 起点切，对立标签只在容器外检测。
6. **退役 legacy 注册表**：执行 RFC-060 PR-D（删 `HANDLERS`/`markdownFile.ts`/legacy `types.ts` 接口），单注册表（解决 PORT-05）。
7. **语义准入**：schema refine 调注册表的 `validAsListItem`/`validAsShardItem`（解决 PORT-03）。

走 RFC（这是非平凡重构 + 跨 cycle 红线，按 CLAUDE.md「RFC workflow」强制）。可命名 RFC-1xx「output-kind capability 单表收敛 + 信封容器化」。

---

## 8. Top 风险与建议优先级

| 排序 | ID | 标题 | 级别 | 类型 | 触发难度 |
|---|---|---|---|---|---|
| 1 | PORT-02 | 嵌套 `</port>` 静默截断（toContain 掩盖） | P1 | impl-bug | 中（agent 输出含协议标签的 md/code） |
| 2 | PORT-06 | fanout over `list<markdown>` 按行误分片 | P1 | impl-bug | 中（用内联 markdown list 作 shardSource） |
| 3 | PORT-01 | design 承诺 CDATA/转义但无实现，协议块不教转义 | P1 | design | 持续暴露面 |
| 4 | PORT-12 | envelope 嵌套测试 `toContain` 掩盖截断 | P1 | test-gap | — |
| 5 | PORT-05 | 双 handler 注册表并存，PR-D 删除承诺未兑现 | P2 | design/coupling | 持续维护税 |
| 6 | PORT-04/EXT-1 | kind 横切切成 5 表，drift guard 只锁 2 维 | P2 | extensibility | 每次加 kind |
| 7 | PORT-08/14 | signal 非空内容静默丢弃 + 持久化不一致 + 无 telemetry | P2 | observability | 低频但难诊断 |
| 8 | PORT-09 | detectEnvelopeKind 对正文含对立标签误判 both | P2 | impl-bug | 低（agent 复述 clarify 指令） |
| 9 | PORT-07/EXT-3 | fanout 手写行分割绕过 splitListItems codec | P2 | impl-bug/coupling | drift 隐患 |
| 10 | PORT-03 | `list<signal>` 等语义无效组合被 schema 接受 | P2 | design/extensibility | 低 |
| 11 | PORT-10 | cycle 红线把 review 准入真值挤进 kindParser | P2 | coupling | 架构 cost |
| 12 | PORT-EXT-4 | node-kind-behavior 4/5 维仅文档、runtime kind-blind | P2 | design | 落 per-kind hook 时 |
| 13 | PORT-11 | protocol.ts 空壳 shim | P3 | coupling | — |

**最该先动**：PORT-02 + PORT-06（两处静默数据/分片错误，均无真实测试保护）。两者修复都需要先承认「裸正则 + 手写分割」绕过了已有 codec/handler——正是本子系统作为「可扩展样板」最该补齐的最后一公里。
