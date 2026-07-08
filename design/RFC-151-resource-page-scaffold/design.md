# RFC-151 · 五资源页骨架 + dedup RFC-F 扩大版（design）

> 现场行号以调研全景（origin/main@1d7f469c 基准）为准，原文录于调研输出。

## 1. PR-1 快赢批接线

| 项                            | 现场                                                                           | 改法                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| McpFields chip-radio ×2       | McpFields.tsx:43-62（type local/remote）/:119-138（oauthMode）                 | `<Segmented>`（value/options/ariaLabel；nameLocked 场景 disabled 透传）；segmented 采用锁补入                                                                                               |
| form-invalid sentinel ×4+1    | mcps.detail:51/mcps.new:36/plugins.detail:62/plugins.new:34 + mcps.new:68 消费 | buildCreatePayload/buildUpdatePayload 返回判别联合 `{ok:true,payload}                                                                                                                       | {ok:false}`，mutate 前分支；throw+message 比对删除                          |
| skills.detail isManaged ×7    | :53/:101/:116/:144/:152/:161/:164                                              | `skillCapabilities(sourceKind): {canFuse,canEditContent,canBrowseFiles,...}` 能力对象（lib/skill-capabilities.ts），7 处改读能力位                                                          |
| AgentImportDialog 前缀协议    | :63/:217/:231 `yaml-parse-failed:` startsWith                                  | warnings 升级 `{code:string, message:string, blocking:boolean}[]`（后端 API 若返回 string[] 则前端解析层归一——查 wire 后定：wire 不动则前端 lift；wire 可改则双端同步，倾向前端 lift 保守） |
| FuseDialog 隐式模式           | :29-30 双 undefined-prop；:59/:70/:138/:155 四消费                             | `entry: {kind:'from-skill'; skillName:string}                                                                                                                                               | {kind:'from-memories'; memoryIds:string[]}` 判别联合 prop；两调用点显式构造 |
| OutputsEditor 重写 ChipsInput | :32-55 键盘/去重/校验                                                          | 复用 ChipsInput（validate prop 承载 pattern 校验；溢出样式测试零改动为判据）                                                                                                                |
| inline common.loading ~28 处  | 25 文件                                                                        | 分层收敛：三态壳（isLoading→<LoadingState>）机械替换；语义特殊处（按钮内 loading 文案等）保留并注释豁免；新增 grep 禁令（豁免清单显式）                                                     |
| 文档修正                      | dedup-audit §4.7 / flag-audit §5.3 的 ResourceList 行                          | 标注「已删除（§8 决策④），.data-table 为事实标准」                                                                                                                                          |

## 2. PR-2 ResourcePicker<T>

```ts
interface ResourcePickerProps<T> {
  value: string[]
  onChange: (next: string[]) => void
  queryKey: readonly unknown[]
  endpoint: string
  labelFn: (item: T) => string
  filter?: (item: T, existing: ReadonlySet<string>) => boolean // 缺省 !existing.has(name)
  nameOf?: (item: T) => string
  placeholder?: string
  testid?: string
}
```

- 四份薄包装保留原导出名与 \*\_QUERY_KEY（调用面零改动）：SkillsPicker/McpsPicker
  （testid）/PluginsPicker（enabled 过滤+version label）/AgentDependsPicker（selfName
  过滤）。picker 行为测试零改动为判据。

## 3. PR-3 列表壳

- `useResourceList<T>({queryKey, endpoint, deleteBy: 'name'|'id'})` →
  {data,isLoading,error,del,owners}（useUserLookup 内含）。
- `<ResourceNameCell to name visibility ownerUserId owners title?>`——五页名列 cell
  三件套单源（data-table\_\_nowrap/link/chip--tight/owner 徽标结构字节同构）。
- 页面特有列/操作（agents runtime 列、skills source 列+SourcesCard、mcps 展开行、
  plugins 双 mutation、workflows YAML import）**原位保留**——壳只收五要素。
- 源码锁随迁：data-table-callsite（断言重定向共享组件仍吐 .data-table）、
  agents/mcps-list-cell-wrapping（改锚 ResourceNameCell 源码或渲染断言）。

## 4. PR-4 detail 壳 + idiom

- `<DetailHeaderActions>`：props {acl:{resourceBaseUrl,invalidateKey}, save:{onClick,
  disabled,testid?}, del:{onConfirm,label}, extra?:ReactNode（skills Fuse 按钮）}；
  form-actions 错误块（save.error/del.error 双 span）并入。skills 双 mutation 以
  save.disabled 组合式传入（不强塞 hook——调研告警）。
- `useDraftFromQuery(query, map, opts?)`：hydrate-once 单源（loaded/setDraft/seed
  effect）；**stale-race 语义**：文档化「配套 mutation onSuccess 必须 setQueryData
  急写」的契约（hook 不吞 MemoryEditDialog 的 :127-135 急写——保留在调用点，hook
  docstring 指路）；skills 双源 seed（meta&&content）以 ready 谓词参数支持。
- nameLocked：三 detail 调用点保留传参（组件 prop 不删——form 组件的 mode 语义
  清晰），仅 docs 记录「idiom 统一到 mode 由后续 form-page hook 吸收」？——**拍板
  D4**：本 RFC 不建 useResourceFormPage（调研 PR-h 全量 idiom 统一收益/风险比
  不如骨架件；nameLocked 现状可读）。缩围：只做 memory 双 Dialog 壳收敛 +
  OidcProviderDialog 测试连接单点编码（submit/test 策略对象局部化），
  nameLocked 登记遗留。
- memory 双 Dialog：共享 `MemoryDialogShell`（Dialog 骨架+footer+三 query+
  三 ToOptions helper 单源），New/Edit 各留 submit 差异（create vs diff+急写）。

## 5. 决策记录

- **D1** 列表壳只覆盖 5 资源页（伪抽象警戒——调研 §8.3.2）。
- **D2** UserPicker 不并 ResourcePicker（异步搜索 combobox 另一形态）。
- **D3** stale-race 急写留在调用点、hook 文档化契约（吞进 hook 会隐藏
  「谁负责缓存一致性」）。
- **D4** useResourceFormPage/nameLocked 统一缩围为遗留（收益/风险比低于骨架件；
  OIDC 双重编码单点化与 memory 壳收敛保留）。
- **D5** AgentImportDialog warnings 升级采用前端 lift（wire 不动）除非实现期
  发现后端已有结构化码。

## 6. 测试策略

快赢族各带回归（sentinel 判别联合格/能力对象格/FuseDialog 两态渲染/OutputsEditor
行为零改动）；picker 行为测试零改动；列表/detail 壳以「渲染锁零改动 + 3 源码锁
随迁」为判据；inline-loading 禁令 grep（豁免清单显式）；stale-race 测试
（memory-edit-dialog）零改动。

## 7. 任务分解 → plan.md（4 commit）
