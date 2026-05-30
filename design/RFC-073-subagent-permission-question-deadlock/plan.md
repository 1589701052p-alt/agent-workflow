# RFC-073 opencode Subagent Permission / Question 交互死锁根治 — Plan（任务分解）

状态：**Done**

单 PR。改动集中在 `services/runner.ts` + 测试，无 migration / 前端 / schema 变更。

## 子任务

### 注入层
- **RFC-073-T1**：在 `services/runner.ts` 加模块常量 `AW_GLOBAL_PERMISSION = { '*': 'allow', question: 'deny' }`（注意字面量 key 顺序：`*` 在前、`question` 在后）；`buildInlineConfig` 返回类型加 `permission?: Record<string, unknown>`，构造末尾 `out.permission = AW_GLOBAL_PERMISSION`。（design §2.1 / §2.2）
- **RFC-073-T2**：`buildInlineAgentEntry` 守卫——注入 `agent.<name>.permission` 时清洗掉 `question` 键（若用户 agent 定义带 `question:"allow"`），记 warning，保证注入产物永不含 `question:"allow"`。（design §2.3）
- **RFC-073-T3**（可选，默认跳过）：`buildInlineAgentEntry` 额外注入 `tools: { question: false }` 作根 session 双保险（对 subagent 无效，仅锦上添花）。（design §2.5）

### 测试
- **RFC-073-T4**：单测——`buildInlineConfig` 返回顶层 `permission` 深度等于 `AW_GLOBAL_PERMISSION`；**顺序锁**：序列化后 `"question"` 下标 > `"*"` 下标（AC2）。
- **RFC-073-T5**：单测——`buildInlineAgentEntry` 对含 `question:"allow"` 的输入产出不含该键 + warning（AC3）。
- **RFC-073-T6**：clarify 回归——`parseClarifyEnvelopeBody` 既有用例绿；正交 grep guard（clarify 文件不引用 opencode question 工具）；既有 clarify / clarify-cross-agent 端到端流程在禁 question 配置下仍进 `awaiting_human`（AC5）。
- **RFC-073-T7**：集成死锁回归——越界 `bash` + 调 `question` 工具的 agent 子进程正常退出、非 `node-timeout`（AC4）；实跑不稳则按 design §4 降级并注明。

### 收尾
- **RFC-073-T8**：门禁全绿（`typecheck` + `test` + `format:check`）→ 单 PR commit（前缀 `feat(backend): RFC-073 ...`）→ push → 查 CI（按 [feedback_post_commit_ci_check]）→ 把本 RFC 三件套状态改 Done + `design/plan.md` RFC 索引状态改 Done + `STATE.md` 顶部「进行中 RFC」改完工。

## 依赖图（简）

```
T1 ──> T4
T2 ──> T5
T6（clarify 回归）── 独立
T7（死锁回归）──── 独立（依赖 T1+T2 已落）
T1,T2,T4,T5,T6,T7 全绿 ──> T8（收尾/PR/CI）
```

## 验收清单（对应 proposal AC）

- [ ] AC1：注入全局 `permission = {"*":"allow","question":"deny"}`（question 在 * 后）。
- [ ] AC2：单测锁注入形态 + 序列化顺序。
- [ ] AC3：单测锁「注入 agent.permission 不含 question:allow」。
- [ ] AC4：死锁回归（越界 bash + question 工具）子进程正常退出。
- [ ] AC5：clarify / clarify-cross-agent 反问回归绿。
- [ ] AC6：保留 `--dangerously-skip-permissions`。
- [ ] AC7：typecheck + test + format:check + CI + e2e 全绿。

## 估算

S（小）。核心改动约数十行（runner 常量 + 两处注入/清洗）+ 测试。1 PR。
