# RFC-166 plan——任务分解与 PR 拆分

> 规模：中（agent schema 增字段 + 能力卡纯函数 + leader 接入 + 编辑器）。2 PR。
> 每 PR 独立过全量门禁（typecheck×3 / lint 0 / format / 后端全量 / 前端 vitest / binary smoke）。
> 改动即带测（无先实现后补测档）。前置于 RFC-167。

## PR-1 schema + 能力卡（后端/shared 库，纯叠加）

- **T1** shared：`AgentInputPortSchema`（name/kind/required?/description?）+ `AgentSchema.inputs`
  （default []）+ Create/Update schema 增 inputs；kind 走 kindParser 校验。测试：zod 正反例
  （合法端口 / 重名 / 非法 kind / 空默认）。
- **T2** migration A（journal +1）：`agents ADD inputs text NOT NULL DEFAULT '[]'`；drizzle schema
  同步。测试：迁移幂等 + agents 全字段锁 +1 + upgrade-rolling 计数锁 bump + 存量行 inputs=[]。
- **T3** backend agent service：CRUD 读写 inputs（DB 列）；agent.md frontmatter round-trip（照
  outputs）；kind 非法 422、端口名组内唯一。测试：round-trip、frontmatter 双向、错误路径。
- **T4** shared `renderAgentCapabilityCard` + `renderRosterCapabilityCards` 纯函数：description/
  inputs/outputs（kind 合成）/role/prompt 摘要（预算裁剪）。测试：逐字段矩阵、空端口、
  promptBudget=0、长 prompt 截断。
- **T5** PR-1 门禁 + Codex 增量审查。

## PR-2 leader 接入 + 编辑器 + 预览（补强 RFC-164 + 前端）

- **T6** leader 花名册接入能力卡：`workgroupContext.renderRosterBlock` 加能力卡（agent 成员）；
  `workgroupRunner` composeLeaderPrompt/composeMemberPrompt 预载成员 agent map + 渲染卡；human
  成员无卡。测试：花名册含成员 description/outputs；roleDesc 叠加保留；**prompt 隔离双层锁**
  （能力卡无 user_id，扩 rfc099-prompt-isolation）；工作组既有测试全绿（roleDesc 仍在）。
- **T7** 前端 agent 编辑器 inputs 端口区（复用 outputs 端口行组件对称形态）+ 前端预校验。
  测试：增删端口 / 唯一性 / kind 校验 / 保存 body 含 inputs。
- **T8** 前端 `AgentCapabilityCard.tsx` 公共组件 + 工作组建组成员选择处能力预览。测试：渲染
  各字段 / 空态 / role 断言。
- **T9** i18n 双语 + 视觉自查（复用公共组件/样式）。
- **T10** PR-2 门禁 + Codex 增量审查 + 全 AC 对照。

## 依赖 & 验收对照

| AC | PR |
| --- | --- |
| AC-1 schema | PR-1/T1 |
| AC-2 能力卡纯函数 | PR-1/T4 |
| AC-3 leader 接入 + prompt 隔离 | PR-2/T6 |
| AC-4 编辑器 + 预览 | PR-2/T7-8 |
| AC-5 迁移 | PR-1/T2 |
| AC-6 门禁 | 每 PR |
| AC-7 零回归 | 每 PR（validator/CRUD/工作组 roleDesc 锁） |

## 风险

- **leader 花名册注入 token 膨胀**：能力卡含 prompt 摘要，多成员时膨胀——用小 promptBudget
  + 可关（promptBudget=0）。
- **workgroupContext 花名册渲染改异步**（要载 agent）：现 renderRosterBlock 是纯函数；改为
  「引擎预载 agent map + 传入」保持纯函数可测（不在渲染器里 DB 查）。
- **迁移撞 journal 计数锁 + agents 全字段锁**：按 [reference_migration_bumps_journal_count_test]
  同步 bump。
- 写完测试必重跑 typecheck（bun test 不做 tsc）；push 后查 CI。
