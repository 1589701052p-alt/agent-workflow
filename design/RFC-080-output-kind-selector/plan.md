# RFC-080 — 任务分解

3 PR 强序：**PR-A（后端运行时迁移，安全前提）→ PR-B（KindSelect + 两面）→
PR-C（e2e + 收尾）**。PR-A 必须先 push CI 全绿，才能进 PR-B（见 design §5 F1）。

## PR-A — 运行时迁移到 parametric 注册表

| 子任务     | 说明                                                                                                                                                                                                  | 依赖     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| RFC-080-T1 | 新增 `groupPortsByParsedKind` + `composePerParsedKindRepairBlocks`（shared `outputKinds/`），按命中的 parametric handler 分桶（key=displayName，首现序），未声明 kind 默认 base string                | —        |
| RFC-080-T2 | `prompt.ts buildProtocolBlock`：`renderPerKindGuidance` 改用 T1；per-port bullet/example 的 `=== 'markdown_file'` 改 `tryParseKind(...).kind==='path'` 通用 path 文案（D1）                           | T1       |
| RFC-080-T3 | `envelope.ts resolvePortContentDetailed`：`getOutputKindHandler` → `getHandlerForParsedKind(parseKind(kind))`，ctx.kind 换 ParsedKind；errCode namespace 改 displayName（D2）                         | —        |
| RFC-080-T4 | `runner.ts` repair：`composePerKindRepairBlocks` → T1 的 parsed 版；`KindFailure` → `ParametricKindFailure` 适配                                                                                      | T1       |
| RFC-080-T5 | grep 决策遗留 Record 去留（design §2.5）：零引用则删 `HANDLERS`/`getOutputKindHandler`/`groupPortsByKind`/`composePerKindRepairBlocks` + 3 legacy handler；否则保留 + 注释。无论如何加源码 grep 守卫  | T2,T3,T4 |
| RFC-080-T6 | PR-A 测试（design §6）：buildProtocolBlock 8-kind 不抛 + guidance 断言；string/markdown 字节快照、markdown_file 文案更新快照；resolvePortContentDetailed 各 kind happy/fail + errCode 形态；grep 守卫 | T2-T5    |

**PR-A 验收清单**

- [ ] 声明 `path<md>` / `path<json>` / `list<string>` / `list<path<md>>` / `signal`
      输出的 agent，`buildProtocolBlock` 不抛且产出正确 guidance。
- [ ] `resolvePortContentDetailed` 对上述 kind 正确校验，errCode =
      `port-validation-<displayName>-<sub>`。
- [ ] string / markdown 协议块字节一致；markdown_file 校验行为字节一致。
- [ ] grep 守卫：`prompt.ts`/`envelope.ts`/`runner.ts` 无 `getOutputKindHandler(`/
      `groupPortsByKind(`。
- [ ] `typecheck && test && format:check` 全绿；`build:binary` smoke 绿；push 后查
      CI（feedback_post_commit_ci_check）。

### PR-A 防漏适配补充（design §7.1 / §7.3 / §7.4）

- **RFC-080-T2a**：`DEFAULT_OUTPUT_KIND` 常量 + `defaultParsedKind()` 具名导出，替
  `outputKinds/index.ts:63`、`prompt.ts` 默认、`wrapperFanout.ts:121` 的内联
  `'string'`。（依赖 T1）
- **RFC-080-T3a**：`formatPortValidationErrCode(handler, subReason)` 具名 helper，替
  `envelope.ts:331` 内联模板（D2 displayName）。（依赖 T3）
- **RFC-080-T4a**：`ParametricOutputKindHandler`（`registry.ts:43`）加**非 optional**
  `carriesData()` / `bulletSuffix(port)` / `examplePlaceholder(port)` / `baseNames`，
  5 个 parametric handler 全填默认实现（**drift-guard 层 1**：漏实现即 typecheck 红）；
  `signalPromptGuard.ts:57` 改用 `carriesData`；`isReviewableBody()` 也作为非
  optional 占位（默认实现，语义留 RFC-081）。（依赖 T2/T4）
- **RFC-080-T5a**：模块加载期 assert（挂 `outputKinds/index.ts:126` / `registry.ts:112`
  旁）：`REGISTERED_BASE_KINDS` == 各 handler `baseNames` 并集且每名 1:1 命中
  （**drift-guard 层 3a**；红线：`kindParser.ts` 不 import 注册表，**反向**交叉校验）。
  （依赖 T4a/T5）
- T6 追加 AC-7「红」测试：删一个 handler 能力方法 / base 名失配 → typecheck 或加载期失败。

**PR-A 补充验收**

- [ ] `DEFAULT_OUTPUT_KIND` / `formatPortValidationErrCode` 为具名导出，grep 确认旧内联
      字面消除。
- [ ] handler 能力方法非 optional；删一个 → `bun run typecheck` 红（测试锁）。
- [ ] base 名交叉校验 assert 生效；`build:binary` smoke 绿（红线自查：无新初始化环）。

## PR-B — 公共 `KindSelect` 原语 + 改两面

| 子任务      | 说明                                                                                                                                                                                                                                       | 依赖    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| RFC-080-T7  | 新增 `components/KindSelect.tsx`（design §3.1-3.2）：Select+TextInput+Switch 组合、guided↔advanced、`tryParseKind`/`isRegisteredKindString`/`stringifyKind` 驱动、`testidPrefix`                                                           | PR-A 绿 |
| RFC-080-T8  | i18n key cn/en 对称（`kindSelect.*`）；`.kind-select*` 样式命名空间                                                                                                                                                                        | T7      |
| RFC-080-T9  | `OutputsEditor` 接线：删 `<select>`+`KIND_OPTIONS`，换 `<KindSelect>`；保留 setKind 的 string→删 map 逻辑                                                                                                                                  | T7      |
| RFC-080-T10 | `NodeInspector` fanout 接线：删裸 kind `<TextInput>` 换 `<KindSelect>`；保留 shardSource-must-be-list 告警                                                                                                                                 | T7      |
| RFC-080-T11 | PR-B 测试（design §6）：KindSelect 单测（8-kind round-trip / guided 重组 / advanced 退路 / ext 校验 / signal hint）；OutputsEditor + NodeInspector 集成；两处源码 grep 守卫（不落 `<select>`/裸 kind `<TextInput>`、均 import KindSelect） | T7-T10  |

**PR-B 验收清单**

- [ ] 表单可选并保存 AC-1 全部 8 个 kind 并 round-trip 显示。
- [ ] `markdown_file` 历史值读入显示 path(.md)，再存为 `path<md>`。
- [ ] KindSelect 单测用 `getByRole('combobox')`/`getByRole('switch')` 断言。
- [ ] 两面均经 KindSelect；源码守卫绿。
- [ ] `typecheck && test && format:check` 全绿；push 后查 CI。

### PR-B 防漏适配补充（design §7.2 / §7.3 / §7.4）

- **RFC-080-T7a**：新增 `packages/shared/src/outputKinds/uiCatalog.ts`，
  `OUTPUT_KIND_UI = [...] as const satisfies readonly OutputKindUiDescriptor[]`
  （value / labelKey / editorShape / downloadable / dataBearing / canvasClass），
  - `listSelectableKinds()`（**drift-guard 层 2**：照搬 `node-kind-behavior.ts` 的
    `satisfies` 穷尽性；扁平低依赖文件，红线见 §7.4）。（依赖 PR-A 绿）
- **RFC-080-T8a**：`KindSelect` base 下拉、`outputKind_*` 中英标签、TS Resources
  接口（`zh-CN.ts:1227`）、`TaskOutputPanel.tsx:136` 下载按钮、`output-port.ts:15`
  `isFileOutputKind` 全从 `OUTPUT_KIND_UI` 派生（不再硬编码 `KIND_OPTIONS` / 平铺
  i18n key）。（依赖 T7a/T8）
- **RFC-080-T10a**：`WrapperNodes.tsx:191/247` 的 signal 端口 chrome 从端口 parsed
  kind 的 `canvasClass` 派生（把 per-port kind 串进 `CanvasNodeData.outputPortKinds`），
  替硬判端口名 `'__done__'`。（依赖 T7a）
- **RFC-080-T11a**：模块加载期 assert：每个 `OUTPUT_KIND_UI.labelKey` 中英两 locale
  都解析（**drift-guard 层 3b**）；drift「红」测试 4 条（删 handler 方法 / `OUTPUT_KIND_UI`
  缺维度 / base 名失配 / 缺一个 locale label）。（依赖 T7a-T10a）

**PR-B 补充验收**

- [ ] `KindSelect` 选项 + 中英标签 + 下载按钮 + canvas signal 样式四处全从
      `OUTPUT_KIND_UI` 派生（源码守卫：无硬编码 kind 列表 / 字面 `'__done__'`）。
- [ ] AC-7 四条 drift「红」测试全部按预期失败→修复后转绿。
- [ ] `build:binary` smoke 绿（新增 shared 枚举模块不触发初始化环）。

## PR-C — e2e + STATE/plan 收尾

| 子任务      | 说明                                                                                            | 依赖    |
| ----------- | ----------------------------------------------------------------------------------------------- | ------- |
| RFC-080-T12 | Playwright：`/agents/new` 用 KindSelect 设 `list<path<md>>` → 保存 → reload → 断言持久          | PR-B 绿 |
| RFC-080-T13 | `STATE.md` 顶部「进行中」行改 Done + 已完成表追加；`design/plan.md` RFC 索引 RFC-080 Draft→Done | T12     |

**PR-C 验收清单**

- [ ] e2e 1 spec 绿（CI Playwright job）。
- [ ] STATE.md / plan.md 同步。
- [ ] 全 CI（typecheck/test/format + binary smoke + e2e）绿。

## 测试规模预估

backend/shared ≥ 18（8-kind prompt + 校验各 kind + errCode + grep + 回归快照）；
frontend ≥ 14（KindSelect 单测 8+ / OutputsEditor / NodeInspector / 源码守卫）；
e2e 1 spec。与 RFC-049 / RFC-060 / RFC-079 既有套件零回归。
