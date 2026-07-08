# RFC-151 · 五资源页骨架 + dedup RFC-F 扩大版（plan）

> 4 commit，低风险→骨架级顺序（调研 §8.2）。授权语境：G3-G10 批量授权。

## RFC-151-T1 快赢批（PR-1）

- McpFields→Segmented、form-invalid 判别化、skillCapabilities、AgentImportDialog
  warnings 结构化、FuseDialog entry 联合、OutputsEditor 复用 ChipsInput、
  inline-loading 收敛+禁令、审计文档 ResourceList 行修正。
- **commit**：`refactor(frontend): RFC-151 PR-1 快赢批——sentinel/能力对象/判别联合/Segmented 采用`

## RFC-151-T2 ResourcePicker（PR-2）

- `ResourcePicker<T>` + 四薄包装（导出名/QUERY_KEY 兼容）；行为测试零改动。
- **commit**：`refactor(frontend): RFC-151 PR-2 ResourcePicker 配置化——四 picker 收敛`

## RFC-151-T3 列表壳（PR-3）

- useResourceList + ResourceNameCell 收敛五页；3 源码锁随迁。
- **commit**：`refactor(frontend): RFC-151 PR-3 五资源列表壳收敛`

## RFC-151-T4 detail 壳 + 局部 idiom（PR-4）

- DetailHeaderActions（skills 组合式）+ useDraftFromQuery（D3 契约）+
  MemoryDialogShell + OIDC 测试连接单点化；nameLocked 遗留登记。
- **commit**：`refactor(frontend): RFC-151 PR-4 detail 壳 + memory/OIDC 局部 idiom 收敛`

## 门禁节奏

每 commit：typecheck×3 + lint + format + 前端全量；T4 后 binary smoke → push →
CI conclusion 直查 → Codex 实现门循环至收敛。

## 验收清单

- [ ] 快赢 8 项 + 禁令 grep；picker 四收敛零改动
- [ ] 五页列表壳 + 四页 detail 壳；3 源码锁随迁；stale-race/skills 边界保留
- [ ] memory 壳 + OIDC 单点化；nameLocked/useResourceFormPage 遗留登记
- [ ] 门禁 + CI + Codex 双门
