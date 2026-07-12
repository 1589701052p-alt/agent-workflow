# RFC-151 · 五资源页骨架 + dedup RFC-F 扩大版（proposal）

- **状态**：Draft（G3-G10 批量授权第 7 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §5.3（RFC-G9）+ `design/dedup-audit-2026-06-13.md`
  §4.7（RFC-F）
- **前期调研**：单路全景（基准 origin/main@RFC-150 后）。**两处前提更正**：
  ①`ResourceList.tsx` **已删除**（flag-audit §8 决策点④落地）——「去留裁决」作废，
  `.data-table`（11 路由）即事实标准与抽取基线；②Segmented/TabBar 原语已由 RFC-150
  落地（skills.new 已迁 TabBar），McpFields 的 chip-radio 是 RFC-150 采用集的直接欠账。

## 1. 背景

1. **五列表页逐点同构**（agents/skills/mcps/plugins/workflows）：visibility chip +
   owner 徽标 + useUserLookup（五页逐字同一行）+ Loading/Error/Empty 三连 + del
   mutation——五要素计数全等；其余 5 个 data-table 路由（tasks/reviews/users/repos/
   clarify）无 owner/visibility 语义、**不得强并**（伪抽象警戒）。
2. **detail 页四份骨架**：AclDialogButton+Save+ConfirmButton header cluster 逐点同构 +
   `loaded` hydrate-once 布尔 ×4（skills 双 query/三 mutation 是硬边界）+
   MemoryEditDialog 第 5 变体自带 stale-race 急写（RQ 后台刷新竞态，
   :107-139 注释——抽取必须吸收不得简化）。
3. **Picker 四份逐字 ~60/75 行重复**（Skills/Mcps/Plugins/AgentDepends——单发 Select
   叠 ChipsInput 形态；差异仅 filter 谓词/testid/label 拼装/selfName）；UserPicker 是
   异步搜索 combobox **另一形态，不并**。
4. **新建 vs 编辑三 idiom 并存**：nameLocked 布尔（3 组件×3 detail 调用点全传字面量）、
   memory 双 Dialog fork（三 helper byte-identical）、OidcProviderDialog mode 7 分支
   （「测试连接」按钮隐藏 + mutation throw 双重编码）。
5. **快赢族**：McpFields 两处原生 radio chip-row（违反 CLAUDE.md 统一风格）、
   ~28 处 inline common.loading 绕过 LoadingState、form-invalid sentinel ×4、
   FuseDialog 双 undefined-prop 隐式模式、AgentImportDialog yaml-parse-failed 前缀
   协议、skills.detail isManaged ×7、OutputsEditor 重写 ChipsInput 键盘逻辑。

## 2. 目标（4 commit）

1. **PR-1 快赢批**：McpFields → `<Segmented>`（补进 RFC-150 采用集）；form-invalid
   sentinel → buildPayload 判别联合结果 mutate 前分支；skills.detail →
   `skillCapabilities(sourceKind)` 能力对象；AgentImportDialog warnings 升级
   `{code, blocking}[]`；FuseDialog → `entry: {kind:'from-skill'}|{kind:'from-memories'}`；
   OutputsEditor 复用 ChipsInput 键盘/去重逻辑；inline common.loading 收敛
   LoadingState（+新增禁令 grep）；dedup/flag-audit 文档里 ResourceList 过时行修正。
2. **PR-2 Picker 配置化**：`ResourcePicker<T>`（queryKey/endpoint/filter/labelFn/
   testid 配置）收敛四份；UserPicker 显式非目标。
3. **PR-3 列表壳**：`useResourceList()`（query+del+invalidate+owners）+
   `<ResourceNameCell>`（name link + private chip + owner 徽标）收敛五资源页；
   data-table-callsite 与两处 cell-wrapping 源码锁随迁为共享组件断言。
4. **PR-4 detail 壳 + idiom**：`DetailHeaderActions`（Acl+Save+Del cluster；skills 以
   组合 props 适配双 mutation 不强塞）+ `useDraftFromQuery()`（hydrate-once 单源，
   吸收 MemoryEditDialog stale-race 急写语义）+ nameLocked 三调用点随壳消解 +
   memory 双 Dialog 收敛共享壳 + OidcProviderDialog submit 策略对象
   （测试连接单点编码）。

## 3. 非目标

- 其余 5 个 data-table 路由不入列表壳（无 owner/visibility——伪抽象警戒）。
- UserPicker（异步搜索 combobox 形态）不并入 ResourcePicker。
- `<DetailLayout>`（既有原语、仅 1 消费者）全量采用另议——本 RFC 的
  DetailHeaderActions 是 header cluster 层，不与其混淆。
- skills.detail 自定义 describeError 漂移随 PR-4 顺带对齐 describeApiError，
  但错误渲染全量收敛（dedup RFC-E）不入本 RFC。
- agents.new 的 snapshottedRef seed-once（config 默认值语义，非实体 hydration）不动。

## 4. 验收标准

1. 快赢族全落（8 项）+ inline-loading 禁令 grep；McpFields 进 Segmented 采用集。
2. ResourcePicker 收敛四份（行为测试零改动）；五页列表壳 + 四页 detail 壳收敛
   （渲染/行为锁零改动，3 处源码锁随迁）。
3. stale-race 急写语义保留（MemoryEditDialog 测试零改动）；skills 双 mutation
   形态保留。
4. 三 idiom 收敛为 mode/策略对象；OIDC 测试连接单点编码。
5. 门禁 + CI conclusion=success + Codex 双门收敛。
