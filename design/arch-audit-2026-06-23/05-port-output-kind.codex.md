# Codex 核验：端口 / 输出 kind 注册表 / 信封 (05-port-output-kind)

> 对应报告：`design/arch-audit-2026-06-23/05-port-output-kind.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **PORT-01 / PORT-02 属实，P1 合理**：design 承诺“任意文本内容（保留 CDATA / 转义）”，但实现只有非贪婪正则，无 CDATA/转义处理；prompt 也只输出裸 `<port>...</port>` 示例。证据：`design/proposal.md:436-440`、`packages/backend/src/services/envelope.ts:139-143`、`packages/shared/src/prompt.ts:588-598`。测试确实只 `toContain`，未断言完整内容，掩盖截断：`packages/backend/tests/envelope-parse-md-edge-cases.test.ts:133-148`。

- **PORT-03 属实，P2 合理**：`list<signal>` 被 schema 明确接受，fanout validator 只检查 `parsed.kind === 'list'`，没有 data-bearing 语义准入。证据：`packages/shared/src/kindParser.ts:178-192`、`packages/shared/tests/agent-output-kind-upgrade.test.ts:77-79`、`packages/backend/src/services/workflow.validator.ts:195-222`。

- **PORT-04 / PORT-10 基本属实，P2 合理**：kind 能力分散在 handler registry、UI catalog、sharding registry、`kindParser.isReviewableBodyKind` 等处；reviewability 真值确实在零依赖 `kindParser`，handler 只能间接对齐。证据：`packages/shared/src/outputKinds/registry.ts:53-115`、`packages/shared/src/outputKinds/uiCatalog.ts:43-72`、`packages/shared/src/shardingRegistry.ts:56-64`、`packages/shared/src/kindParser.ts:212-229`。

- **PORT-05 属实，但偏维护债，P2 可接受**：legacy `HANDLERS` / `markdownFile.ts` 仍存在，注释也承认 PR-D 应删除；`rg` 未见生产运行时调用 legacy helper。证据：`packages/shared/src/outputKinds/registry.ts:11-19`、`packages/shared/src/outputKinds/index.ts:21-118`、`packages/shared/src/outputKinds/markdownFile.ts:1-129`。

- **PORT-06 / PORT-07 属实，P1/P2 合理**：fanout 对 shardSource 直接 `rawContent.split('\n')`，没有用 `splitMarkdownDocs`；而 `list<markdown>` 的 wire contract 是 boundary 分隔的多行文档。证据：`packages/backend/src/services/scheduler.ts:3128-3132`、`packages/shared/src/listWire.ts:41-73`、`packages/backend/src/services/review.ts:434-445`。

- **PORT-08 属实，P2 合理**：signal handler 把非空内容归一化为空，但 runner 只调用 `resolvePortContent` 验证，随后持久化原始 `content`，没有 warning/telemetry。证据：`packages/shared/src/outputKinds/signal.ts:51-64`、`packages/backend/src/services/envelope.ts:344-352`、`packages/backend/src/services/runner.ts:1167-1208`。

- **PORT-09 属实，但严重级可降为 P3/P2 边界**：`detectEnvelopeKind` 全 stdout 扫 output/clarify，正文内示例标签会触发 `both`；但“同一回复不得同时出现两种 envelope”是 RFC-023 的硬约束，所以问题是“正文误报”，不是互斥规则本身错误。证据：`packages/backend/src/services/envelope.ts:201-223`、`packages/shared/src/prompt.ts:641-665`。

- **PORT-12 / PORT-13 / PORT-14 测试缺口属实**：对应行为确实缺完整相等断言、fanout `list<markdown>` 覆盖、signal warning 覆盖。证据同上。

## REFUTED / 伪问题（给反证 file:line）

- **PORT-11 基本是伪问题 / 可忽略**：`protocol.ts` 明确是 backwards-compatible re-export，用来保留旧入口；这类 shim 有轻微认知成本，但不构成架构缺陷。反证：`packages/backend/src/services/protocol.ts:1-9`。

- **PORT-EXT-4 超出本报告主题**：`node-kind-behavior` 的“4/5 维仅文档”描述属实，但这是 node kind 生命周期子系统，不是端口 / output kind / envelope 子系统的主要问题；放在本报告 Top 风险会稀释优先级。证据：`packages/shared/src/node-kind-behavior.ts:15-21`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **`path` / `markdown_file` 可经 worktree 内 symlink 读取 worktree 外文件 — High — `packages/backend/src/services/envelope.ts:122-132`, `packages/backend/tests/envelope-parse-md-edge-cases.test.ts:83-99` — `ResolvePortContentOptions` 注释声称 symlink landing outside 会 raise ValidationError，但实际只做 lexical containment，测试还锁定读出 `TOP SECRET`。这是端口文件读取面的真实安全缺口，且与 `worktreeFiles` 服务的 realpath 防护不一致。**

- **`list<markdown>` handler 验证/归一化仍按行切分 — Medium — `packages/shared/src/outputKinds/list.ts:134-177`, `packages/shared/src/listWire.ts:49-73` — prompt/listWire 定义的是 boundary 分隔多文档，但 handler 对所有 list 一律 `splitListItems`。runner 当前丢弃归一化结果降低了爆炸面，但任何直接使用 `resolvePortContentDetailed('list<markdown>')` 的路径会得到被去空行、按行重组的 body。**

- **UI guided mode 会直接制造 `list<signal>` — Low/Medium — `packages/frontend/src/components/KindSelect.tsx:54-57`, `packages/frontend/src/components/KindSelect.tsx:70-76`, `packages/frontend/src/components/KindSelect.tsx:152-155` — 报告指出 schema 接受 `list<signal>`，但漏掉前端并非只能 advanced 手输：signal 是 guided leaf，list switch 可包任何 leaf，用户可在正常 UI 中创建语义无效组合。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的方向总体正确，但“单一 capability descriptor 表”不宜一次性大重构落地。更优路径是先修两个数据正确性 bug：envelope 分段/转义与 fanout kind-aware split；再加最小语义准入接口，例如 `validAsListItem` / `validAsShardSource`，阻断 `list<signal>`。

descriptor 分层可以做，但要保持零依赖纯数据层，不要把 IO handler、UI label、sharding key、review 准入全塞成一个巨表；否则会把现在的 cycle 风险换成更大的初始化/打包风险。UI label/download 这类前端维度可保留独立表，但必须有 boot/test guard 覆盖 sharding、review、dataBearing 等关键语义。

对既有不变量：这些建议不需要碰 RFC-097 状态机 CAS，修 scheduler 时继续通过 `markWrapperTerminal` / lifecycle helper 写状态即可；不应把 RFC-099 的 owner/成员信息引入 prompt 或 kind descriptor；也不应改 opencode `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` 的 env 合并路径。报告没有明显提出会破坏这些不变量的方案，但应在 RFC 中写成非目标。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：报告抓住了裸正则信封、fanout 非 kind-aware split、legacy registry、signal 归一化丢失等核心问题；主要不足是漏掉 symlink 越界读取这个更安全相关的问题，并把少数低价值 shim / 跨子系统债务放进了同一优先级叙事。
