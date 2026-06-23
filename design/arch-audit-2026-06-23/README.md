# 全仓架构调研（2026-06-23）

> 触发：用户「充分调研本项目所有细节，找出设计和实现问题，确定最优架构目标与防扩展坍塌的重构方向；每个调研结果再交一个 Codex 审视」。
> 方法：17 路并行子系统深审（13 后端 + 4 前端，xhigh）→ 首席架构师综合 → 每份结果交独立 Codex（GPT-5，只读）对抗式核验。所有发现带 file:line，对抗式自检。

## 阅读顺序

1. **`00-SYNTHESIS.md`** —— 综合：7 大系统性根因、最优目标架构（north star）、20 条重构路线图（护栏优先）、12 条扩展性硬规则、风险矩阵。**先读这份。**
2. **`00-CODEX-CROSSCHECK.md`** —— Codex 交叉核验合并结论：确认了什么、推翻/降级了什么（别过度重构）、补漏了哪些新问题（多为更硬的安全/数据丢失）、对路线图的净影响。
3. 各子系统报告 `01`~`17`.md + 对应 `*.codex.md`（Codex 逐份核验原文）。

## 子系统索引

| key | 报告 | Codex |
|---|---|---|
| 01 任务/节点生命周期状态机 | `01-task-lifecycle.md` | `01-task-lifecycle.codex.md` |
| 02 调度器与派发前沿（scheduler 巨石） | `02-scheduler-dispatch.md` | `02-scheduler-dispatch.codex.md` |
| 03 Fan-out / wrapper 与分片 | `03-fanout-wrappers.md` | `03-fanout-wrappers.codex.md` |
| 04 工作流模型 / 校验 / YAML | `04-workflow-model.md` | `04-workflow-model.codex.md` |
| 05 端口 / 输出 kind 注册表 / 信封 | `05-port-output-kind.md` | `05-port-output-kind.codex.md` |
| 06 opencode 进程集成 / 捕获层 | `06-opencode-integration.md` | `06-opencode-integration.codex.md` |
| 07 Git / worktree / 仓库 | `07-git-worktree.md` | `07-git-worktree.codex.md` |
| 08 结构化 diff（多语言 / 调用图 / 影响） | `08-structural-diff.md` | `08-structural-diff.codex.md` |
| 09 反问 / 评审 / 协作 | `09-clarify-review-collab.md` | `09-clarify-review-collab.codex.md` |
| 10 资源 ACL / 认证 | `10-resource-acl-auth.md` | `10-resource-acl-auth.codex.md` |
| 11 记忆 / 蒸馏 / 融合 | `11-memory-fusion.md` | `11-memory-fusion.codex.md` |
| 12 Agent / Skill / MCP / Plugin 资源管理 | `12-agent-skill-mcp-plugin.md` | `12-agent-skill-mcp-plugin.codex.md` |
| 13 DB schema / 事务 / 守护进程 | `13-db-config-infra.md` | `13-db-config-infra.codex.md` |
| 14 前端：工作流画布编辑器 | `14-frontend-canvas-editor.md` | `14-frontend-canvas-editor.codex.md` |
| 15 前端：数据层 | `15-frontend-data-layer.md` | `15-frontend-data-layer.codex.md` |
| 16 前端：UI 设计系统 / 可抽取公共组件 | `16-frontend-ui-system.md` | `16-frontend-ui-system.codex.md` |
| 17 前端：路由页与业务组件 | `17-frontend-routes-features.md` | `17-frontend-routes-features.codex.md` |

## 既有审计（本次在其上延伸，未重复）

`../scheduler-audit-2026-06-10.md`（2 P0+9 P1+15 P2）、`../dedup-audit-2026-06-13.md`（68 项重复）、`../ux-audit.md`（RFC-035 前盘点）。

## 性质

调研产物，**不含代码改动**。任何非平凡重构按 `CLAUDE.md` 规则需先立 RFC 再实现。
